import {
  AgentToolResultSchema,
  type AgentToolRequest,
  type AgentToolResult,
  type CoachAgentEvent,
  type CoachAgentResult,
} from "@cs-coach/coach-agent/client";
import type {
  PlaybackCommand,
  TeachingToolCommandArgs,
  TeachingToolAckEvent,
} from "@cs-coach/contracts";
import {
  CoachAgentStage3HostAdapter,
  STAGE3_ACK_TIMEOUT_MS,
  type Stage3HostAdapterInput,
  type Stage3IdentityInput,
  type Stage3ToolContext,
} from "./coach-agent-stage3-host-adapter";

export type Stage3ControllerStatus =
  | "IDLE"
  | "STARTING"
  | "FOCUSING"
  | "RESUMING"
  | "COMPLETED"
  | "FAILED"
  | "CANCELLED"
  | "RECOVERY_REQUIRED";

export interface Stage3ControllerState {
  readonly status: Stage3ControllerStatus;
  readonly cueId?: string;
  readonly tool?: AgentToolRequest["tool"];
  readonly presentation?: TeachingToolCommandArgs;
  readonly error?: string;
}

export interface Stage3ControllerScheduler {
  setTimeout(callback: () => void, timeoutMs: number): unknown;
  clearTimeout(handle: unknown): void;
}

const defaultScheduler: Stage3ControllerScheduler = {
  setTimeout: (callback, timeoutMs) => globalThis.setTimeout(callback, timeoutMs),
  clearTimeout: (handle) => globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export interface Stage3ControllerOptions {
  readonly adapter?: CoachAgentStage3HostAdapter;
  readonly dispatch: (event: CoachAgentEvent) => Promise<CoachAgentResult>;
  readonly post: (command: PlaybackCommand) => void;
  /** A timeout may synthesize FAILED only while the iframe transport is still present. */
  readonly bridgeAvailable: () => boolean;
  /** Live session/cue/gate check, called immediately before every external effect. */
  readonly isLive: (input: Stage3HostAdapterInput) => boolean;
  readonly onState?: (state: Stage3ControllerState) => void;
  readonly scheduler?: Stage3ControllerScheduler;
}

interface PendingTool {
  readonly request: AgentToolRequest;
  readonly context: Stage3ToolContext;
  readonly input: Stage3HostAdapterInput;
  readonly token: number;
  readonly commandGeneration: number;
}

function shortError(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message.slice(0, 160) : fallback;
}

function failedResult(request: AgentToolRequest, limitation: string): AgentToolResult {
  return AgentToolResultSchema.parse({
    callId: request.callId,
    status: "FAILED",
    observation: { code: "UNAVAILABLE", completed: false },
    limitations: [limitation.slice(0, 200)],
  });
}

function isTerminal(result: CoachAgentResult): boolean {
  return result.status === "COMPLETED" || result.status === "CUE_COMPLETED";
}

export class CoachAgentStage3Controller {
  private readonly adapter: CoachAgentStage3HostAdapter;
  private readonly scheduler: Stage3ControllerScheduler;
  private readonly startedCueIds = new Set<string>();
  private pending: PendingTool | undefined;
  private activeInput: Stage3HostAdapterInput | undefined;
  private takeoverPromise: Promise<boolean> | undefined;
  private pendingResumeSequence: number | undefined;
  private lifecycleTail: Promise<void> = Promise.resolve();
  private readonly lifecyclePromises = new Map<string, Promise<CoachAgentResult | undefined>>();
  private timeoutHandle: unknown;
  private token = 0;
  private resumeSequence = 0;
  private state: Stage3ControllerState = { status: "IDLE" };

  constructor(private readonly options: Stage3ControllerOptions) {
    this.adapter = options.adapter ?? new CoachAgentStage3HostAdapter();
    this.scheduler = options.scheduler ?? defaultScheduler;
  }

  get currentState(): Stage3ControllerState { return this.state; }
  get busy(): boolean {
    return this.state.status === "STARTING" || this.state.status === "FOCUSING" || this.state.status === "RESUMING";
  }
  get hasPendingTool(): boolean { return this.pending !== undefined; }
  hasStartedCue(cueId: string): boolean { return this.startedCueIds.has(cueId); }

  private setState(state: Stage3ControllerState): void {
    this.state = state;
    this.options.onState?.(state);
  }

  private clearTimeout(): void {
    if (this.timeoutHandle === undefined) return;
    this.scheduler.clearTimeout(this.timeoutHandle);
    this.timeoutHandle = undefined;
  }

  private isCurrent(input: Stage3HostAdapterInput, token: number): boolean {
    return token === this.token && this.options.isLive(input) && this.adapter.isCurrent(input.generation);
  }

  private dispatchSerial(event: CoachAgentEvent): Promise<CoachAgentResult> {
    const next = this.lifecycleTail.then(() => this.options.dispatch(event));
    this.lifecycleTail = next.then(() => undefined, () => undefined);
    return next;
  }

  private identityInput(input: Stage3HostAdapterInput): Stage3IdentityInput {
    return {
      plan: input.plan,
      routeState: input.routeState,
      analysis: input.analysis,
      demoContentHash: input.demoContentHash,
      selectedPlayerId: input.selectedPlayerId,
      sessionId: input.sessionId,
      runId: input.runId,
    };
  }

  private observationMode(segment: Stage3IdentityInput["plan"]["segments"][number]): "SKIP" | "FREEZE" | "BRIEF" | "OBSERVE" | undefined {
    if (segment.mode === "SKIP") return segment.reason_code === "FREEZE_TIME" ? "FREEZE" : "SKIP";
    if (segment.mode === "BRIEF") return "BRIEF";
    if (segment.mode === "OBSERVE") return "OBSERVE";
    return undefined;
  }

  private dispatchLifecycle(event: CoachAgentEvent, eventId: string): Promise<CoachAgentResult | undefined> {
    const existing = this.lifecyclePromises.get(eventId);
    if (existing) return existing;
    const status = this.adapter.beginLifecycleEvent(eventId);
    if (status === "CONFIRMED") return Promise.resolve(undefined);
    const promise = this.dispatchSerial(event)
      .then((result) => {
        if (result.status === "DORMANT" || result.status === "USER_TAKEOVER" || result.status === "WAITING_TOOL") {
          this.adapter.releaseLifecycleEvent(eventId);
          return undefined;
        }
        this.adapter.confirmLifecycleEvent(eventId);
        return result;
      })
      .catch(() => {
        this.adapter.releaseLifecycleEvent(eventId);
        return undefined;
      })
      .finally(() => this.lifecyclePromises.delete(eventId));
    this.lifecyclePromises.set(eventId, promise);
    return promise;
  }

  private async queueObserversUntil(
    input: Stage3IdentityInput,
    targetIndex: number,
    includeTarget: boolean,
    phase: "PLAYING" | "SKIPPING" | "PAUSED_FOR_COACHING" | "REVEALING",
  ): Promise<boolean> {
    if (this.adapter.lifecycleDegraded) return false;
    const last = Math.max(this.adapter.lifecycleCursor, this.adapter.lifecycleQueueCursor);
    const endExclusive = includeTarget ? targetIndex + 1 : targetIndex;
    if (endExclusive <= last + 1) return true;
    this.adapter.reserveLifecycleCursor(endExclusive - 1);
    for (let index = last + 1; index < endExclusive; index += 1) {
      const segment = input.plan.segments[index];
      if (!segment) {
        this.adapter.markLifecycleDegraded();
        return false;
      }
      const mode = this.observationMode(segment);
      if (!mode) {
        // A preceding cue must have advanced the cursor through its START_CUE;
        // silently skipping it would make the next routeSegmentIndex invalid.
        if (segment.cue_ids.length > 0) this.adapter.markLifecycleDegraded();
        return false;
      }
      const eventId = `stage3-observe-${input.runId}-${index}-${mode}`.replace(/[^a-zA-Z0-9_-]+/g, "-").slice(0, 160);
      try {
        const event = this.adapter.createObserveSegmentEvent(input, segment.id, index, mode, mode === "SKIP" || mode === "FREEZE" ? "SKIPPING" : phase, eventId);
        const result = await this.dispatchLifecycle(event, eventId);
        if (this.adapter.lifecycleEventStatus(eventId) !== "CONFIRMED" && !result) {
          this.adapter.markLifecycleDegraded();
          this.adapter.resetLifecycleQueue();
          return false;
        }
      } catch {
        this.adapter.releaseLifecycleEvent(eventId);
        this.adapter.markLifecycleDegraded();
        this.adapter.resetLifecycleQueue();
        return false;
      }
      this.adapter.markLifecycleSynced(index);
    }
    return true;
  }

  private armTimeout(pending: PendingTool): void {
    this.clearTimeout();
    this.timeoutHandle = this.scheduler.setTimeout(() => {
      this.timeoutHandle = undefined;
      if (this.pending?.token !== pending.token || !this.isCurrent(pending.input, pending.token)) return;
      if (!this.options.bridgeAvailable()) {
        this.pending = undefined;
        this.adapter.cancel(pending.input.generation);
        this.setState({ status: "RECOVERY_REQUIRED", cueId: pending.input.cue.id, tool: pending.request.tool, error: "回放桥接未连接；恢复连接后可重新关闭这次工具等待。基础回放仍可继续。" });
        return;
      }
      // The iframe is still reachable, so close the checkpoint with a strict
      // FAILED result. The Graph may choose one registered alternative once.
      void this.resumeWithResult(pending, failedResult(pending.request, "教学画面未在限定时间内回应。"));
    }, STAGE3_ACK_TIMEOUT_MS);
  }

  private async resumeWithResult(pending: PendingTool, result: AgentToolResult): Promise<void> {
    if (this.pending?.token !== pending.token || !this.isCurrent(pending.input, pending.token)) return;
    this.clearTimeout();
    const eventId = `stage3-resume-${pending.input.cue.id}-${pending.commandGeneration}-${++this.resumeSequence}`.replace(/[^a-zA-Z0-9_-]+/g, "-").slice(0, 160);
    let event: CoachAgentEvent | undefined;
    try {
      event = this.adapter.createResumeEvent(pending.request, result, pending.context, eventId);
    } catch (error) {
      this.pending = undefined;
      this.setState({ status: "FAILED", cueId: pending.input.cue.id, tool: pending.request.tool, error: shortError(error, "工具结果校验失败；基础回放仍可继续。") });
      return;
    }
    if (!event) return;
    this.pending = undefined;
    this.setState({ status: "RESUMING", cueId: pending.input.cue.id, tool: pending.request.tool, presentation: this.state.presentation });
    try {
      const next = await this.dispatchSerial(event);
      if (!this.isCurrent(pending.input, pending.token)) return;
      await this.handleAgentResult(pending.input, pending.token, next);
    } catch (error) {
      if (tokenIsCurrent(this.token, pending.token)) {
        this.setState({ status: "FAILED", cueId: pending.input.cue.id, tool: pending.request.tool, error: shortError(error, "工具结果未能回到教练状态；基础回放仍可继续。") });
      }
    }
  }

  private async handleAgentResult(input: Stage3HostAdapterInput, token: number, result: CoachAgentResult): Promise<void> {
    if (!this.isCurrent(input, token)) return;
    if (isTerminal(result)) {
      const cueSegmentIndex = input.plan?.segments?.findIndex((segment) => segment.id === input.cue.segment_id) ?? -1;
      if (cueSegmentIndex >= 0) this.adapter.markLifecycleSynced(cueSegmentIndex);
      this.setState({ status: "COMPLETED", cueId: input.cue.id, presentation: this.state.presentation });
      return;
    }
    if (result.status !== "WAITING_TOOL" || !result.effects[0]) {
      this.setState({ status: "FAILED", cueId: input.cue.id, error: "教练工具未能完成当前 cue；基础回放仍可继续。" });
      return;
    }
    const request = result.effects[0];
    const context: Stage3ToolContext = {
      generation: input.generation,
      currentSessionPhase: "PAUSED_FOR_COACHING",
      outcomeGate: input.outcomeGate,
    };
    if (!this.options.isLive(input)) return;
    let command: PlaybackCommand | undefined;
    try {
      command = this.adapter.createTeachingToolCommand(request, context);
    } catch (error) {
      this.setState({ status: "FAILED", cueId: input.cue.id, tool: request.tool, error: shortError(error, "工具请求未通过 Host 校验；基础回放仍可继续。") });
      return;
    }
    // A replayed checkpoint with the same callId has already been posted by
    // this run ledger. Do not produce a second iframe side effect.
    if (!command) {
      const callStatus = this.adapter.callStatus(request);
      const recoveryPending: PendingTool = {
        request,
        context,
        input,
        token,
        commandGeneration: this.adapter.commandGenerationFor(request) ?? 0,
      };
      const finalResult = this.adapter.resultForCall(request);
      if (finalResult && callStatus === "RESULTED") {
        this.pending = recoveryPending;
        void this.resumeWithResult(recoveryPending, finalResult);
      } else if (callStatus === "POSTED" && this.options.bridgeAvailable()) {
        this.pending = recoveryPending;
        void this.resumeWithResult(recoveryPending, failedResult(request, "Host 重建后只确认到已发送但未确认的工具调用。"));
      } else {
        this.setState({ status: "RECOVERY_REQUIRED", cueId: input.cue.id, tool: request.tool, error: callStatus === "RESUMED" ? "工具结果已发送但 Host 尚未确认 Graph 状态；请恢复后检查。" : "工具调用已发送但结果未知；请恢复后关闭这次等待。" });
      }
      return;
    }
    if (!this.options.isLive(input)) return;
    if (command.type !== "teachingTool") {
      this.setState({ status: "FAILED", cueId: input.cue.id, tool: request.tool, error: "Host 返回了不匹配的教学命令；基础回放仍可继续。" });
      return;
    }
    const pending: PendingTool = { request, context, input, token, commandGeneration: command.generation };
    this.pending = pending;
    this.armTimeout(pending);
    this.setState({ status: "FOCUSING", cueId: input.cue.id, tool: request.tool, presentation: command.args });
    this.options.post(command);
  }

  start(input: Stage3HostAdapterInput): void {
    if (this.busy || this.startedCueIds.has(input.cue.id) || !this.options.isLive(input)) return;
    this.startedCueIds.add(input.cue.id);
    this.activeInput = input;
    const token = ++this.token;
    this.pending = undefined;
    this.clearTimeout();
    this.setState({ status: "STARTING", cueId: input.cue.id });
    let prepared: ReturnType<CoachAgentStage3HostAdapter["prepareStart"]>;
    try {
      prepared = this.adapter.prepareStart(input);
      // Zero capabilities is a deterministic FINISH_CUE path. START_CUE must
      // still reach the Graph so completedCue/theme bookkeeping stays intact.
    } catch (error) {
      this.setState({ status: "FAILED", cueId: input.cue.id, error: shortError(error, "当前 cue 校验失败；基础回放仍可继续。") });
      return;
    }
    if (!this.isCurrent(input, token)) return;
    const targetIndex = input.plan?.segments?.findIndex((segment) => segment.id === input.cue.segment_id) ?? -1;
    const identityInput = targetIndex >= 0 ? this.identityInput(input) : undefined;
    const observerReady = identityInput && targetIndex >= 0
      ? this.queueObserversUntil(identityInput, targetIndex, false, "PLAYING")
      : Promise.resolve(true);
    void observerReady.then((ready) => {
      if (!ready) {
        this.setState({ status: "RECOVERY_REQUIRED", cueId: input.cue.id, error: "前置回放段未能同步到 Agent；基础回放仍可继续，请恢复 Agent 状态后重试。" });
        return undefined;
      }
      if (!this.isCurrent(input, token)) return undefined;
      return this.dispatchSerial(prepared.event);
    }).then((result) => {
      if (!result || !this.isCurrent(input, token)) return;
      if (!["DORMANT", "USER_TAKEOVER", "WAITING_TOOL"].includes(result.status)) {
        this.adapter.markLifecycleSynced(targetIndex);
      }
      if (!this.isCurrent(input, token)) return;
      return this.handleAgentResult(input, token, result);
    }).catch((error) => {
      if (!tokenIsCurrent(this.token, token)) return;
      this.setState({ status: "FAILED", cueId: input.cue.id, error: shortError(error, "教练工具不可用；基础回放仍可继续。") });
    });
  }

  acceptAck(ack: TeachingToolAckEvent): void {
    const pending = this.pending;
    if (!pending || pending.token !== this.token || !this.isCurrent(pending.input, pending.token)) return;
    let result: AgentToolResult | undefined;
    try {
      result = this.adapter.acceptTeachingToolAck(pending.request, ack, pending.context);
    } catch (error) {
      this.pending = undefined;
      this.clearTimeout();
      this.setState({ status: "FAILED", cueId: pending.input.cue.id, tool: pending.request.tool, error: shortError(error, "工具 ACK 未通过 Host 校验；基础回放仍可继续。") });
      return;
    }
    if (!result) return;
    void this.resumeWithResult(pending, result);
  }

  cancel(generation: number, error = "已由你接管，当前 Agent 工具已取消；基础回放仍可继续。"): void {
    this.token += 1;
    this.clearTimeout();
    this.pending = undefined;
    this.adapter.cancel(generation);
    if (this.busy) this.setState({ status: "CANCELLED", cueId: this.state.cueId, tool: this.state.tool, error });
  }

  /** Ordered user takeover: invalidate the visual effect before notifying Graph. */
  takeover(input: Stage3HostAdapterInput | undefined, reason = "用户接管了自由回放。", generation = input?.generation ?? 0): Promise<boolean> {
    const takeoverInput = input ?? this.activeInput;
    // A cue whose START/tool effect was still in flight was not consumed by
    // the Session reducer.  Allow that cue to re-enter after RETURN_TO_NEAREST
    // revokes its reveal; the run ledger will close the old posted call without
    // posting a second iframe side effect.  A COMPLETED controller state stays
    // marked so an already-finished cue cannot regain a TeachingMove.
    const rewalkInFlightCue = this.busy || this.pending !== undefined;
    this.token += 1;
    this.clearTimeout();
    this.pending = undefined;
    this.pendingResumeSequence = undefined;
    this.adapter.cancel(generation);
    if (rewalkInFlightCue && takeoverInput) this.startedCueIds.delete(takeoverInput.cue.id);
    if (this.busy) this.setState({ status: "CANCELLED", cueId: takeoverInput?.cue.id, tool: this.state.tool, error: reason });
    if (!takeoverInput) return Promise.resolve(true);
    try {
      const event = this.adapter.createTakeoverEvent(takeoverInput, `stage3-takeover-${takeoverInput.cue.id}-${++this.resumeSequence}`.replace(/[^a-zA-Z0-9_-]+/g, "-").slice(0, 160), reason);
      this.takeoverPromise = this.dispatchSerial(event)
        .then(() => true)
        .catch(() => {
          this.setState({ status: "RECOVERY_REQUIRED", cueId: takeoverInput.cue.id, error: "接管状态未能同步；恢复前不会重新派发教学工具。" });
          return false;
        });
      return this.takeoverPromise;
    } catch {
      this.setState({ status: "RECOVERY_REQUIRED", cueId: takeoverInput.cue.id, error: "接管状态未能同步；恢复前不会重新派发教学工具。" });
      return Promise.resolve(false);
    }
  }

  /**
   * Waits for USER_TAKEOVER to be checkpointed, then prepares a new lifecycle
   * START_CUE. If React has not landed in the paused cue yet, the input is held
   * for `resumeInputFor` instead of racing the session reducer.
   */
  async resumeAfterTakeover(input: Stage3HostAdapterInput): Promise<boolean> {
    const takeoverOk = this.takeoverPromise ? await this.takeoverPromise : true;
    if (!takeoverOk) return false;
    this.startedCueIds.delete(input.cue.id);
    this.pendingResumeSequence = ++this.resumeSequence;
    if (this.options.isLive(input)) {
      const restored = this.resumeInputFor(input);
      this.start(restored);
    }
    return true;
  }

  /** Called by Host's guarded effect after the reducer lands on the cue. */
  resumeInputFor(input: Stage3HostAdapterInput): Stage3HostAdapterInput {
    const sequence = this.pendingResumeSequence;
    if (sequence === undefined) return input;
    this.pendingResumeSequence = undefined;
    return {
      ...input,
      resumeFromTakeover: true,
      lifecycleEventId: `stage3-restore-${input.cue.id}-${sequence}`.replace(/[^a-zA-Z0-9_-]+/g, "-").slice(0, 160),
    };
  }

  observeSegment(
    input: Stage3IdentityInput,
    segmentId: string,
    segmentIndex: number,
    mode: "SKIP" | "FREEZE" | "BRIEF" | "OBSERVE",
    currentSessionPhase: "PLAYING" | "SKIPPING" | "PAUSED_FOR_COACHING" | "REVEALING",
  ): void {
    void this.queueObserversUntil(input, segmentIndex, true, currentSessionPhase).catch(() => undefined);
  }

  completeSession(input: Stage3IdentityInput): Promise<CoachAgentResult | undefined> {
    const eventId = `stage3-complete-${input.runId}`.replace(/[^a-zA-Z0-9_-]+/g, "-").slice(0, 160);
    const lifecycleStatus = this.adapter.beginLifecycleEvent(eventId);
    if (lifecycleStatus === "CONFIRMED") return Promise.resolve(undefined);
    try {
      const event = this.adapter.createCompleteSessionEvent(input, eventId);
      return this.dispatchLifecycle(event, eventId).then((result) => {
        if (!result) return undefined;
        const identity = result.identity;
        return identity.runId === input.runId && identity.routeId === input.plan.id && identity.routeHash === input.routeState.routeFingerprint && identity.selectedPlayerId === input.selectedPlayerId
          ? result
          : undefined;
      }).catch(() => undefined);
    } catch {
      // Completion sync is best effort; the reducer remains the UI authority.
      this.adapter.releaseLifecycleEvent(eventId);
      return Promise.resolve(undefined);
    }
  }

  /** Explicit recovery entry after a bridge-lost boundary. */
  recover(input: Stage3HostAdapterInput): void {
    if (this.busy) return;
    this.startedCueIds.delete(input.cue.id);
    this.token += 1;
    this.clearTimeout();
    this.pending = undefined;
    this.adapter.cancel(input.generation);
    this.adapter.clearLifecycleDegraded();
    this.adapter.resetLifecycleQueue();
    this.start(input);
  }

  reset(): void {
    this.token += 1;
    this.clearTimeout();
    this.pending = undefined;
    this.startedCueIds.clear();
    this.adapter.reset();
    this.activeInput = undefined;
    this.takeoverPromise = undefined;
    this.pendingResumeSequence = undefined;
    this.lifecycleTail = Promise.resolve();
    this.lifecyclePromises.clear();
    this.setState({ status: "IDLE" });
  }

  dispose(): void {
    this.token += 1;
    this.clearTimeout();
    this.pending = undefined;
  }
}

function tokenIsCurrent(current: number, expected: number): boolean {
  return current === expected;
}

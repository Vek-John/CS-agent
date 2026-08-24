import {
  AgentToolRequestSchema,
  AgentToolResultSchema,
  CoachAgentEventSchema,
  CoachAgentIdentitySchema,
  TeachingCapabilitySchema,
  createRemoteCoachAgentDispatchEnvelope,
  parseRemoteCoachAgentDispatchResponse,
  serializeRemoteCoachAgentDispatchEnvelope,
  type AgentToolRequest,
  type CoachAgentEvent,
  type CoachAgentIdentity,
  type CoachAgentResult,
} from "@cs-coach/coach-agent/client";

export const COACH_AGENT_BROWSER_SMOKE_VERSION = "coach-agent-browser-smoke.v2" as const;
export const STAGE0_TOOL_REQUEST_STORAGE_KEY =
  "cs-coach.stage0.browser-smoke.tool-request.v1";
export const STAGE0_CUE_ID = "stage0-cue";
export const STAGE0_PHASE = "PAUSED_FOR_COACHING" as const;

export type Stage0Phase = "start" | "resume" | "reset";
export type SmokeStatus = "PASS" | "FAIL" | "WAITING";
export type RemoteBackend = "MEMORY" | "DURABLE_OBJECT";

export interface BrowserSmokeResult {
  version: typeof COACH_AGENT_BROWSER_SMOKE_VERSION;
  phase: Stage0Phase;
  status: SmokeStatus;
  backend: RemoteBackend | null;
  startStatus: CoachAgentResult["status"] | null;
  resumeStatus: CoachAgentResult["status"] | null;
  effectCount: number;
  cuePhaseMatch: boolean;
  recoverableAfterRefresh: boolean;
  error: string | null;
}

export const STAGE0_IDENTITY: CoachAgentIdentity = Object.freeze(
  CoachAgentIdentitySchema.parse({
    runId: "stage0-run",
    sessionId: "stage0-session",
    demoId: "stage0-demo-fixture",
    demoContentHash: "sha256-stage0-demo-fixture",
    selectedPlayerId: "stage0-player",
    routeId: "stage0-route",
    routeHash: "sha256-stage0-route",
  }),
);

const stage0Capability = TeachingCapabilitySchema.parse({
  capabilityId: "cap-stage0-slow-replay",
  tool: "REPLAY_CUE_SLOW",
  boundArgs: {
    tool: "REPLAY_CUE_SLOW",
    cueId: STAGE0_CUE_ID,
    speed: 0.5,
  },
  evidenceRefs: ["stage0-action-ref"],
  estimatedDurationMs: 1_000,
});

function asEvent(value: CoachAgentEvent): CoachAgentEvent {
  return CoachAgentEventSchema.parse(value);
}

export function createStage0StartEvent(
  eventId = "stage0-start",
): Extract<CoachAgentEvent, { type: "START_CUE" }> {
  return asEvent({
    version: "coach-agent-event.v1",
    type: "START_CUE",
    eventId,
    identity: STAGE0_IDENTITY,
    segmentId: "stage0-segment",
    cueId: STAGE0_CUE_ID,
    focus: "stage0-focus",
    currentSessionPhase: STAGE0_PHASE,
    outcomeGateStatus: "COMPLETE",
    narrationReadiness: "READY",
    narrationSummary: {
      primaryFocusCode: "STAGE0_FOCUS",
      readiness: "READY",
      limitationCount: 1,
    },
    allowedEvidenceSummary: [
      { namespace: "ACTION", refs: ["stage0-action-ref"] },
    ],
    limitations: ["browser smoke uses a fixed synthetic cue"],
    sessionThemes: [
      {
        focus: "stage0-focus",
        cueRefs: [STAGE0_CUE_ID],
        roundRefs: ["stage0-round"],
        evidenceRefs: ["stage0-action-ref"],
        occurrence: 1,
        economyContext: "UNKNOWN",
        repeated: false,
        conflictEvidence: false,
      },
    ],
    capabilities: [stage0Capability],
  }) as Extract<CoachAgentEvent, { type: "START_CUE" }>;
}

export function createStage0ToolResult(request: AgentToolRequest) {
  const checkedRequest = AgentToolRequestSchema.parse(request);
  return AgentToolResultSchema.parse({
    callId: checkedRequest.callId,
    status: "SUCCEEDED",
    observation: { code: "CUE_PLAYED", completed: true },
    limitations: [],
  });
}

export function createStage0ResumeEvent(
  request: AgentToolRequest,
  eventId = "stage0-resume",
): Extract<CoachAgentEvent, { type: "RESUME_TOOL" }> {
  return asEvent({
    version: "coach-agent-event.v1",
    type: "RESUME_TOOL",
    eventId,
    identity: STAGE0_IDENTITY,
    result: createStage0ToolResult(request),
  }) as Extract<CoachAgentEvent, { type: "RESUME_TOOL" }>;
}

export function createStage0ResetEvent(
  eventId = "stage0-reset",
): Extract<CoachAgentEvent, { type: "RESET" }> {
  return asEvent({
    version: "coach-agent-event.v1",
    type: "RESET",
    eventId,
    identity: STAGE0_IDENTITY,
  }) as Extract<CoachAgentEvent, { type: "RESET" }>;
}

export function serializeStage0ToolRequest(request: AgentToolRequest): string {
  return JSON.stringify(AgentToolRequestSchema.parse(request));
}

export function parseStage0ToolRequest(serialized: string): AgentToolRequest {
  return AgentToolRequestSchema.parse(JSON.parse(serialized));
}

export function toolRequestFromResult(result: CoachAgentResult): AgentToolRequest {
  const parsed = parseRemoteCoachAgentDispatchResponse(result);
  const request = parsed.effects[0];
  if (!request) throw new Error("Stage0 start produced no tool request");
  return AgentToolRequestSchema.parse(request);
}

export interface RemoteFetchLike {
  (input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
}

export async function dispatchStage0Event(
  event: CoachAgentEvent,
  fetcher: RemoteFetchLike = fetch,
): Promise<CoachAgentResult> {
  const envelope = createRemoteCoachAgentDispatchEnvelope(event);
  const response = await fetcher("/api/coaching/agent", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: serializeRemoteCoachAgentDispatchEnvelope(envelope),
  });
  if (!response.ok) throw new Error(`agent dispatch HTTP ${response.status}`);
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new Error("agent dispatch returned invalid JSON");
  }
  return parseRemoteCoachAgentDispatchResponse(body);
}

export function stage0PhaseFromSearch(search: string): Stage0Phase {
  const phase = new URLSearchParams(search).get("phase");
  return phase === "resume" || phase === "reset" ? phase : "start";
}

function shortError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/\s+/g, " ").trim().slice(0, 160) || "Stage0 smoke failed";
}

function remoteBackend(result: CoachAgentResult): RemoteBackend | null {
  return result.checkpoint.backend === "MEMORY" ||
      result.checkpoint.backend === "DURABLE_OBJECT"
    ? result.checkpoint.backend
    : null;
}

function validPersistence(
  result: CoachAgentResult,
  backend: RemoteBackend | null,
): boolean {
  return (
    backend !== null &&
    result.checkpoint.recoverableAfterRefresh ===
      (backend === "DURABLE_OBJECT")
  );
}

function reportFromResult(
  phase: Stage0Phase,
  result: CoachAgentResult,
  fields: Pick<BrowserSmokeResult, "startStatus" | "resumeStatus" | "cuePhaseMatch">,
  valid: boolean,
  error: string | null,
): BrowserSmokeResult {
  const backend = remoteBackend(result);
  return {
    version: COACH_AGENT_BROWSER_SMOKE_VERSION,
    phase,
    status: valid ? "PASS" : "FAIL",
    backend,
    startStatus: fields.startStatus,
    resumeStatus: fields.resumeStatus,
    effectCount: result.effects.length,
    cuePhaseMatch: fields.cuePhaseMatch,
    recoverableAfterRefresh: result.checkpoint.recoverableAfterRefresh,
    error,
  };
}

export function evaluateRemoteStartResult(
  result: CoachAgentResult,
): BrowserSmokeResult {
  try {
    const parsed = parseRemoteCoachAgentDispatchResponse(result);
    const backend = remoteBackend(parsed);
    const cuePhaseMatch =
      parsed.state.activeCueId === STAGE0_CUE_ID &&
      parsed.state.currentSessionPhase === STAGE0_PHASE;
    const valid =
      parsed.status === "WAITING_TOOL" &&
      parsed.effects.length === 1 &&
      cuePhaseMatch &&
      validPersistence(parsed, backend);
    return reportFromResult(
      "start",
      parsed,
      { startStatus: parsed.status, resumeStatus: null, cuePhaseMatch },
      valid,
      valid
        ? null
        : backend === null
          ? "unsupported remote checkpoint backend"
          : "remote start did not reach WAITING_TOOL",
    );
  } catch (error) {
    return createStage0FailureResult("start", error);
  }
}

export function evaluateRemoteResumeResult(
  result: CoachAgentResult,
): BrowserSmokeResult {
  try {
    const parsed = parseRemoteCoachAgentDispatchResponse(result);
    const backend = remoteBackend(parsed);
    const cuePhaseMatch =
      parsed.state.activeCueId === STAGE0_CUE_ID &&
      parsed.state.currentSessionPhase === STAGE0_PHASE;
    const valid =
      parsed.status === "COMPLETED" &&
      parsed.effects.length === 0 &&
      parsed.restored === "MATCHED" &&
      parsed.state.completedCueIds.includes(STAGE0_CUE_ID) &&
      cuePhaseMatch &&
      validPersistence(parsed, backend);
    return reportFromResult(
      "resume",
      parsed,
      { startStatus: null, resumeStatus: parsed.status, cuePhaseMatch },
      valid,
      valid
        ? null
        : backend === null
          ? "unsupported remote checkpoint backend"
          : "remote resume did not complete the stored cue",
    );
  } catch (error) {
    return createStage0FailureResult("resume", error);
  }
}

export function evaluateRemoteResetResult(
  result: CoachAgentResult,
): BrowserSmokeResult {
  try {
    const parsed = parseRemoteCoachAgentDispatchResponse(result);
    const backend = remoteBackend(parsed);
    const cuePhaseMatch =
      parsed.state.activeCueId === null &&
      parsed.state.currentSessionPhase === "DORMANT";
    const valid =
      parsed.status === "DORMANT" &&
      parsed.effects.length === 0 &&
      parsed.restored === "FRESH" &&
      cuePhaseMatch &&
      validPersistence(parsed, backend);
    return reportFromResult(
      "reset",
      parsed,
      { startStatus: null, resumeStatus: parsed.status, cuePhaseMatch },
      valid,
      valid
        ? null
        : backend === null
          ? "unsupported remote checkpoint backend"
          : "remote reset did not clear the session",
    );
  } catch (error) {
    return createStage0FailureResult("reset", error);
  }
}

export function createWaitingBrowserSmokeResult(
  phase: Stage0Phase,
): BrowserSmokeResult {
  return {
    version: COACH_AGENT_BROWSER_SMOKE_VERSION,
    phase,
    status: "WAITING",
    backend: null,
    startStatus: null,
    resumeStatus: null,
    effectCount: 0,
    cuePhaseMatch: false,
    recoverableAfterRefresh: false,
    error: null,
  };
}

export function createStage0FailureResult(
  phase: Stage0Phase,
  error: unknown,
): BrowserSmokeResult {
  return {
    ...createWaitingBrowserSmokeResult(phase),
    status: "FAIL",
    error: shortError(error),
  };
}

export function stage0BackendDescription(
  result: BrowserSmokeResult,
): string {
  if (result.backend === "MEMORY" && !result.recoverableAfterRefresh) {
    return "当前服务进程内恢复";
  }
  if (result.backend === "DURABLE_OBJECT" && result.recoverableAfterRefresh) {
    return "可跨页面/实例恢复";
  }
  return result.status === "WAITING" ? "等待远程结果" : "恢复能力不可用";
}

export function errorText(error: unknown): string {
  return shortError(error);
}

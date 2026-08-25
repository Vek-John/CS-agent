"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState
} from "react";
import type { PointerEvent as ReactPointerEvent } from "react";
import {
  ArrowLeftRight,
  ArrowUpDown,
  Bomb,
  CircleDollarSign,
  Crosshair,
  Heart,
  Lightbulb,
  MapPin,
  PackageOpen,
  Pause,
  Play,
  RotateCcw,
  RotateCw,
  Shield,
  SkipBack,
  SkipForward,
  TriangleAlert
} from "lucide-react";
import type {
  GameAssetCatalog,
  CoachingSessionState,
  PlaybackBridgeEvent,
  PlaybackCommand,
  PlaybackStateEvent,
  PlayerSelectedEvent,
  ReplayReadyEvent,
  ReviewPlan,
  CoachingRouteState,
  NarrationBundle,
  AnalysisProgressEvent,
  AnalysisTelemetryEvent
} from "@cs-coach/contracts";
import type {
  AgentToolResult,
  AgentToolRequest,
  CoachAgentResult,
  HostToolLedgerSummary,
  SessionRecoveryRecord,
  SessionRecoveryResult,
  SessionSummaryInput,
  SessionWrapUpRequest,
  SessionWrapUpResult
} from "@cs-coach/coach-agent/client";
import { deterministicSessionWrapUpResult, SessionWrapUpRequestSchema } from "@cs-coach/coach-agent/client";
import {
  deserializeCs2dAnalysisBundle,
  type Cs2dAnalysisBundle
} from "@cs-coach/cs2d-analysis-adapter";
import {
  buildSessionSummary,
  createCoachingSession,
  getCurrentCue,
  getCurrentSegment,
  reduceCoachingSession,
  type SessionAction
} from "@cs-coach/session";
import {
  buildSessionRecoveryRecord,
  buildReconnectReplayEvent,
  createRecoverySessionIdentity,
  createRecoveryReviewPreparationDependencies,
  checkpointForRecoveryBoundary,
  normalizeRecoveryAnalysis,
  reconciledRecoveryLedger,
  restoreRecoveryArtifacts,
  shouldReconnectRecoveryAgent,
  isPreAgentRouteStartRecovery,
  type RecoveryAgentCheckpointMeta,
  type RecoverySessionIdentity,
} from "../../lib/recovery/cs2d-session-recovery";
import { createSessionRecoveryRuntime } from "../../lib/recovery/session-recovery-runtime";
import {
  createReviewPreparationOrchestrator,
  createCs2dReviewPreparationDependencies,
  type ReviewPreparationDependencies
} from "../../lib/coaching/cs2d-route-integration";
import {
  createGuidedSeekGate,
  guidedPlaybackDirective,
  guidedTransitionKey,
  isGuidedSeekLanding,
  type GuidedSeekGate
} from "../../lib/coaching/cs2d-guided-session";
import {
  buildThreeStageCoachingView,
  playerStateAtOrBefore,
  type CoachingStatusChip
} from "../../lib/coaching/cs2d-coaching-view";
import { resolveItemPresentation } from "../../lib/assets/game-asset-display";
import { loadLocalGameAssetCatalog } from "../../lib/assets/local-game-asset-catalog";
import { requestSessionWrapUp } from "../../lib/coaching/deepseek-wrap-up";
import { buildStage3WrapUpInput } from "../../lib/coaching/coach-agent-stage3-wrap-up";
import { buildSessionWrapUpRequest } from "@cs-coach/coach-agent/client";
import {
  CoachAgentHostAdapter,
  dispatchCoachAgentEvent,
  selectFirstStage2Cue,
  Stage2AckTimeoutController,
  type Stage2ToolContext
} from "../../lib/coaching/coach-agent-host-adapter";
import {
  CoachAgentStage3HostAdapter,
  createStage3HostAdapterStore,
  stage3EligibleCueIds,
  stage3ToolStatusLabel,
  stableStage3IdentityToken,
  type Stage3HostAdapterInput,
  type Stage3IdentityInput,
  type Stage3HostAdapterStore
} from "../../lib/coaching/coach-agent-stage3-host-adapter";
import {
  CoachAgentStage3Controller,
  type Stage3ControllerState,
  type Stage3ToolLedgerTransition,
} from "../../lib/coaching/coach-agent-stage3-controller";
import {
  SessionRecoveryStatus,
  type SessionRecoveryStatusKind,
} from "./session-recovery-status";
import {
  acceptedPlaybackEvent,
  adjacentRoundIndex,
  analysisEventMatchesSelectedPlayer,
  coachAgentEntryMode,
  coachingCueProgress,
  clampCanonicalTick,
  cs2dHostConfig,
  playbackCommandMessage,
  playbackPositionLabel,
  reviewPositionAtTick,
  reviewSegmentTone,
  seekCanonicalBySeconds,
  timelineRange,
  timelinePercent,
  HOST_SPEED_OPTIONS,
  hostCoachingCueSurface,
  type CoachAgentEntryMode
} from "../../lib/playback/cs2d-playback-host";

type HostPhase = "BOOTING" | "WAITING_FOR_DEMO" | "READY" | "ERROR";

const phaseText: Record<CoachingSessionState["phase"], string> = {
  INTRO: "准备讲解",
  PLAYING: "带你看比赛",
  SKIPPING: "自动跳过",
  PAUSED_FOR_COACHING: "教练暂停",
  REVEALING: "播放结果",
  REPLAYING: "再次回看",
  BUFFERING: "准备下一段",
  WRAP_UP: "全场总结",
  COMPLETED: "复盘完成"
};

const CS_NET_DEFAULT_PROVIDER = "webgpu-fp16";
const CS_NET_DEFAULT_BATCH_SIZE = "16";
const TIMELINE_HORIZONTAL_ZOOM_MIN = 1;
const TIMELINE_HORIZONTAL_ZOOM_MAX = 4;
const TIMELINE_HORIZONTAL_ZOOM_STEP = 0.25;
const WIN_RATE_VERTICAL_ZOOM_MIN = 0.75;
const WIN_RATE_VERTICAL_ZOOM_MAX = 2.5;
const WIN_RATE_VERTICAL_ZOOM_STEP = 0.25;
const WIN_RATE_BASE_CHART_HEIGHT_REM = 3.2;

function CoachingStatusGlyph({ chip, catalog }: { chip: CoachingStatusChip; catalog?: GameAssetCatalog }) {
  if (chip.kind === "weapon" && chip.item) {
    const presentation = resolveItemPresentation(catalog, chip.item);
    if (presentation.iconRef) return <img src={presentation.iconRef} alt="" aria-hidden="true" />;
  }
  if (chip.kind === "location") return <MapPin aria-hidden="true" />;
  if (chip.kind === "health") return <Heart aria-hidden="true" />;
  if (chip.kind === "armor") return <Shield aria-hidden="true" />;
  if (chip.kind === "utility") return <PackageOpen aria-hidden="true" />;
  if (chip.kind === "money") return <CircleDollarSign aria-hidden="true" />;
  if (chip.kind === "objective") return <Bomb aria-hidden="true" />;
  return <Crosshair aria-hidden="true" />;
}

function coachingStatusText(chip: CoachingStatusChip, catalog?: GameAssetCatalog): string {
  if (chip.kind !== "weapon" || !chip.item) return chip.text;
  return resolveItemPresentation(catalog, chip.item).label;
}

export interface Cs2dPlaybackHostProps {
  /** Optional test/provider override; production builds it from ANALYSIS_READY. */
  reviewPreparationDependencies?: ReviewPreparationDependencies;
}

type ReviewPreparationStatus = {
  phase: "ROUTE" | "NARRATION" | "READY" | "ERROR";
  detail: string;
};

type Stage2Status = "IDLE" | "STARTING" | "FOCUSING" | "RESUMING" | "COMPLETED" | "FAILED" | "CANCELLED";

type Stage2PendingTool = {
  request: AgentToolRequest;
  context: Stage2ToolContext;
  generation: number;
  cueId: string;
};

type Stage3WrapUpStatus = "IDLE" | "LOADING" | "READY" | "FALLBACK" | "ERROR";

type RecoveryLanding = {
  readonly recoveryId: string;
  readonly targetTick: number;
  readonly staged: ReturnType<typeof restoreRecoveryArtifacts>;
  readonly record: SessionRecoveryRecord;
  readonly analysis: Cs2dAnalysisBundle;
};

function recoveryEventId(prefix: string): string {
  return `${prefix}-${crypto.randomUUID()}`.slice(0, 160);
}

export function Cs2dPlaybackHost({
  reviewPreparationDependencies
}: Cs2dPlaybackHostProps = {}) {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const planRef = useRef<ReviewPlan | undefined>(undefined);
  const [benchmarkQuery, setBenchmarkQuery] = useState("");
  const [coachAgentMode, setCoachAgentMode] = useState<CoachAgentEntryMode>("STAGE3");
  useEffect(() => {
    if (process.env.NODE_ENV === "production") return;
    const query = new URLSearchParams(window.location.search);
    const threads = query.get("csThreads");
    const batch = query.get("csBatch");
    const provider = query.get("csProvider");
    if ((threads === "1" || threads === "2" || threads === "4") || (batch && /^\d+$/.test(batch)) || provider === "wasm-int8" || provider === "wasm-fp32" || provider === "webgpu-fp16") {
      const params = new URLSearchParams();
      if (threads === "1" || threads === "2" || threads === "4") params.set("csThreads", threads);
      if (batch && /^\d+$/.test(batch)) params.set("csBatch", batch);
      if (provider === "wasm-int8" || provider === "wasm-fp32" || provider === "webgpu-fp16") params.set("csProvider", provider);
      setBenchmarkQuery(params.toString());
    }
  }, []);
  useEffect(() => {
    setCoachAgentMode(coachAgentEntryMode(window.location.search));
  }, []);
  const stage2Mode = coachAgentMode === "STAGE2";
  const stage3Mode = coachAgentMode === "STAGE3";
  const config = useMemo(() => {
    const base = cs2dHostConfig();
    // Keep the host URL deterministic during Next SSR; the browser origin is
    // only needed when resolving a relative Cloudflare viewer path.
    const parentOrigin = typeof window === "undefined" ? "http://localhost:3000" : window.location.origin;
    const parsed = new URL(base.url, parentOrigin);
    if (!parsed.searchParams.has("csProvider")) parsed.searchParams.set("csProvider", CS_NET_DEFAULT_PROVIDER);
    if (!parsed.searchParams.has("csBatch")) parsed.searchParams.set("csBatch", CS_NET_DEFAULT_BATCH_SIZE);
    new URLSearchParams(benchmarkQuery).forEach((value, key) => parsed.searchParams.set(key, value));
    return { ...base, url: base.url.startsWith("/") ? `${parsed.pathname}${parsed.search}${parsed.hash}` : parsed.toString() };
  }, [benchmarkQuery]);
  const [phase, setPhase] = useState<HostPhase>("BOOTING");
  const [replay, setReplay] = useState<ReplayReadyEvent>();
  const [selected, setSelected] = useState<PlayerSelectedEvent>();
  const selectedPlayerIdRef = useRef<string | undefined>(undefined);
  const [playback, setPlayback] = useState<PlaybackStateEvent>();
  const [bundle, setBundle] = useState<Cs2dAnalysisBundle>();
  const [plan, setPlan] = useState<ReviewPlan>();
  const routeStateRef = useRef<CoachingRouteState | undefined>(undefined);
  const [routeState, setRouteState] = useState<CoachingRouteState>();
  const [narrationByCue, setNarrationByCue] = useState<Readonly<Record<string, NarrationBundle>>>({});
  const preparationRef = useRef<ReturnType<typeof createReviewPreparationOrchestrator> | undefined>(undefined);
  const generationRef = useRef(0);
  const recoveryRuntimeRef = useRef<ReturnType<typeof createSessionRecoveryRuntime> | undefined>(undefined);
  const recoveryRecordRef = useRef<SessionRecoveryRecord | undefined>(undefined);
  const recoveryModeRef = useRef(false);
  const recoveryHandshakeReadyRef = useRef(true);
  const recoveryLandingRef = useRef<RecoveryLanding | undefined>(undefined);
  const recoveryLandingTimeoutRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const stableRecoveryKeyRef = useRef<string | undefined>(undefined);
  const completedRecoveryRef = useRef<string | undefined>(undefined);
  const latestAgentCheckpointRef = useRef<RecoveryAgentCheckpointMeta | undefined>(undefined);
  const [recoveryResult, setRecoveryResult] = useState<SessionRecoveryResult>();
  const [recoveryIdentity, setRecoveryIdentity] = useState<RecoverySessionIdentity>();
  const recoveryIdentityRef = useRef<RecoverySessionIdentity | undefined>(undefined);
  const bundleRef = useRef<Cs2dAnalysisBundle | undefined>(undefined);
  const narrationByCueRef = useRef<Readonly<Record<string, NarrationBundle>>>({});
  const [session, setSession] = useState<CoachingSessionState>();
  const [analysisError, setAnalysisError] = useState<string>();
  const [analysisProgress, setAnalysisProgress] = useState<AnalysisProgressEvent>();
  const [reviewPreparationStatus, setReviewPreparationStatus] = useState<ReviewPreparationStatus>();
  // Kept out of visible copy: telemetry is a validation/diagnostics boundary,
  // not a player-facing performance control.
  const [analysisTelemetry, setAnalysisTelemetry] = useState<AnalysisTelemetryEvent["telemetry"]>();
  const timelineRailRef = useRef<HTMLDivElement>(null);
  const timelineViewportRef = useRef<HTMLDivElement>(null);
  const timelineContentRef = useRef<HTMLDivElement>(null);
  const timelinePanRef = useRef<{ pointerId: number; startClientX: number; startScrollLeft: number } | undefined>(undefined);
  const userTookOverRef = useRef(false);
  const stage2AdapterRef = useRef(new CoachAgentHostAdapter());
  const stage2AckTimeoutRef = useRef(new Stage2AckTimeoutController());
  const stage2PendingRef = useRef<Stage2PendingTool | undefined>(undefined);
  const stage2StartedCueRef = useRef<string | undefined>(undefined);
  const stage2IdentityRef = useRef<{ key: string; runId: string; sessionId: string } | undefined>(undefined);
  const stage3StoreRef = useRef<Stage3HostAdapterStore | undefined>(undefined);
  if (!stage3StoreRef.current) stage3StoreRef.current = createStage3HostAdapterStore();
  const stage3AdapterRef = useRef(new CoachAgentStage3HostAdapter(stage3StoreRef.current));
  const stage3ControllerRef = useRef<CoachAgentStage3Controller | undefined>(undefined);
  const stage3BlockedCueRef = useRef(new Set<string>());
  const stage3InputRef = useRef<Stage3HostAdapterInput | undefined>(undefined);
  const replayHashRef = useRef<string | undefined>(undefined);
  const liveSessionRef = useRef<CoachingSessionState | undefined>(undefined);
  const liveCueRef = useRef<ReviewPlan["cues"][number] | undefined>(undefined);
  const guidedSeekEpochRef = useRef(0);
  const guidedSeekGateRef = useRef<GuidedSeekGate | undefined>(undefined);
  const [userTookOver, setUserTookOver] = useState(false);
  const [stage2Status, setStage2Status] = useState<Stage2Status>("IDLE");
  const [stage2Error, setStage2Error] = useState<string>();
  const [stage3State, setStage3State] = useState<Stage3ControllerState>({ status: "IDLE" });
  const [stage3WrapUpStatus, setStage3WrapUpStatus] = useState<Stage3WrapUpStatus>("IDLE");
  const [stage3WrapUpResult, setStage3WrapUpResult] = useState<SessionWrapUpResult>();
  const [stage3WrapUpRequest, setStage3WrapUpRequest] = useState<SessionWrapUpRequest>();
  const [stage3WrapUpError, setStage3WrapUpError] = useState<string>();
  const stage3WrapUpGenerationRef = useRef<number | undefined>(undefined);
  const [timelineHorizontalZoom, setTimelineHorizontalZoom] = useState(1);
  const [winRateVerticalZoom, setWinRateVerticalZoom] = useState(1);
  const [timelinePanning, setTimelinePanning] = useState(false);
  const [gameAssetCatalog, setGameAssetCatalog] = useState<GameAssetCatalog>();

  useEffect(() => {
    let active = true;
    void loadLocalGameAssetCatalog().then((catalog) => {
      if (active) setGameAssetCatalog(catalog);
    });
    return () => { active = false; };
  }, []);

  const acceptRecoveryResult = useCallback((result: SessionRecoveryResult) => {
    if (result.record) recoveryRecordRef.current = result.record;
    else if (result.recoveryId === null) recoveryRecordRef.current = undefined;
    setRecoveryResult(result);
  }, []);

  const currentStableRecoveryRecord = useCallback((checkpoint: RecoveryAgentCheckpointMeta | undefined): SessionRecoveryRecord | undefined => {
    const current = recoveryRecordRef.current;
    const identity = recoveryIdentityRef.current;
    const analysis = bundleRef.current;
    const activePlan = planRef.current;
    const activeRoute = routeStateRef.current;
    const activeSession = liveSessionRef.current;
    if (!current || !identity || !analysis || !activePlan || !activeRoute || !activeSession) return undefined;
    const boundaryKind = activeSession.phase === "PAUSED_FOR_COACHING" && activeSession.outcome_completion?.status === "COMPLETE"
      ? "CUE_PAUSED" as const
      : activeSession.phase === "WRAP_UP"
        ? "WRAP_UP" as const
        : undefined;
    if (!boundaryKind) return undefined;
    const baseInput = {
      identity,
      demoContentHash: current.demoContentHash,
      selectedPlayerId: current.selectedPlayerId,
      plan: activePlan,
      routeState: activeRoute,
      session: activeSession,
      boundaryKind,
      narrationByCue: narrationByCueRef.current,
      analysis,
      agentCheckpointId: null,
      toolLedger: current.toolLedger,
      createdAt: current.createdAt,
      updatedAt: Date.now(),
    } as const;
    const withoutCheckpoint = buildSessionRecoveryRecord(baseInput);
    const checkpointId = checkpointForRecoveryBoundary(checkpoint, withoutCheckpoint.boundary);
    return checkpointId
      ? buildSessionRecoveryRecord({ ...baseInput, agentCheckpointId: checkpointId })
      : withoutCheckpoint;
  }, []);

  useEffect(() => {
    const runtime = createSessionRecoveryRuntime();
    recoveryRuntimeRef.current = runtime;
    let active = true;
    void runtime.dispatch({ type: "BOOT", eventId: recoveryEventId("recovery-boot") }).then((result) => {
      if (!active) return;
      acceptRecoveryResult(result);
      if (result.record) {
        recoveryModeRef.current = true;
        const identity = {
          recoveryId: result.record.recoveryId,
          sessionId: result.record.sessionId,
          runId: result.record.runId,
        };
        recoveryIdentityRef.current = identity;
        setRecoveryIdentity(identity);
      }
    });
    return () => {
      active = false;
      recoveryRuntimeRef.current = undefined;
    };
  }, [acceptRecoveryResult]);

  const mirrorAgentResult = useCallback(async (event: import("@cs-coach/coach-agent/client").CoachAgentEvent, result: CoachAgentResult) => {
    if (result.status === "WAITING_TOOL" || event.type === "RESUME_TOOL" || event.type === "RECONNECT_REPLAY") return;
    const checkpoint: RecoveryAgentCheckpointMeta = {
      checkpointId: result.checkpoint.checkpointId,
      activeCueId: result.state.activeCueId,
      currentSessionPhase: result.state.currentSessionPhase,
      routeCursor: result.state.routeCursor,
      sessionStatus: result.state.sessionStatus,
    };
    latestAgentCheckpointRef.current = checkpoint;
    const runtime = recoveryRuntimeRef.current;
    const record = recoveryRecordRef.current;
    if (!runtime || !record || result.identity.runId !== record.runId || result.identity.sessionId !== record.sessionId || result.identity.routeHash !== record.routeHash) return;
    const stable = currentStableRecoveryRecord(checkpoint);
    if (!stable || stable.agentCheckpointId !== checkpoint.checkpointId) return;
    const persisted = await runtime.dispatch({
      type: "STABLE_BOUNDARY_REACHED",
      eventId: recoveryEventId("recovery-checkpoint"),
      recoveryId: record.recoveryId,
      boundary: stable.boundary,
      cueProgress: stable.cueProgress,
      routeReadiness: stable.routeReadiness,
      narrationArtifacts: stable.narrationArtifacts,
      agentCheckpointId: result.checkpoint.checkpointId,
      updatedAt: Date.now(),
    });
    acceptRecoveryResult(persisted);
  }, [acceptRecoveryResult, currentStableRecoveryRecord]);

  const persistToolTransition = useCallback(async (transition: Stage3ToolLedgerTransition) => {
    const runtime = recoveryRuntimeRef.current;
    const record = recoveryRecordRef.current;
    if (!runtime || !record || transition.request.runId !== record.runId) return;
    const result = transition.result;
    const entry: HostToolLedgerSummary = {
      callId: transition.request.callId,
      cueId: transition.request.cueId,
      capabilityId: transition.request.capabilityId,
      status: transition.status,
      observationCode: result?.observation.code ?? null,
      result,
    };
    const persisted = transition.status === "POSTED"
      ? await runtime.dispatch({
          type: "STABLE_BOUNDARY_REACHED",
          eventId: recoveryEventId("recovery-tool-posted"),
          recoveryId: record.recoveryId,
          ...(() => {
            const checkpoint = {
              checkpointId: transition.agentCheckpointId,
              activeCueId: transition.agentState.activeCueId,
              currentSessionPhase: transition.agentState.currentSessionPhase,
              routeCursor: transition.agentState.routeCursor,
              sessionStatus: transition.agentState.sessionStatus,
            } satisfies RecoveryAgentCheckpointMeta;
            const stable = currentStableRecoveryRecord(checkpoint);
            if (!stable || stable.boundary.kind !== "CUE_PAUSED" || stable.agentCheckpointId !== transition.agentCheckpointId) throw new Error("POSTED requires a matching live CUE_PAUSED recovery boundary.");
            return {
              boundary: stable.boundary,
              cueProgress: stable.cueProgress,
              routeReadiness: stable.routeReadiness,
              narrationArtifacts: stable.narrationArtifacts,
            };
          })(),
          toolLedgerEntry: entry,
          agentCheckpointId: transition.agentCheckpointId,
          updatedAt: Date.now(),
        } as Parameters<typeof runtime.dispatch>[0])
      : await runtime.dispatch({
          type: "TOOL_LEDGER_UPDATED",
          eventId: recoveryEventId(`recovery-tool-${transition.status.toLowerCase()}`),
          recoveryId: record.recoveryId,
          entry,
          agentCheckpointId: transition.agentCheckpointId,
          updatedAt: Date.now(),
        });
    if (transition.status === "POSTED") {
      const persistedEntry = persisted.record?.toolLedger.find((candidate) => candidate.callId === transition.request.callId);
      if (persistedEntry?.status !== "POSTED" || persisted.record?.agentCheckpointId !== transition.agentCheckpointId) {
        throw new Error("POSTED tool ledger was not durably recorded with its waiting checkpoint.");
      }
    }
    latestAgentCheckpointRef.current = {
      checkpointId: transition.agentCheckpointId,
      activeCueId: transition.agentState.activeCueId,
      currentSessionPhase: transition.agentState.currentSessionPhase,
      routeCursor: transition.agentState.routeCursor,
      sessionStatus: transition.agentState.sessionStatus,
    };
    acceptRecoveryResult(persisted);
  }, [acceptRecoveryResult, currentStableRecoveryRecord]);

  const invalidateGeneration = useCallback(() => {
    stage2AckTimeoutRef.current.clear();
    stage2AdapterRef.current.cancel(generationRef.current);
    stage3ControllerRef.current?.reset();
    stage3BlockedCueRef.current.clear();
    stage3InputRef.current = undefined;
    stage3WrapUpGenerationRef.current = undefined;
    setStage3WrapUpStatus("IDLE");
    setStage3WrapUpResult(undefined);
    setStage3WrapUpRequest(undefined);
    setStage3WrapUpError(undefined);
    stage2PendingRef.current = undefined;
    stage2StartedCueRef.current = undefined;
    stage2IdentityRef.current = undefined;
    setStage2Status("IDLE");
    setStage2Error(undefined);
    generationRef.current += 1;
    preparationRef.current?.cancel();
    preparationRef.current = undefined;
  }, []);

  const tickMin = replay?.startCanonicalTick ?? 0;
  const tickMax = replay?.endCanonicalTick ?? Math.max(1, tickMin + 1);
  const tick = clampCanonicalTick(playback?.canonicalTick ?? tickMin, tickMin, tickMax);
  const currentRoundIndex = replay
    ? clampCanonicalTick(playback?.roundIndex ?? 0, 0, Math.max(0, replay.rounds.length - 1))
    : 0;

  const send = useCallback((command: PlaybackCommand) => {
    iframeRef.current?.contentWindow?.postMessage(playbackCommandMessage(command), config.origin);
  }, [config.origin]);

  const chooseRecoveryDemo = useCallback(() => {
    const runtime = recoveryRuntimeRef.current;
    const record = recoveryRecordRef.current;
    if (!runtime || !record) return;
    // File pickers require a trusted click inside the iframe. Bring that
    // existing local picker into view without moving File/FileList into Host.
    iframeRef.current?.scrollIntoView({ block: "center", behavior: "auto" });
    iframeRef.current?.focus();
    void runtime.dispatch({
      type: "REPLAY_LOADING",
      eventId: recoveryEventId("recovery-replay-loading"),
      recoveryId: record.recoveryId,
    }).then(acceptRecoveryResult);
  }, [acceptRecoveryResult]);

  const clearRecoveryLandingTimeout = useCallback(() => {
    if (recoveryLandingTimeoutRef.current === undefined) return;
    clearTimeout(recoveryLandingTimeoutRef.current);
    recoveryLandingTimeoutRef.current = undefined;
  }, []);

  const discardRecovery = useCallback(() => {
    const runtime = recoveryRuntimeRef.current;
    const record = recoveryRecordRef.current;
    if (!runtime || !record) return;
    void runtime.dispatch({
      type: "DISCARD_RECOVERY",
      eventId: recoveryEventId("recovery-discard"),
      recoveryId: record.recoveryId,
    }).then((result) => {
      recoveryModeRef.current = false;
      recoveryLandingRef.current = undefined;
      clearRecoveryLandingTimeout();
      latestAgentCheckpointRef.current = undefined;
      recoveryIdentityRef.current = undefined;
      setRecoveryIdentity(undefined);
      acceptRecoveryResult(result);
    });
  }, [acceptRecoveryResult, clearRecoveryLandingTimeout]);

  const isStage3InputLive = useCallback((input: Stage3HostAdapterInput): boolean => {
    const liveSession = liveSessionRef.current;
    const liveCue = liveCueRef.current;
    return !userTookOverRef.current &&
      replayHashRef.current === input.demoContentHash &&
      liveSession?.phase === "PAUSED_FOR_COACHING" &&
      liveSession.current_cue_id === input.cue.id &&
      liveSession.outcome_completion?.cueId === input.cue.id &&
      liveSession.outcome_completion.status === "COMPLETE" &&
      liveSession.outcome_completion.outcomeEndTick === input.outcomeGate.outcomeEndTick &&
      liveCue?.id === input.cue.id;
  }, []);

  if (!stage3ControllerRef.current) {
    stage3ControllerRef.current = new CoachAgentStage3Controller({
      adapter: stage3AdapterRef.current,
      dispatch: dispatchCoachAgentEvent,
      post: send,
      bridgeAvailable: () => Boolean(iframeRef.current?.contentWindow),
      isLive: isStage3InputLive,
      onState: setStage3State,
      onAgentResult: mirrorAgentResult,
      onToolLedgerTransition: persistToolTransition,
    });
  }

  const invalidateGuidedSeek = useCallback(() => {
    guidedSeekEpochRef.current += 1;
    guidedSeekGateRef.current = undefined;
  }, []);

  const markUserTookOver = useCallback(() => {
    invalidateGuidedSeek();
    stage2AckTimeoutRef.current.clear();
    stage2AdapterRef.current.cancel(generationRef.current);
    stage2PendingRef.current = undefined;
    void stage3ControllerRef.current?.takeover(stage3InputRef.current, "已由你接管，当前 Agent 工具已取消；基础回放仍可继续。", generationRef.current);
    if (stage2Status === "STARTING" || stage2Status === "FOCUSING" || stage2Status === "RESUMING") {
      setStage2Status("CANCELLED");
      setStage2Error("已由你接管，地图标注已取消；基础回放仍可继续。");
    }
    if (!userTookOverRef.current) send({ type: "setCamera", mode: "full" });
    userTookOverRef.current = true;
    setUserTookOver(true);
  }, [invalidateGuidedSeek, send, stage2Status]);

  const clearUserTakeover = useCallback(() => {
    invalidateGuidedSeek();
    userTookOverRef.current = false;
    setUserTookOver(false);
  }, [invalidateGuidedSeek]);

  const resumeGuidedRoute = useCallback(() => {
    const activePlan = planRef.current;
    const currentTick = playback?.canonicalTick;
    if (activePlan && currentTick !== undefined && Number.isFinite(currentTick)) {
      setSession((current) => current
        ? reduceCoachingSession(activePlan, current, {
            type: "RETURN_TO_NEAREST_CUE",
            tick: currentTick
          })
        : current);
    }
    clearUserTakeover();
    if (stage3Mode && stage3InputRef.current) {
      void stage3ControllerRef.current?.resumeAfterTakeover(stage3InputRef.current);
    }
  }, [clearUserTakeover, playback?.canonicalTick, stage3Mode]);

  const issueUserCommand = useCallback((command: PlaybackCommand) => {
    if (session) markUserTookOver();
    send(command);
  }, [markUserTookOver, send, session]);

  const seekFromTimeline = useCallback((canonicalTick: number) => {
    if (session) markUserTookOver();
    send({ type: "pause" });
    send({
      type: "seekCanonicalTick",
      canonicalTick: clampCanonicalTick(canonicalTick, tickMin, tickMax)
    });
  }, [markUserTookOver, send, session, tickMax, tickMin]);

  const seekBySeconds = useCallback((seconds: number) => {
    if (!replay) return;
    seekFromTimeline(seekCanonicalBySeconds(tick, seconds, replay.tickRate, tickMin, tickMax));
  }, [replay, seekFromTimeline, tick, tickMax, tickMin]);

  const updateTimelineHorizontalZoom = useCallback((value: number) => {
    if (!Number.isFinite(value)) return;
    setTimelineHorizontalZoom(Math.min(
      TIMELINE_HORIZONTAL_ZOOM_MAX,
      Math.max(TIMELINE_HORIZONTAL_ZOOM_MIN, value),
    ));
  }, []);

  const updateWinRateVerticalZoom = useCallback((value: number) => {
    if (!Number.isFinite(value)) return;
    setWinRateVerticalZoom(Math.min(
      WIN_RATE_VERTICAL_ZOOM_MAX,
      Math.max(WIN_RATE_VERTICAL_ZOOM_MIN, value),
    ));
  }, []);

  // Keep the current playhead in view when the shared A+B canvas grows. The
  // user can still scroll the viewport manually afterwards; playback itself
  // does not constantly fight that scroll position.
  useEffect(() => {
    const viewport = timelineViewportRef.current;
    const content = timelineContentRef.current;
    if (!viewport || !content) return;
    if (timelineHorizontalZoom <= TIMELINE_HORIZONTAL_ZOOM_MIN) {
      viewport.scrollLeft = 0;
      return;
    }
    const playheadPercent = timelinePercent(tick, tickMin, tickMax);
    const currentX = (playheadPercent / 100) * content.scrollWidth;
    const maxScroll = Math.max(0, content.scrollWidth - viewport.clientWidth);
    viewport.scrollLeft = Math.min(maxScroll, Math.max(0, currentX - viewport.clientWidth / 2));
  }, [timelineHorizontalZoom]);

  const canonicalTickFromPointer = useCallback((clientX: number): number | undefined => {
    const rail = timelineRailRef.current;
    if (!rail || !replay) return undefined;
    const bounds = rail.getBoundingClientRect();
    const ratio = bounds.width > 0
      ? Math.min(1, Math.max(0, (clientX - bounds.left) / bounds.width))
      : 0;
    return clampCanonicalTick(tickMin + ratio * (tickMax - tickMin), tickMin, tickMax);
  }, [replay, tickMax, tickMin]);

  const onTimelinePointerDown = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    if (!replay || (event.target as HTMLElement).closest("button")) return;
    const canonicalTick = canonicalTickFromPointer(event.clientX);
    if (canonicalTick === undefined) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    if (session) markUserTookOver();
    send({ type: "pause" });
    send({ type: "seekCanonicalTick", canonicalTick });
  }, [canonicalTickFromPointer, markUserTookOver, replay, send, session]);

  const onTimelinePointerMove = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    if (!event.currentTarget.hasPointerCapture(event.pointerId)) return;
    const canonicalTick = canonicalTickFromPointer(event.clientX);
    if (canonicalTick !== undefined) send({ type: "seekCanonicalTick", canonicalTick });
  }, [canonicalTickFromPointer, send]);

  const onTimelinePointerUp = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  }, []);

  const onTimelineViewportPointerDown = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || timelineHorizontalZoom <= TIMELINE_HORIZONTAL_ZOOM_MIN) return;
    const target = event.target as HTMLElement;
    // The A rail owns its drag gesture (seek). Buttons and form controls must
    // remain ordinary controls; the B chart and empty canvas area pan instead.
    if (target.closest("button, input, .cs2d-timeline-rail")) return;
    const viewport = event.currentTarget;
    timelinePanRef.current = {
      pointerId: event.pointerId,
      startClientX: event.clientX,
      startScrollLeft: viewport.scrollLeft,
    };
    viewport.setPointerCapture(event.pointerId);
    setTimelinePanning(true);
  }, [timelineHorizontalZoom]);

  const onTimelineViewportPointerMove = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    const pan = timelinePanRef.current;
    if (!pan || pan.pointerId !== event.pointerId) return;
    event.preventDefault();
    event.currentTarget.scrollLeft = pan.startScrollLeft - (event.clientX - pan.startClientX);
  }, []);

  const onTimelineViewportPointerUp = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    const pan = timelinePanRef.current;
    if (!pan || pan.pointerId !== event.pointerId) return;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    timelinePanRef.current = undefined;
    setTimelinePanning(false);
  }, []);

  const resetAnalysis = useCallback(() => {
    clearRecoveryLandingTimeout();
    recoveryLandingRef.current = undefined;
    invalidateGeneration();
    invalidateGuidedSeek();
    planRef.current = undefined;
    setSelected(undefined);
    setBundle(undefined);
    setPlan(undefined);
    routeStateRef.current = undefined;
    setRouteState(undefined);
    setNarrationByCue({});
    setSession(undefined);
    setAnalysisError(undefined);
    setAnalysisProgress(undefined);
    setReviewPreparationStatus(undefined);
    setAnalysisTelemetry(undefined);
    setTimelineHorizontalZoom(1);
    setWinRateVerticalZoom(1);
    timelinePanRef.current = undefined;
    setTimelinePanning(false);
    userTookOverRef.current = false;
    setUserTookOver(false);
  }, [clearRecoveryLandingTimeout, invalidateGeneration, invalidateGuidedSeek]);

  useEffect(() => () => {
    clearRecoveryLandingTimeout();
    invalidateGeneration();
  }, [clearRecoveryLandingTimeout, invalidateGeneration]);

  const handleRecoveryReplayReady = useCallback((payload: ReplayReadyEvent) => {
    const runtime = recoveryRuntimeRef.current;
    const record = recoveryRecordRef.current;
    if (!runtime || !record || !recoveryModeRef.current) return false;
    recoveryHandshakeReadyRef.current = false;
    if (!payload.demoContentHash) {
      void runtime.dispatch({
        type: "RECOVERY_HANDSHAKE_FAILED",
        eventId: recoveryEventId("recovery-hash-missing"),
        recoveryId: record.recoveryId,
        reason: "当前 Demo 没有可验证内容哈希；基础回放仍可继续。",
        degraded: false,
      }).then(acceptRecoveryResult);
      return true;
    }
    void runtime.dispatch({
      type: "REPLAY_READY",
      eventId: recoveryEventId("recovery-replay-ready"),
      recoveryId: record.recoveryId,
      replayAvailability: "READY",
      demoContentHash: payload.demoContentHash,
      availablePlayerIds: payload.players.map((player) => player.playerId),
    }).then((result) => {
      acceptRecoveryResult(result);
      const select = result.effects.find((effect) => effect.type === "SELECT_PLAYER");
      if (select?.type === "SELECT_PLAYER") send({ type: "selectPlayer", playerId: select.playerId });
    });
    return true;
  }, [acceptRecoveryResult, send]);

  const startRecoveryNarrationQueue = useCallback((landing: RecoveryLanding, analysis: Cs2dAnalysisBundle) => {
    const dependencies = createRecoveryReviewPreparationDependencies(analysis, landing.record);
    const generation = generationRef.current;
    const generationId = `recovery-narration-${landing.record.recoveryId}-${generation}`;
    const preparation = createReviewPreparationOrchestrator(
      generationId,
      landing.staged.plan,
      {
        narrationByCue: landing.staged.narrationByCue,
        readiness: landing.staged.routeState.readiness,
        skipCueIds: landing.record.cueProgress.consumedCueIds,
      },
      dependencies,
    );
    preparationRef.current?.cancel();
    preparationRef.current = preparation;
    void preparation.run((event) => {
      if (event.generationId !== generationId || generationRef.current !== generation) return;
      if (event.type === "NARRATION_UPDATE") {
        const recoveredRouteState = {
          ...event.routeState,
          consumedCueIds: landing.staged.routeState.consumedCueIds,
        };
        routeStateRef.current = recoveredRouteState;
        setRouteState(recoveredRouteState);
        const nextNarration = { ...narrationByCueRef.current, [event.cueId]: event.result.narration };
        narrationByCueRef.current = nextNarration;
        setNarrationByCue(nextNarration);
        setSession((current) => current
          ? reduceCoachingSession(landing.staged.plan, current, {
              type: "NARRATION_READY",
              cueId: event.cueId,
              readiness: event.result.readiness,
            })
          : current);
        return;
      }
      if (event.type === "NARRATION_REJECTED") {
        setReviewPreparationStatus({ phase: "ERROR", detail: `后续讲解准备失败：${event.reason.slice(0, 200)}` });
      }
    });
  }, []);

  const completeRecoveryLanding = useCallback(async (landing: RecoveryLanding) => {
    const runtime = recoveryRuntimeRef.current;
    if (!runtime) return;
    try {
      let currentRecord = recoveryRecordRef.current ?? landing.record;
      if (!shouldReconnectRecoveryAgent(currentRecord) && !isPreAgentRouteStartRecovery(currentRecord)) {
        recoveryHandshakeReadyRef.current = false;
        setSession(landing.staged.session);
        const failed = await runtime.dispatch({
          type: "RECOVERY_HANDSHAKE_FAILED",
          eventId: recoveryEventId("recovery-agent-checkpoint-missing"),
          recoveryId: currentRecord.recoveryId,
          reason: "Agent状态未协调；基础回放仍可继续。",
          degraded: true,
        });
        acceptRecoveryResult(failed);
        setReviewPreparationStatus({ phase: "ERROR", detail: "Agent状态未协调；基础回放仍可继续。" });
        return;
      }
      if (shouldReconnectRecoveryAgent(currentRecord)) {
        const reconnect = buildReconnectReplayEvent(currentRecord);
        const agent = await stage3ControllerRef.current!.reconnect(reconnect);
        if (agent.status === "DORMANT" || agent.restored !== "MATCHED") throw new Error("Agent checkpoint 与恢复记录不匹配。");
        latestAgentCheckpointRef.current = {
          checkpointId: agent.checkpoint.checkpointId,
          activeCueId: agent.state.activeCueId,
          currentSessionPhase: agent.state.currentSessionPhase,
          routeCursor: agent.state.routeCursor,
          sessionStatus: agent.state.sessionStatus,
        };
        const reconciled = reconciledRecoveryLedger(currentRecord);
        if (reconciled) {
          const ledgerResult = await runtime.dispatch({
            type: "TOOL_LEDGER_UPDATED",
            eventId: recoveryEventId("recovery-tool-reconciled"),
            recoveryId: currentRecord.recoveryId,
            entry: reconciled,
            agentCheckpointId: agent.checkpoint.checkpointId,
            updatedAt: Date.now(),
          });
          acceptRecoveryResult(ledgerResult);
          currentRecord = ledgerResult.record ?? currentRecord;
        } else {
          const checkpointResult = await runtime.dispatch({
            type: "STABLE_BOUNDARY_REACHED",
            eventId: recoveryEventId("recovery-reconnect-checkpoint"),
            recoveryId: currentRecord.recoveryId,
            boundary: currentRecord.boundary,
            cueProgress: currentRecord.cueProgress,
            routeReadiness: currentRecord.routeReadiness,
            narrationArtifacts: currentRecord.narrationArtifacts,
            agentCheckpointId: agent.checkpoint.checkpointId,
            updatedAt: Date.now(),
          });
          acceptRecoveryResult(checkpointResult);
          currentRecord = checkpointResult.record ?? currentRecord;
        }
      }
      const completed = await runtime.dispatch({
        type: "RECOVERY_HANDSHAKE_COMPLETED",
        eventId: recoveryEventId("recovery-handshake-complete"),
        recoveryId: currentRecord.recoveryId,
      });
      acceptRecoveryResult(completed);
      recoveryModeRef.current = false;
      recoveryHandshakeReadyRef.current = true;
      if (landing.record.boundary.kind === "CUE_PAUSED") {
        stage3ControllerRef.current?.adoptRecoveredCue(
          landing.record.boundary.cueId,
          landing.record.boundary.segmentIndex,
        );
      }
      setSession(landing.record.boundary.kind === "ROUTE_START"
        ? reduceCoachingSession(landing.staged.plan, landing.staged.session, { type: "START" })
        : landing.staged.session);
      setReviewPreparationStatus({ phase: "READY", detail: "已恢复到最近教学点，后续讲解在后台继续准备。" });
      startRecoveryNarrationQueue({ ...landing, record: currentRecord }, landing.analysis);
    } catch (error) {
      recoveryHandshakeReadyRef.current = false;
      setSession(landing.staged.session);
      const reason = error instanceof Error ? error.message.slice(0, 180) : "Agent 恢复失败；基础回放仍可继续。";
      const failed = await runtime.dispatch({
        type: "RECOVERY_HANDSHAKE_FAILED",
        eventId: recoveryEventId("recovery-handshake-failed"),
        recoveryId: landing.record.recoveryId,
        reason,
        degraded: true,
      });
      acceptRecoveryResult(failed);
      setReviewPreparationStatus({ phase: "ERROR", detail: "Agent 状态未恢复；基础回放仍可继续。" });
    }
  }, [acceptRecoveryResult, startRecoveryNarrationQueue]);

  const handleRecoveryAnalysisReady = useCallback((payload: Extract<PlaybackBridgeEvent, { type: "ANALYSIS_READY" }>) => {
    const runtime = recoveryRuntimeRef.current;
    const record = recoveryRecordRef.current;
    const replayHash = replayHashRef.current;
    if (!runtime || !record || !recoveryModeRef.current || !replayHash) return false;
    try {
      const rebuilt = deserializeCs2dAnalysisBundle(payload.bundleJson);
      const normalized = normalizeRecoveryAnalysis(rebuilt, record);
      const staged = restoreRecoveryArtifacts(record);
      void runtime.dispatch({
        type: "ANALYSIS_READY",
        eventId: recoveryEventId("recovery-analysis-ready"),
        recoveryId: record.recoveryId,
        demoContentHash: replayHash,
        selectedPlayerId: payload.selectedPlayerId,
        routeId: record.routeId,
        routeHash: record.routeHash,
        versions: {
          parser: rebuilt.review_plan.generation_manifest.parser_version,
          analysisAdapter: rebuilt.metadata.adapter_version,
          planner: rebuilt.review_plan.planner_version,
        },
      }).then((result) => {
        acceptRecoveryResult(result);
        if (result.status === "REJECTED") return;
        const boundary = record.boundary;
        const targetTick = boundary.kind === "CUE_PAUSED"
          ? staged.plan.cues.find((cue) => cue.id === boundary.cueId)!.decision_tick
          : boundary.kind === "WRAP_UP"
            ? staged.plan.segments.at(-1)?.end_tick ?? 0
            : staged.plan.segments[0]?.start_tick ?? 0;
        const landing: RecoveryLanding = { recoveryId: record.recoveryId, targetTick, staged, record, analysis: normalized };
        recoveryLandingRef.current = landing;
        clearRecoveryLandingTimeout();
        recoveryLandingTimeoutRef.current = setTimeout(() => {
          if (recoveryLandingRef.current !== landing) return;
          recoveryLandingRef.current = undefined;
          recoveryLandingTimeoutRef.current = undefined;
          recoveryHandshakeReadyRef.current = false;
          planRef.current = undefined;
          routeStateRef.current = undefined;
          setPlan(undefined);
          setRouteState(undefined);
          setNarrationByCue({});
          setSession(undefined);
          setReviewPreparationStatus({ phase: "ERROR", detail: "回放未能落到恢复位置；基础回放仍可继续。" });
          void runtime.dispatch({
            type: "RECOVERY_HANDSHAKE_FAILED",
            eventId: recoveryEventId("recovery-landing-timeout"),
            recoveryId: record.recoveryId,
            reason: "PLAYBACK_LANDING_TIMEOUT",
            degraded: true,
          }).then(acceptRecoveryResult);
        }, 10_000);
        bundleRef.current = normalized;
        planRef.current = staged.plan;
        routeStateRef.current = staged.routeState;
        setBundle(normalized);
        setPlan(staged.plan);
        setRouteState(staged.routeState);
        setNarrationByCue(staged.narrationByCue);
        setAnalysisError(undefined);
        setAnalysisProgress(undefined);
        setReviewPreparationStatus({ phase: "NARRATION", detail: "冻结路线已验证，正在回到最近教学点。" });
        send({ type: "pause" });
        send({ type: "seekCanonicalTick", canonicalTick: targetTick });
      });
    } catch (error) {
      const reason = error instanceof Error ? error.message.slice(0, 180) : "恢复分析校验失败。";
      void runtime.dispatch({
        type: "RECOVERY_HANDSHAKE_FAILED",
        eventId: recoveryEventId("recovery-analysis-rejected"),
        recoveryId: record.recoveryId,
        reason,
        degraded: false,
      }).then(acceptRecoveryResult);
      setAnalysisError(reason);
    }
    return true;
  }, [acceptRecoveryResult, clearRecoveryLandingTimeout, send]);

  useEffect(() => {
    const onMessage = (event: MessageEvent<unknown>) => {
      const envelope = acceptedPlaybackEvent({
        data: event.data,
        eventOrigin: event.origin,
        expectedOrigin: config.origin,
        sourceMatches: event.source === iframeRef.current?.contentWindow
      });
      if (!envelope) return;
      const payload: PlaybackBridgeEvent = envelope.payload;

      if (payload.type === "REPLAY_READY") {
        selectedPlayerIdRef.current = undefined;
        setReplay(payload);
        setPlayback(undefined);
        resetAnalysis();
        setPhase("READY");
        handleRecoveryReplayReady(payload);
        return;
      }
      if (payload.type === "PLAYER_SELECTED") {
        selectedPlayerIdRef.current = payload.playerId;
        invalidateGeneration();
        invalidateGuidedSeek();
        planRef.current = undefined;
        routeStateRef.current = undefined;
        setBundle(undefined);
        setPlan(undefined);
        setRouteState(undefined);
        setNarrationByCue({});
        setSession(undefined);
        setAnalysisError(undefined);
        setAnalysisProgress(undefined);
        setReviewPreparationStatus(undefined);
        setAnalysisTelemetry(undefined);
        userTookOverRef.current = false;
        setUserTookOver(false);
        setSelected(payload);
        return;
      }
      if (payload.type === "ANALYSIS_PROGRESS") {
        if (!analysisEventMatchesSelectedPlayer(selectedPlayerIdRef.current, payload.selectedPlayerId)) return;
        setAnalysisProgress(payload);
        return;
      }
      if (payload.type === "ANALYSIS_TELEMETRY") {
        if (!analysisEventMatchesSelectedPlayer(selectedPlayerIdRef.current, payload.selectedPlayerId)) return;
        setAnalysisTelemetry(payload.telemetry);
        return;
      }
      if (payload.type === "ANALYSIS_FAILED") {
        if (!analysisEventMatchesSelectedPlayer(selectedPlayerIdRef.current, payload.selectedPlayerId)) return;
        invalidateGeneration();
        invalidateGuidedSeek();
        setAnalysisError(payload.message);
        setAnalysisProgress(undefined);
        setBundle(undefined);
        setPlan(undefined);
        routeStateRef.current = undefined;
        setRouteState(undefined);
        setNarrationByCue({});
        setSession(undefined);
        planRef.current = undefined;
        setReviewPreparationStatus(undefined);
        userTookOverRef.current = false;
        setUserTookOver(false);
        return;
      }
      if (payload.type === "ANALYSIS_READY") {
        if (!analysisEventMatchesSelectedPlayer(selectedPlayerIdRef.current, payload.selectedPlayerId)) return;
        if (handleRecoveryAnalysisReady(payload)) return;
        invalidateGeneration();
        invalidateGuidedSeek();
        try {
          const nextBundle = deserializeCs2dAnalysisBundle(payload.bundleJson);
          if (
            nextBundle.selected_steam_id !== payload.selectedPlayerId ||
            !analysisEventMatchesSelectedPlayer(selectedPlayerIdRef.current, nextBundle.selected_steam_id)
          ) {
            throw new Error("分析结果与所选玩家不一致。");
          }
          const adapterPlan = nextBundle.review_plan;
          // The adapter plan is route input only.  The Host does not expose
          // it as frozen playback state until the injected Director →
          // Compiler seam returns the final immutable route.
          planRef.current = undefined;
          setBundle(nextBundle);
          setPlan(undefined);
          // Narration is produced by the injected Narrator adapter after the
          // route is frozen.  A legacy cue.narration field must not bypass
          // that seam or make the first window falsely startable.
          const preparedNarration: Readonly<Record<string, NarrationBundle>> = {};
          setNarrationByCue(preparedNarration);
          setAnalysisError(undefined);
          setAnalysisProgress(undefined);
          setReviewPreparationStatus(undefined);
          setAnalysisTelemetry(undefined);
          userTookOverRef.current = false;
          setUserTookOver(false);
          if (nextBundle.candidate_set.status === "FAILED") {
            setAnalysisError(`候选索引未完成：${nextBundle.candidate_set.failureReason ?? "请重新选择 Demo 或玩家。"}`);
            setReviewPreparationStatus({
              phase: "ERROR",
              detail: "基础回放仍可用；教学路线等待候选索引恢复。"
            });
            return;
          }
          const preparationDependencies = reviewPreparationDependencies ?? createCs2dReviewPreparationDependencies({
            candidateSet: nextBundle.candidate_set,
            observationEvidence: nextBundle.observation_evidence,
            matchTimeline: nextBundle.match_timeline,
            winProbabilityTimeline: nextBundle.win_probability_timeline,
            selectedPlayerId: nextBundle.selected_steam_id
          });
          setReviewPreparationStatus({ phase: "ROUTE", detail: "正在由 Director 和 PlanCompiler 冻结教学路线。" });
          const generationId = String(generationRef.current);
          const preparation = createReviewPreparationOrchestrator(
            generationId,
            adapterPlan,
            { narrationByCue: preparedNarration },
            preparationDependencies
          );
          preparationRef.current = preparation;
          setSession(undefined);
          void preparation.run((preparationEvent) => {
            if (preparationEvent.generationId !== String(generationRef.current)) return;
            if (preparationEvent.type === "ROUTE_FROZEN") {
              planRef.current = preparationEvent.plan;
              setPlan(preparationEvent.plan);
              routeStateRef.current = preparationEvent.routeState;
              setRouteState(preparationEvent.routeState);
              setReviewPreparationStatus({
                phase: "NARRATION",
                detail: preparationEvent.plan.cues.length > 0
                  ? "教学路线已冻结，正在准备前两个讲解点。"
                  : "教学路线已冻结，本场没有候选讲解点。"
              });
              return;
            }
            if (preparationEvent.type === "NARRATION_UPDATE") {
              routeStateRef.current = preparationEvent.routeState;
              setRouteState(preparationEvent.routeState);
              const nextNarration = { ...narrationByCueRef.current, [preparationEvent.cueId]: preparationEvent.result.narration };
              narrationByCueRef.current = nextNarration;
              setNarrationByCue(nextNarration);
              const finalPlan = planRef.current;
              const readyCount = Object.values(preparationEvent.routeState.readiness).filter((value) => value !== "PENDING").length;
              setReviewPreparationStatus({
                phase: "NARRATION",
                detail: `教学路线已冻结，已准备 ${readyCount}/${preparationEvent.routeState.selectedCueCount} 个讲解包。`
              });
              if (finalPlan) {
                setSession((current) => current
                  ? reduceCoachingSession(finalPlan, current, {
                      type: "NARRATION_READY",
                      cueId: preparationEvent.cueId,
                      readiness: preparationEvent.result.readiness
                    })
                  : current);
              }
              return;
            }
            if (preparationEvent.type === "NARRATION_REJECTED") {
              routeStateRef.current = preparationEvent.routeState;
              setRouteState(preparationEvent.routeState);
              setReviewPreparationStatus({
                phase: "ERROR",
                detail: `教学路线准备失败：${preparationEvent.reason.slice(0, 240)}`
              });
              return;
            }
            if (preparationEvent.type === "READY_TO_START") {
              planRef.current = preparationEvent.plan;
              setPlan(preparationEvent.plan);
              routeStateRef.current = preparationEvent.routeState;
              setRouteState(preparationEvent.routeState);
              setAnalysisProgress(undefined);
              setReviewPreparationStatus({ phase: "READY", detail: "教学路线与前两个讲解包已就绪。" });
              const identity = createRecoverySessionIdentity();
              recoveryIdentityRef.current = identity;
              setRecoveryIdentity(identity);
              recoveryModeRef.current = false;
              recoveryHandshakeReadyRef.current = true;
              latestAgentCheckpointRef.current = undefined;
              const initialSession = createCoachingSession(
                preparationEvent.plan,
                identity.sessionId,
                preparationEvent.routeState,
              );
              const record = buildSessionRecoveryRecord({
                identity,
                demoContentHash: nextBundle.metadata.demo_content_hash ?? replayHashRef.current ?? "",
                selectedPlayerId: nextBundle.selected_steam_id,
                plan: preparationEvent.plan,
                routeState: preparationEvent.routeState,
                session: initialSession,
                boundaryKind: "ROUTE_START",
                narrationByCue: narrationByCueRef.current,
                analysis: nextBundle,
                agentCheckpointId: null,
              });
              recoveryRecordRef.current = record;
              const startSession = () => setSession(reduceCoachingSession(
                preparationEvent.plan,
                initialSession,
                { type: "START" },
              ));
              const runtime = recoveryRuntimeRef.current;
              if (!runtime) {
                startSession();
                return;
              }
              void runtime.dispatch({
                type: "SESSION_STARTED",
                eventId: recoveryEventId("recovery-session-started"),
                record,
              }).then((result) => {
                acceptRecoveryResult(result);
                startSession();
              });
            }
          });
        } catch (error) {
          setAnalysisError(error instanceof Error ? error.message : "分析结果校验失败。");
          setReviewPreparationStatus({ phase: "ERROR", detail: "教学路线输入校验失败。" });
        }
        return;
      }
      if (payload.type === "TEACHING_TOOL_ACK") {
        if (stage3Mode) {
          stage3ControllerRef.current?.acceptAck(payload);
          return;
        }
        const pending = stage2PendingRef.current;
        if (!stage2Mode || !pending || pending.generation !== generationRef.current) return;
        const liveSession = liveSessionRef.current;
        const liveCue = liveCueRef.current;
        if (
          !liveSession ||
          liveSession.phase !== "PAUSED_FOR_COACHING" ||
          liveSession.current_cue_id !== pending.cueId ||
          liveSession.outcome_completion?.cueId !== pending.cueId ||
          liveSession.outcome_completion.status !== "COMPLETE" ||
          liveCue?.id !== pending.cueId
        ) {
          stage2PendingRef.current = undefined;
          stage2AckTimeoutRef.current.clear();
          stage2AdapterRef.current.cancel(pending.generation);
          setStage2Status("FAILED");
          setStage2Error("当前讲解状态已变化，地图标注已取消；基础回放仍可继续。");
          return;
        }
        try {
          const toolResult = stage2AdapterRef.current.acceptTeachingToolAck(
            pending.request,
            payload,
            pending.context,
          );
          if (!toolResult) return;
          stage2AckTimeoutRef.current.clear();
          const resume = stage2AdapterRef.current.createResumeEvent(
            pending.request,
            toolResult,
            pending.context,
            `stage2-resume-${pending.cueId}-${pending.generation}`.slice(0, 160),
          );
          if (!resume) return;
          stage2PendingRef.current = undefined;
          setStage2Status("RESUMING");
          void dispatchCoachAgentEvent(resume).then((result) => {
            if (generationRef.current !== pending.generation || !stage2AdapterRef.current.isCurrent(pending.generation)) return;
            if (result.status === "COMPLETED") {
              setStage2Status("COMPLETED");
              setStage2Error(undefined);
            } else {
              setStage2Status("FAILED");
              setStage2Error("地图标注未完成；基础回放仍可继续。");
            }
          }).catch((error) => {
            if (generationRef.current !== pending.generation || !stage2AdapterRef.current.isCurrent(pending.generation)) return;
            setStage2Status("FAILED");
            setStage2Error(error instanceof Error ? error.message.slice(0, 160) : "地图标注未完成；基础回放仍可继续。");
          });
        } catch (error) {
          stage2PendingRef.current = undefined;
          setStage2Status("FAILED");
          setStage2Error(error instanceof Error ? error.message.slice(0, 160) : "地图标注校验失败；基础回放仍可继续。");
        }
        return;
      }

      const pendingSeek = guidedSeekGateRef.current;
      if (pendingSeek) {
        if (pendingSeek.epoch !== guidedSeekEpochRef.current || !isGuidedSeekLanding(pendingSeek, payload.canonicalTick)) {
          // A PLAYBACK_STATE emitted before the iframe applies our seek is
          // still the old position. Keep it out of both the UI and reducer.
          return;
        }
        guidedSeekGateRef.current = undefined;
      }
      const recoveryLanding = recoveryLandingRef.current;
      if (recoveryLanding) {
        const tolerance = Math.max(1, Math.round((replay?.tickRate ?? 64) / 64));
        if (Math.abs(payload.canonicalTick - recoveryLanding.targetTick) > tolerance || payload.playing) return;
        recoveryLandingRef.current = undefined;
        clearRecoveryLandingTimeout();
        setPlayback(payload);
        void completeRecoveryLanding(recoveryLanding);
        return;
      }
      setPlayback(payload);
      if (userTookOverRef.current) return;
      const activePlan = planRef.current;
      if (!activePlan) return;
      setSession((current) => {
        if (!current || !["PLAYING", "REVEALING", "REPLAYING"].includes(current.phase)) return current;
        return reduceCoachingSession(activePlan, current, {
          type: "TICK",
          tick: payload.canonicalTick
        });
      });
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [clearRecoveryLandingTimeout, completeRecoveryLanding, config.origin, handleRecoveryAnalysisReady, handleRecoveryReplayReady, invalidateGeneration, invalidateGuidedSeek, replay?.tickRate, resetAnalysis, reviewPreparationDependencies, stage2Mode, stage3Mode]);

  const transition = useCallback((action: SessionAction) => {
    const activePlan = planRef.current;
    if (!activePlan) return;
    clearUserTakeover();
    setSession((current) => current ? reduceCoachingSession(activePlan, current, action) : current);
  }, [clearUserTakeover]);

  const transitionKey = session ? guidedTransitionKey(session) : "idle";
  useEffect(() => {
    const activePlan = planRef.current;
    if (!activePlan || !session || !playback || userTookOverRef.current) return;
    const directive = guidedPlaybackDirective(activePlan, session, replay?.tickRate);
    const seek = directive.commands.find((command): command is Extract<PlaybackCommand, { type: "seekCanonicalTick" }> => command.type === "seekCanonicalTick");
    if (seek) {
      const epoch = guidedSeekEpochRef.current + 1;
      guidedSeekEpochRef.current = epoch;
      guidedSeekGateRef.current = createGuidedSeekGate(epoch, seek.canonicalTick, replay?.tickRate);
    }
    directive.commands.forEach(send);
    if (directive.automaticAction) {
      setSession((current) => current
        ? reduceCoachingSession(activePlan, current, directive.automaticAction!)
        : current);
    }
  }, [playback !== undefined, replay?.tickRate, send, transitionKey, userTookOver]);

  const activePlan = plan ?? bundle?.review_plan;
  const segment = activePlan && session ? getCurrentSegment(activePlan, session) : undefined;
  const cue = activePlan && session ? getCurrentCue(activePlan, session) : undefined;
  const cueRevealed = Boolean(cue && session?.revealed_cue_ids.includes(cue.id));
  const coachingView = hostCoachingCueSurface(cue, session?.phase, session?.outcome_completion, cue ? narrationByCue[cue.id] : undefined);
  const presentableNarration = coachingView?.narration;
  const outcomeImpact = cue && bundle?.outcome_impacts.find((impact) => impact.cueId === cue.id);
  const candidateMaterial = cue?.candidate_id
    ? bundle?.candidate_set.materials.find((material) => material.candidateId === cue.candidate_id)
    : undefined;
  const decisionPlayerState = cue && selected
    ? playerStateAtOrBefore(bundle?.match_timeline.player_state_tracks ?? [], selected.playerId, cue.decision_tick)
    : undefined;
  const threeStageCoaching = presentableNarration && coachingView
    ? buildThreeStageCoachingView({
        narration: presentableNarration,
        decisionState: decisionPlayerState,
        callout: candidateMaterial?.callout,
        outcomeFacts: coachingView.outcomeFacts,
        outcomeImpact
      })
    : undefined;
  const summary = useMemo(() => {
    if (!activePlan || !session || !["WRAP_UP", "COMPLETED"].includes(session.phase)) return undefined;
    try {
      return buildSessionSummary(activePlan, session);
    } catch {
      return undefined;
    }
  }, [activePlan, session]);

  const sessionProgress = activePlan && session
    ? coachingCueProgress(activePlan, session.current_segment_index, session.current_cue_id)
    : undefined;
  const positionLabel = playbackPositionLabel(playback, replay);
  const freeViewPosition = reviewPositionAtTick(playback, replay, activePlan);
  const timelineSegments = activePlan?.segments.map((planSegment) => {
    const range = timelineRange(planSegment.start_tick, planSegment.end_tick, tickMin, tickMax);
    return { planSegment, ...range };
  }) ?? [];
  const timelineRounds = replay?.rounds.map((round) => ({
    round,
    ...timelineRange(round.startCanonicalTick, round.endCanonicalTick, tickMin, tickMax)
  })) ?? [];
  const currentPercent = timelinePercent(tick, tickMin, tickMax);
  const currentRound = replay?.rounds[currentRoundIndex];
  const currentRoundLabel = currentRound
    ? currentRound.roundNumber === 0 ? "准备阶段" : `第 ${currentRound.roundNumber} 回合`
    : "未开始";
  const winRateTimeline = bundle?.win_probability_timeline;
  const winRateCurve = useMemo(() => {
    if (!winRateTimeline || winRateTimeline.status !== "AVAILABLE") return undefined;
    const economyLabel = (value: (typeof winRateTimeline.rounds)[number]["economy"]["ct"]): string => {
      if (value === "PISTOL") return "手枪局";
      if (value === "ECO") return "ECO";
      if (value === "FORCE") return "强起";
      if (value === "FULL") return "长枪局";
      return "经济未知";
    };
    const selectedPlayerId = selected?.playerId;
    const stateTrack = bundle?.match_timeline.player_state_tracks ?? [];
    const sideAt = (sampleTick: number): "CT" | "T" => {
      let side: "CT" | "T" = selected?.side ?? "T";
      for (const state of stateTrack) {
        if (state.player_id !== selectedPlayerId || state.tick > sampleTick) continue;
        side = state.side;
      }
      return side;
    };
    const raw = winRateTimeline.rounds.flatMap((round) => [
      ...round.samples,
      ...(round.terminal ? [{ tick: round.terminal.tick, probability: round.terminal.probability, roundNumber: round.roundNumber, side: "CT" as const, source: "CS_NET" as const }] : [])
    ]).sort((left, right) => left.tick - right.tick);
    const points = raw.map((sample) => {
      const probability = sideAt(sample.tick) === "CT" ? sample.probability : 1 - sample.probability;
      return { ...sample, probability, x: timelinePercent(sample.tick, tickMin, tickMax), y: 100 - probability * 100 };
    });
    const rounds = winRateTimeline.rounds.map((round) => ({
      ...round,
      range: timelineRange(round.startTick, round.endTick, tickMin, tickMax),
      label: `第 ${round.roundNumber} 回合 · CT ${economyLabel(round.economy.ct)} · T ${economyLabel(round.economy.t)}`
    }));
    const swings = winRateTimeline.swings.map((swing) => ({
      ...swing,
      x: timelinePercent(swing.tick, tickMin, tickMax),
      y: 100 - (sideAt(swing.tick) === "CT" ? swing.after : 1 - swing.after) * 100
    }));
    return { points, rounds, swings };
  }, [bundle, selected, tickMax, tickMin, winRateTimeline]);
  const analysisProgressText = analysisProgress?.phase === "downloading"
    ? "正在下载胜率模型"
    : analysisProgress?.phase === "inference"
      ? "正在计算整场胜率"
      : analysisProgress?.phase === "unavailable"
        ? "胜率模型不可用，已使用基础教练路线"
        : undefined;
  const currentWinPoint = winRateCurve?.points.filter((point) => point.tick <= tick).at(-1);
  const stage2Cue = stage2Mode && activePlan && routeState
    ? selectFirstStage2Cue(activePlan, routeState)
    : undefined;
  const stage3Cue = stage3Mode && activePlan && routeState && cue && stage3EligibleCueIds(activePlan, routeState).includes(cue.id)
    ? cue
    : undefined;
  const stage2Busy = stage2Status === "STARTING" || stage2Status === "FOCUSING" || stage2Status === "RESUMING";
  const stage3Busy = stage3State.status === "STARTING" || stage3State.status === "FOCUSING" || stage3State.status === "RESUMING";
  const agentToolBusy = stage2Busy || stage3Busy;
  const stage3IdentityContext: Stage3IdentityInput | undefined = activePlan && routeState && replay?.demoContentHash && recoveryIdentity
    ? {
        plan: activePlan,
        routeState,
        analysis: {
          demo_id: bundle?.demo_id ?? activePlan.demo_id,
          selected_steam_id: bundle?.selected_steam_id ?? selected?.playerId ?? activePlan.player_id,
          metadata: bundle?.metadata,
        },
        demoContentHash: replay.demoContentHash,
        selectedPlayerId: selected?.playerId ?? activePlan.player_id,
        sessionId: recoveryIdentity.sessionId,
        runId: recoveryIdentity.runId,
      }
    : undefined;
  // Async Stage2 work must consult these refs immediately before postMessage or
  // remote resume; the PAUSED values captured when START began are not authority.
  replayHashRef.current = replay?.demoContentHash;
  bundleRef.current = bundle;
  narrationByCueRef.current = narrationByCue;
  recoveryIdentityRef.current = recoveryIdentity;
  liveSessionRef.current = session;
  liveCueRef.current = cue;

  useEffect(() => {
    const runtime = recoveryRuntimeRef.current;
    const current = recoveryRecordRef.current;
    if (!runtime || !current || !session || userTookOverRef.current) return;
    if (session.phase === "COMPLETED") {
      if (completedRecoveryRef.current === current.recoveryId) return;
      completedRecoveryRef.current = current.recoveryId;
      void runtime.dispatch({
        type: "SESSION_COMPLETED",
        eventId: recoveryEventId("recovery-session-completed"),
        recoveryId: current.recoveryId,
      }).then((result) => {
        latestAgentCheckpointRef.current = undefined;
        recoveryIdentityRef.current = undefined;
        setRecoveryIdentity(undefined);
        acceptRecoveryResult(result);
      });
      return;
    }
    const stable = currentStableRecoveryRecord(latestAgentCheckpointRef.current);
    if (!stable) return;
    const key = JSON.stringify([
      stable.boundary,
      stable.cueProgress,
      stable.routeReadiness,
      stable.narrationArtifacts.map((artifact) => [artifact.cueId, artifact.readiness, artifact.presentation]),
      stable.agentCheckpointId,
    ]);
    if (stableRecoveryKeyRef.current === key) return;
    stableRecoveryKeyRef.current = key;
    void runtime.dispatch({
      type: "STABLE_BOUNDARY_REACHED",
      eventId: recoveryEventId("recovery-stable-boundary"),
      recoveryId: current.recoveryId,
      boundary: stable.boundary,
      cueProgress: stable.cueProgress,
      routeReadiness: stable.routeReadiness,
      narrationArtifacts: stable.narrationArtifacts,
      agentCheckpointId: stable.agentCheckpointId,
      updatedAt: stable.updatedAt,
    }).then(acceptRecoveryResult);
  }, [acceptRecoveryResult, currentStableRecoveryRecord, narrationByCue, routeState, session, userTookOver]);

  useEffect(() => {
    if (!stage2Mode || !activePlan || !routeState || !session || !cue || !stage2Cue) return;
    if (stage2StartedCueRef.current === stage2Cue.id || stage2Cue.id !== cue.id) return;
    if (
      userTookOverRef.current ||
      session.phase !== "PAUSED_FOR_COACHING" ||
      !cueRevealed ||
      !presentableNarration ||
      !recoveryIdentity ||
      !recoveryHandshakeReadyRef.current ||
      !session.outcome_completion ||
      session.outcome_completion.status !== "COMPLETE"
    ) return;
    stage2StartedCueRef.current = stage2Cue.id;
    const generation = generationRef.current;
    if (!replay?.demoContentHash) {
      setStage2Status("FAILED");
      setStage2Error("当前 Demo 没有可验证内容哈希；基础回放仍可继续。");
      return;
    }
    const selectedIdentity = selected?.playerId ?? activePlan.player_id;
    const identityKey = `${replay.demoContentHash}:${activePlan.id}:${routeState.routeFingerprint}:${selectedIdentity}`;
    const identityToken = stableStage3IdentityToken(replay.demoContentHash, activePlan.id, routeState.routeFingerprint, selectedIdentity);
    const identity = stage2IdentityRef.current?.key === identityKey
      ? stage2IdentityRef.current
      : {
          key: identityKey,
          runId: `stage2-run-${identityToken}`,
          sessionId: `stage2-session-${identityToken}`,
        };
    stage2IdentityRef.current = identity;
    setStage2Status("STARTING");
    setStage2Error(undefined);
    try {
      const prepared = stage2AdapterRef.current.prepareStart({
        plan: activePlan,
        routeState,
        cue: stage2Cue,
        narration: presentableNarration,
        outcomeGate: session.outcome_completion,
        currentSessionPhase: "PAUSED_FOR_COACHING",
        analysis: {
          demo_id: bundle?.demo_id ?? activePlan.demo_id,
          selected_steam_id: bundle?.selected_steam_id ?? selected?.playerId ?? activePlan.player_id,
          metadata: bundle?.metadata,
        },
        demoContentHash: replay.demoContentHash,
        selectedPlayerId: selected?.playerId ?? activePlan.player_id,
        sessionId: identity.sessionId,
        runId: identity.runId,
        generation,
      });
      if (prepared.capabilities.length !== 1) {
        setStage2Status("FAILED");
        setStage2Error("当前 cue 没有可绑定的地图证据；基础回放仍可继续。");
        return;
      }
      void dispatchCoachAgentEvent(prepared.event).then((result) => {
        if (generationRef.current !== generation || userTookOverRef.current || !stage2AdapterRef.current.isCurrent(generation)) return;
        const request = result.effects[0];
        if (result.status !== "WAITING_TOOL" || !request) {
          setStage2Status("FAILED");
          setStage2Error("教练工具未进入等待状态；基础回放仍可继续。");
          return;
        }
        const context: Stage2ToolContext = {
          generation,
          currentSessionPhase: "PAUSED_FOR_COACHING",
          outcomeGate: session.outcome_completion!,
        };
        try {
          const liveSession = liveSessionRef.current;
          const liveCue = liveCueRef.current;
          if (
            !liveSession ||
            liveSession.phase !== "PAUSED_FOR_COACHING" ||
            liveSession.current_cue_id !== stage2Cue.id ||
            liveSession.outcome_completion?.cueId !== stage2Cue.id ||
            liveSession.outcome_completion.status !== "COMPLETE" ||
            liveCue?.id !== stage2Cue.id
          ) {
            stage2AdapterRef.current.cancel(generation);
            setStage2Status("FAILED");
            setStage2Error("当前讲解状态已变化，地图标注已取消；基础回放仍可继续。");
            return;
          }
          const command = stage2AdapterRef.current.createFocusMapCommand(request, context);
          if (!command) return;
          stage2PendingRef.current = { request, context, generation, cueId: stage2Cue.id };
          stage2AckTimeoutRef.current.arm(generation, (expiredGeneration) => {
            const pending = stage2PendingRef.current;
            if (
              !pending ||
              pending.generation !== expiredGeneration ||
              generationRef.current !== expiredGeneration ||
              !stage2AdapterRef.current.isCurrent(expiredGeneration)
            ) return;
            stage2PendingRef.current = undefined;
            stage2AdapterRef.current.cancel(expiredGeneration);
            setStage2Status("FAILED");
            setStage2Error("地图标注没有回应；基础回放仍可继续。");
          });
          setStage2Status("FOCUSING");
          if (generationRef.current !== generation || userTookOverRef.current || !stage2AdapterRef.current.isCurrent(generation)) return;
          send(command);
        } catch (error) {
          setStage2Status("FAILED");
          setStage2Error(error instanceof Error ? error.message.slice(0, 160) : "地图标注校验失败；基础回放仍可继续。");
        }
      }).catch((error) => {
        if (generationRef.current !== generation || userTookOverRef.current) return;
        setStage2Status("FAILED");
        setStage2Error(error instanceof Error ? error.message.slice(0, 160) : "教练工具不可用；基础回放仍可继续。");
      });
    } catch (error) {
      setStage2Status("FAILED");
      setStage2Error(error instanceof Error ? error.message.slice(0, 160) : "当前 cue 校验失败；基础回放仍可继续。");
    }
  }, [activePlan, bundle, cue, cueRevealed, presentableNarration, replay?.demoContentHash, routeState, selected?.playerId, send, session, stage2Cue, stage2Mode]);

  useEffect(() => {
    if (
      !stage3Mode ||
      stage2Mode ||
      !activePlan ||
      !routeState ||
      !session ||
      !cue ||
      !stage3Cue ||
      !presentableNarration ||
      !recoveryIdentity ||
      !recoveryHandshakeReadyRef.current ||
      !cueRevealed ||
      userTookOverRef.current ||
      session.phase !== "PAUSED_FOR_COACHING" ||
      !session.outcome_completion ||
      session.outcome_completion.status !== "COMPLETE" ||
      stage3ControllerRef.current?.hasStartedCue(cue.id)
    ) return;
    if (!replay?.demoContentHash) {
      if (!stage3BlockedCueRef.current.has(cue.id)) {
        stage3BlockedCueRef.current.add(cue.id);
        setStage3State({ status: "FAILED", cueId: cue.id, error: "当前 Demo 没有可验证内容哈希；基础回放仍可继续。" });
      }
      return;
    }
    const selectedIdentity = selected?.playerId ?? activePlan.player_id;
    const candidate = cue.candidate_id
      ? bundle?.candidate_set.candidates.find((item) => item.candidateId === cue.candidate_id)
      : undefined;
    const stage3Input: Stage3HostAdapterInput = {
      plan: activePlan,
      routeState,
      cue: stage3Cue,
      narration: presentableNarration,
      outcomeGate: session.outcome_completion,
      currentSessionPhase: "PAUSED_FOR_COACHING",
      analysis: {
        demo_id: bundle?.demo_id ?? activePlan.demo_id,
        selected_steam_id: bundle?.selected_steam_id ?? selected?.playerId ?? activePlan.player_id,
        metadata: bundle?.metadata,
      },
      demoContentHash: replay.demoContentHash,
      selectedPlayerId: selected?.playerId ?? activePlan.player_id,
      sessionId: recoveryIdentity.sessionId,
      runId: recoveryIdentity.runId,
      generation: generationRef.current,
      tickRate: replay.tickRate,
      evidence: {
        candidate,
        material: candidateMaterial,
        outcomeImpact,
        winProbabilityTimeline: bundle?.win_probability_timeline,
      },
    };
    const lifecycleInput = stage3ControllerRef.current?.resumeInputFor(stage3Input) ?? stage3Input;
    stage3InputRef.current = lifecycleInput;
    stage3ControllerRef.current?.start(lifecycleInput);
  }, [activePlan, bundle, candidateMaterial, cue, cueRevealed, outcomeImpact, presentableNarration, recoveryIdentity, replay, routeState, selected?.playerId, session, stage2Mode, stage3Cue, stage3Mode]);

  useEffect(() => {
    if (!stage3Mode || !stage3IdentityContext || !activePlan || !session || !segment || userTookOverRef.current) return;
    // Teaching segments are entered through START_CUE. All deterministic
    // ordinary/skip/freeze segments get an observer event instead; no Policy
    // call is attached to this lifecycle path.
    if (segment.cue_ids.length > 0) return;
    if (session.phase !== "PLAYING" && session.phase !== "SKIPPING") return;
    const mode = segment.mode === "SKIP"
      ? segment.reason_code === "FREEZE_TIME" ? "FREEZE" : "SKIP"
      : segment.mode === "BRIEF" ? "BRIEF" : "OBSERVE";
    stage3ControllerRef.current?.observeSegment(
      stage3IdentityContext,
      segment.id,
      session.current_segment_index,
      mode,
      session.phase,
    );
  }, [activePlan, segment, session, stage3IdentityContext, stage3Mode]);

  const requestStage3WrapUp = useCallback(async (agentResult: import("@cs-coach/coach-agent/client").CoachAgentResult, generation: number, runId: string) => {
    if (!stage3Mode || !activePlan || generation !== generationRef.current || agentResult.identity.runId !== runId) return;
    if (stage3WrapUpGenerationRef.current === generation) return;
    stage3WrapUpGenerationRef.current = generation;
    setStage3WrapUpStatus("LOADING");
    setStage3WrapUpError(undefined);
    const summaryInput = agentResult.state.sessionSummaryInput as SessionSummaryInput | null;
    if (!summaryInput) {
      const fallbackRequest = SessionWrapUpRequestSchema.parse({
        schemaVersion: "coach-agent-session-wrap-up.v1",
        themes: [],
        completedCues: [],
        limitations: ["Agent 没有返回可用的完成摘要。"],
      });
      setStage3WrapUpRequest(fallbackRequest);
      setStage3WrapUpResult(deterministicSessionWrapUpResult(fallbackRequest, "MISSING_SESSION_SUMMARY"));
      setStage3WrapUpStatus("FALLBACK");
      setStage3WrapUpError("Agent 没有返回可用的完成摘要；已保留基础复盘结果。");
      return;
    }
    try {
      const projection = buildStage3WrapUpInput(activePlan, summaryInput, narrationByCue);
      const request = buildSessionWrapUpRequest(projection);
      setStage3WrapUpRequest(request);
      const result = await requestSessionWrapUp(projection);
      if (generation !== generationRef.current || userTookOverRef.current || result === undefined) return;
      setStage3WrapUpResult(result);
      setStage3WrapUpStatus(result.status === "SUCCEEDED" ? "READY" : "FALLBACK");
      if (result.status !== "SUCCEEDED") setStage3WrapUpError("模型总结不可用，已使用确定性主题摘要。");
    } catch (error) {
      if (generation !== generationRef.current) return;
      const fallbackRequest = SessionWrapUpRequestSchema.parse({
        schemaVersion: "coach-agent-session-wrap-up.v1",
        themes: [],
        completedCues: [],
        limitations: ["已完成 cue 的可呈现资料不足，未强行生成主题。"],
      });
      setStage3WrapUpRequest(fallbackRequest);
      setStage3WrapUpResult(deterministicSessionWrapUpResult(fallbackRequest, "INVALID_PRESENTABLE_INPUT"));
      setStage3WrapUpStatus("FALLBACK");
      setStage3WrapUpError(error instanceof Error ? error.message.slice(0, 160) : "总结准备失败；基础复盘仍可完成。");
    }
  }, [activePlan, narrationByCue, stage3Mode]);

  useEffect(() => {
    if (!stage3Mode || !stage3IdentityContext || !session || userTookOverRef.current) return;
    if (session.phase !== "WRAP_UP" && session.phase !== "COMPLETED") return;
    void stage3ControllerRef.current?.completeSession(stage3IdentityContext).then((result) => {
      if (result) void requestStage3WrapUp(result, generationRef.current, stage3IdentityContext.runId);
    });
  }, [requestStage3WrapUp, session, stage3IdentityContext, stage3Mode]);

  const recoveryStatusKind: SessionRecoveryStatusKind | undefined = recoveryResult?.record
    ? recoveryResult.status === "READY"
      ? recoveryModeRef.current ? "REBUILDING" : undefined
      : recoveryResult.status
    : undefined;

  return (
    <main className="cs2d-host-shell">
      <header className="cs2d-host-header">
        <div>
          <p className="cs2d-host-eyebrow">CS2 AI DEMO COACH</p>
          <h1>整场带看</h1>
        </div>
        <div className="cs2d-host-status" data-phase={phase}>
          <span aria-hidden="true" />
          {phase === "BOOTING" ? "正在连接本地回放" : phase === "WAITING_FOR_DEMO" ? "请选择本地 Demo" : phase === "READY" ? `${replay?.map ?? "Demo"} 已就绪` : "回放宿主异常"}
        </div>
      </header>

      <section className="cs2d-host-workspace">
        <div className="cs2d-host-stage">
          <iframe
            ref={iframeRef}
            src={config.url}
            title="cs2d 本地 Demo 回放"
            allow="fullscreen; cross-origin-isolated"
            onLoad={() => setPhase((current) => current === "BOOTING" ? "WAITING_FOR_DEMO" : current)}
            onError={() => setPhase("ERROR")}
          />
        </div>

        <aside className="cs2d-host-coach" aria-label="AI 教练">
          <div className="cs2d-coach-heading">
            <div>
              <small>教练</small>
              {selected ? <p className="cs2d-coach-focus" title={selected.displayName}>正在复盘：{selected.displayName}</p> : null}
              <h2>{userTookOver ? "自由查看" : session ? phaseText[session.phase] : selected ? (routeState && !routeState.routeFrozen ? "等待教学路线冻结" : `正在分析 ${selected.displayName}`) : replay ? "先在地图内选择玩家" : "等待 Demo"}</h2>
            </div>
            <span
              className="cs2d-coach-badge"
              aria-label={sessionProgress ? `第 ${sessionProgress.current} 个讲解片段，共 ${sessionProgress.total} 个` : "本地回放"}
            >
              {sessionProgress ? <><small>讲解</small><b>{sessionProgress.current}/{sessionProgress.total}</b></> : "LOCAL"}
            </span>
          </div>

          {session && userTookOver ? (
            <div className="cs2d-coach-takeover" role="status">
              <span>手动复查中</span>
              <button type="button" onClick={resumeGuidedRoute}>返回教练路线</button>
            </div>
          ) : null}

          {recoveryStatusKind ? (
            <SessionRecoveryStatus
              status={recoveryStatusKind}
              detail={recoveryResult?.reason ?? undefined}
              onChooseDemo={chooseRecoveryDemo}
              onDiscard={discardRecovery}
            />
          ) : null}

          {analysisError ? (
            <section className="cs2d-coach-card cs2d-coach-card--error" role="alert">
              <small>分析未完成</small>
              <p>{analysisError}</p>
            </section>
          ) : null}

          {session && userTookOver ? (
            <section className="cs2d-coach-free-view" aria-live="polite">
              <small>自由查看</small>
              <h3>{freeViewPosition.roundLabel}</h3>
              <p>{freeViewPosition.segment?.display_reason ?? "当前是比赛原始位置，教练路线暂时停留。"}</p>
              <span>{freeViewPosition.segment?.mode === "SKIP" ? "低价值片段" : "普通比赛内容"}</span>
            </section>
          ) : null}

          {!session ? (
            <section className="cs2d-coach-card">
              <small>当前阶段</small>
              <p>{!replay ? "Demo 留在浏览器，由 cs2d Worker 解析。" : !selected ? "选择本场分析主体后，教练会自动接管播放节奏。" : "正在从同一份 cs2d Replay 生成整场讲解路线。"}</p>
            </section>
          ) : null}

          {!session && selected && analysisProgress ? (
            <section className={`cs2d-coach-card ${analysisProgress.phase === "unavailable" ? "cs2d-coach-card--muted" : ""}`} role="status" aria-live="polite">
              <small>{analysisProgressText}</small>
              <p>{analysisProgress.detail || (analysisProgress.total > 0 ? `${Math.round((analysisProgress.completed / analysisProgress.total) * 100)}%` : "模型在本机 Worker 中运行，不上传 Demo。")}</p>
            </section>
          ) : null}

          {!session && selected && reviewPreparationStatus ? (
            <section className={`cs2d-coach-card ${reviewPreparationStatus.phase === "ERROR" ? "cs2d-coach-card--error" : ""}`} role="status" aria-live="polite">
              <small>{reviewPreparationStatus.phase === "ROUTE" ? "教学路线准备中" : reviewPreparationStatus.phase === "NARRATION" ? "讲解包准备中" : reviewPreparationStatus.phase === "READY" ? "教学路线已就绪" : "教学路线需要恢复"}</small>
              <p>{reviewPreparationStatus.detail}</p>
            </section>
          ) : null}

          {session && !userTookOver && cue && cueRevealed && coachingView && presentableNarration && threeStageCoaching && session.phase === "PAUSED_FOR_COACHING" ? (
            <section className="cs2d-coach-cue" aria-live="polite">
              <div className="cs2d-coach-cue-heading">
                <small>第 {segment?.round_number ?? ""} 回合 · 处理看完了</small>
                <h3>{cue.title}</h3>
              </div>
              <div className="cs2d-coaching-bands">
                <section className="cs2d-coaching-band cs2d-coaching-band--situation">
                  <div className="cs2d-coaching-band-heading">
                    <span className="cs2d-coaching-band-icon"><Crosshair aria-hidden="true" /></span>
                    <strong>当前状态</strong>
                  </div>
                  {threeStageCoaching.currentState.chips.length > 0 ? (
                    <ul className="cs2d-coaching-status-list">
                      {threeStageCoaching.currentState.chips.map((chip, index) => (
                        <li key={`${chip.kind}-${index}`}>
                          <CoachingStatusGlyph chip={chip} catalog={gameAssetCatalog} />
                          <span>{coachingStatusText(chip, gameAssetCatalog)}</span>
                        </li>
                      ))}
                    </ul>
                  ) : <p>{threeStageCoaching.currentState.fallbackText}</p>}
                </section>
                <section className="cs2d-coaching-band cs2d-coaching-band--problem">
                  <div className="cs2d-coaching-band-heading">
                    <span className="cs2d-coaching-band-icon"><TriangleAlert aria-hidden="true" /></span>
                    <strong>这样做的问题</strong>
                  </div>
                  <p>{threeStageCoaching.problem.text}</p>
                  {threeStageCoaching.problem.consequences.length > 0 ? (
                    <div className="cs2d-coaching-consequence">
                      <TriangleAlert aria-hidden="true" />
                      <span>{threeStageCoaching.problem.consequences.join(" ")}</span>
                    </div>
                  ) : null}
                </section>
                <section className="cs2d-coaching-band cs2d-coaching-band--better">
                  <div className="cs2d-coaching-band-heading">
                    <span className="cs2d-coaching-band-icon"><Lightbulb aria-hidden="true" /></span>
                    <strong>可以怎么改进</strong>
                  </div>
                  <p>{threeStageCoaching.improvement.text}</p>
                </section>
              </div>
              {stage2Mode && stage2Cue?.id === cue.id ? (
                <section className={`cs2d-coach-card${stage2Status === "FAILED" || stage2Status === "CANCELLED" ? " cs2d-coach-card--muted" : ""}`} role="status" aria-live="polite">
                  <small>
                    {stage2Status === "FOCUSING" ? "正在标出关键站位" :
                      stage2Status === "RESUMING" ? "正在准备下一段" :
                        stage2Status === "COMPLETED" ? "关键站位已标出" :
                          stage2Status === "FAILED" || stage2Status === "CANCELLED" ? "地图证据暂不可用" : "正在准备地图证据"}
                  </small>
                  <p>{stage2Error ?? (stage2Status === "COMPLETED" ? "证据已回到当前讲解卡；你可以继续下一段。" : "当前工具只绑定已验证的地图证据。")}</p>
                </section>
              ) : null}
              {stage3Mode && stage3Cue?.id === cue.id ? (
                <section className={`cs2d-coach-card${stage3State.status === "FAILED" || stage3State.status === "CANCELLED" || stage3State.status === "RECOVERY_REQUIRED" ? " cs2d-coach-card--muted" : ""}`} role="status" aria-live="polite">
                  <small>
                    {stage3State.status === "FOCUSING" && stage3State.tool
                      ? stage3ToolStatusLabel(stage3State.tool)
                      : stage3State.status === "RESUMING"
                        ? "正在准备下一段"
                        : stage3State.status === "COMPLETED"
                          ? "教学工具已完成"
                          : stage3State.status === "RECOVERY_REQUIRED"
                            ? "需要恢复工具状态"
                            : stage3State.status === "FAILED" || stage3State.status === "CANCELLED"
                              ? "教学工具暂不可用"
                              : "准备下一段"}
                  </small>
                  <p>{stage3State.error ?? (stage3State.status === "COMPLETED" ? "证据已回到当前讲解卡；你可以继续下一段。" : "工具只绑定当前 cue 已验证的证据。")}</p>
                  {!stage3State.error && stage3State.presentation?.tool === "SHOW_WIN_RATE_IMPACT" ? (
                    <p>{Math.round(stage3State.presentation.beforeProbability * 100)}% → {Math.round(stage3State.presentation.afterProbability * 100)}% · {stage3State.presentation.percentagePoints.toFixed(1)} 个百分点 · {stage3State.presentation.economyClass} · 相关性不等于单一行为因果</p>
                  ) : null}
                  {!stage3State.error && stage3State.presentation?.tool === "SHOW_ECONOMY_CONTEXT" ? (
                    <p>{stage3State.presentation.economyClass} · {stage3State.presentation.focusLabel}</p>
                  ) : null}
                  {stage3State.status === "RECOVERY_REQUIRED" && stage3InputRef.current ? (
                    <button type="button" onClick={() => stage3InputRef.current && stage3ControllerRef.current?.recover(stage3InputRef.current)}>恢复工具状态</button>
                  ) : null}
                </section>
              ) : null}
              <div className="cs2d-coach-result-actions">
                <button type="button" disabled={agentToolBusy} onClick={() => transition({ type: "REPLAY_OUTCOME" })}>再看一遍</button>
                <button className="cs2d-coach-primary" type="button" disabled={agentToolBusy} onClick={() => transition({ type: "ADVANCE_SEGMENT" })}>继续下一段</button>
              </div>
            </section>
          ) : null}

          {session && !userTookOver && cue && cueRevealed && session.phase === "PAUSED_FOR_COACHING" && !presentableNarration ? (
            <section className="cs2d-coach-card" role="status" aria-live="polite">
              <small>结果已看完，讲解包准备中</small>
              <p>当前处理已经完整播放；讲解包准备好后，这里会显示完整复盘。回放路线保持不变。</p>
            </section>
          ) : null}

          {session && !userTookOver && !cue && ["PLAYING", "SKIPPING"].includes(session.phase) ? (
            <section className="cs2d-coach-card" aria-live="polite">
              <small>{session.phase === "SKIPPING" ? "低价值片段" : "正在带看"}</small>
              <p>{segment?.display_reason ?? "教练会先带你看完下一段关键处理，再回到决策点讲解。"}</p>
            </section>
          ) : null}

          {session && !userTookOver && session.phase === "BUFFERING" ? (
            <section className="cs2d-coach-card" role="status" aria-live="polite">
              <small>下一段讲解准备中</small>
              <p>当前画面停在自然回合边界；讲解准备好后会自动继续，不会跳过普通比赛内容。</p>
            </section>
          ) : null}

          {session && !userTookOver && cue && ["PLAYING", "REVEALING", "REPLAYING"].includes(session.phase) ? (
            <section className="cs2d-coach-card" aria-live="polite">
              <small>{session.phase === "PLAYING" ? "正在先看完整处理" : session.phase === "REPLAYING" ? "正在重播完整处理" : "正在播放完整处理"}</small>
              <p>{session.phase === "PLAYING" ? "先看一秒上下文和完整处理，播放结束后再回到决策点讲解。" : "跟住这段完整处理，结束后会回到问题发生前。"}</p>
            </section>
          ) : null}

          {session && !userTookOver && stage3Mode && ["WRAP_UP", "COMPLETED"].includes(session.phase) ? (
            <section className="cs2d-coach-summary" aria-live="polite">
              <small>全场总结 · {stage3WrapUpStatus === "LOADING" ? "准备中" : stage3WrapUpStatus === "ERROR" ? "需要恢复" : stage3WrapUpStatus === "FALLBACK" ? "确定性摘要" : "已就绪"}</small>
              {stage3WrapUpStatus === "LOADING" ? <p>正在整理已完成且可呈现的讲解点。</p> : null}
              {stage3WrapUpError ? <p>{stage3WrapUpError}</p> : null}
              {(stage3WrapUpResult?.bundle.themes.length ?? 0) > 0 ? (
                <div>
                  {stage3WrapUpResult?.bundle.themes.slice(0, 3).map((theme, index) => {
                    const requestTheme = stage3WrapUpRequest?.themes.find((candidateTheme) => candidateTheme.focus === theme.focus);
                    const roundLabels = [...new Set((requestTheme?.cueRefs ?? []).map((cueId) => {
                      const referencedCue = activePlan?.cues.find((candidateCue) => candidateCue.id === cueId);
                      const referencedSegment = referencedCue ? activePlan?.segments.find((candidateSegment) => candidateSegment.id === referencedCue.segment_id) : undefined;
                      return referencedSegment?.round_number ? `第 ${referencedSegment.round_number} 回合` : "准备阶段";
                    }))];
                    return (
                      <article key={`${theme.focus}-${index}`} className="cs2d-coach-card">
                        <small>主题 {index + 1} · {roundLabels.join("、") || "已完成讲解点"}</small>
                        <p>{theme.summary.text}</p>
                        <p><b>训练建议：</b>{theme.trainingAdvice.text}</p>
                      </article>
                    );
                  })}
                </div>
              ) : stage3WrapUpStatus !== "LOADING" ? (
                <p>本场没有足够重复证据，不强行定义长期习惯。</p>
              ) : null}
              {session.phase === "WRAP_UP" ? <button className="cs2d-coach-primary" type="button" onClick={() => transition({ type: "COMPLETE_SESSION" })}>完成本次复盘</button> : null}
            </section>
          ) : null}

          {session && !userTookOver && !stage3Mode && ["WRAP_UP", "COMPLETED"].includes(session.phase) ? (
            <section className="cs2d-coach-summary">
              <small>全场总结</small>
              <h3>{summary?.habit_title ?? "本场讲解已全部看完"}</h3>
              <p>{summary?.positive ?? `已完成 ${session.consumed_cue_ids.length} 个关键节点。`}</p>
              {summary ? <p><b>下一场唯一目标：</b>{summary.next_match_goal}</p> : null}
              {session.phase === "WRAP_UP" ? <button className="cs2d-coach-primary" type="button" onClick={() => transition({ type: "COMPLETE_SESSION" })}>完成本次复盘</button> : null}
            </section>
          ) : null}

          {replay ? (
            <dl className="cs2d-coach-facts">
              <div><dt>地图</dt><dd>{replay.map}</dd></div>
              <div><dt>玩家</dt><dd>{replay.players.length}</dd></div>
              <div><dt>回合</dt><dd>{replay.roundCount}</dd></div>
              <div><dt>进度</dt><dd>{positionLabel}</dd></div>
            </dl>
          ) : null}

        </aside>
      </section>

      <footer className="cs2d-host-timeline">
        <div className="cs2d-timeline-toolbar" aria-label="回放控制">
          <div className="cs2d-host-controls">
            <button
              className="cs2d-host-icon-button"
              type="button"
              disabled={!replay}
              title="后退 15 秒"
              aria-label="后退 15 秒"
              onClick={() => seekBySeconds(-15)}
            >
              <RotateCcw size={16} strokeWidth={2.1} aria-hidden="true" />
              <span className="cs2d-control-count" aria-hidden="true">15</span>
            </button>
            <button
              className="cs2d-host-play"
              type="button"
              disabled={!replay}
              title={playback?.playing ? "暂停" : "播放"}
              aria-label={playback?.playing ? "暂停" : "播放"}
              onClick={() => issueUserCommand({ type: playback?.playing ? "pause" : "play" })}
            >
              {playback?.playing
                ? <Pause size={17} strokeWidth={2.2} aria-hidden="true" />
                : <Play size={17} strokeWidth={2.2} aria-hidden="true" />}
              <span className="cs2d-visually-hidden">{playback?.playing ? "暂停" : "播放"}</span>
            </button>
            <button
              className="cs2d-host-icon-button"
              type="button"
              disabled={!replay}
              title="前进 15 秒"
              aria-label="前进 15 秒"
              onClick={() => seekBySeconds(15)}
            >
              <RotateCw size={16} strokeWidth={2.1} aria-hidden="true" />
              <span className="cs2d-control-count" aria-hidden="true">15</span>
            </button>
          </div>

          <div className="cs2d-round-controls" aria-label="回合导航">
            <button
              className="cs2d-host-icon-button"
              type="button"
              disabled={!replay || currentRoundIndex <= 0}
              title="上一回合"
              aria-label="上一回合"
              onClick={() => issueUserCommand({
                type: "selectRound",
                roundIndex: adjacentRoundIndex(currentRoundIndex, -1, replay?.rounds.length ?? 0)
              })}
            >
              <SkipBack size={16} strokeWidth={2.1} aria-hidden="true" />
            </button>
            <span className="cs2d-round-position" aria-live="polite">
              {currentRound ? `${currentRoundLabel} / 共 ${replay?.roundCount ?? 0} 回合` : "回合 / 共 0 回合"}
            </span>
            <button
              className="cs2d-host-icon-button"
              type="button"
              disabled={!replay || currentRoundIndex >= (replay?.rounds.length ?? 1) - 1}
              title="下一回合"
              aria-label="下一回合"
              onClick={() => issueUserCommand({
                type: "selectRound",
                roundIndex: adjacentRoundIndex(currentRoundIndex, 1, replay?.rounds.length ?? 0)
              })}
            >
              <SkipForward size={16} strokeWidth={2.1} aria-hidden="true" />
            </button>
          </div>

          <div className="cs2d-timeline-zoom-controls" role="group" aria-label="时间轴缩放">
            <label className="cs2d-timeline-zoom-control" title="只调整 B 胜率曲线的高度">
              <ArrowUpDown size={15} strokeWidth={2.15} aria-hidden="true" />
              <span className="cs2d-zoom-axis-tag" aria-hidden="true">B</span>
              <span className="cs2d-visually-hidden">B 胜率曲线纵向缩放</span>
              <input
                type="range"
                min={WIN_RATE_VERTICAL_ZOOM_MIN}
                max={WIN_RATE_VERTICAL_ZOOM_MAX}
                step={WIN_RATE_VERTICAL_ZOOM_STEP}
                value={winRateVerticalZoom}
                disabled={!winRateCurve}
                aria-label="B 胜率曲线纵向缩放"
                aria-valuetext={`B 高度 ${winRateVerticalZoom.toFixed(2)} 倍`}
                onInput={(event) => updateWinRateVerticalZoom(Number(event.currentTarget.value))}
              />
              <output aria-hidden="true">{winRateVerticalZoom.toFixed(2)}×</output>
            </label>
            <label className="cs2d-timeline-zoom-control" title="同步调整 A Demo 与 B 胜率的横向画布">
              <ArrowLeftRight size={15} strokeWidth={2.15} aria-hidden="true" />
              <span className="cs2d-zoom-axis-tag" aria-hidden="true">A+B</span>
              <span className="cs2d-visually-hidden">A 和 B 横向同步缩放</span>
              <input
                type="range"
                min={TIMELINE_HORIZONTAL_ZOOM_MIN}
                max={TIMELINE_HORIZONTAL_ZOOM_MAX}
                step={TIMELINE_HORIZONTAL_ZOOM_STEP}
                value={timelineHorizontalZoom}
                disabled={!replay}
                aria-label="A 和 B 横向同步缩放"
                aria-valuetext={`A 和 B 宽度 ${timelineHorizontalZoom.toFixed(2)} 倍`}
                onInput={(event) => updateTimelineHorizontalZoom(Number(event.currentTarget.value))}
              />
              <output aria-hidden="true">{timelineHorizontalZoom.toFixed(2)}×</output>
            </label>
          </div>

          <div className="cs2d-speed-controls" role="group" aria-label="播放速度">
            {HOST_SPEED_OPTIONS.map((speed) => (
              <button
                key={speed}
                type="button"
                disabled={!replay}
                title={`播放速度 ${speed} 倍`}
                aria-label={`播放速度 ${speed} 倍`}
                aria-pressed={playback?.speed === speed}
                onClick={() => issueUserCommand({ type: "setSpeed", speed })}
              >
                {speed}×
              </button>
            ))}
          </div>
        </div>

        <div
          ref={timelineViewportRef}
          className={`cs2d-timeline-sync-viewport${timelineHorizontalZoom > TIMELINE_HORIZONTAL_ZOOM_MIN ? " is-zoomed" : ""}${timelinePanning ? " is-panning" : ""}`}
          aria-label="A Demo 进度与 B 胜率同步时间轴"
          onPointerDown={onTimelineViewportPointerDown}
          onPointerMove={onTimelineViewportPointerMove}
          onPointerUp={onTimelineViewportPointerUp}
          onPointerCancel={onTimelineViewportPointerUp}
        >
          <div
            ref={timelineContentRef}
            className="cs2d-timeline-sync-content"
            style={{ width: `${timelineHorizontalZoom * 100}%` }}
          >
            <div className="cs2d-timeline-heading">
              <label htmlFor="match-progress"><span className="cs2d-timeline-axis-tag" aria-hidden="true">A</span> Demo 进度</label>
              <output>{replay ? `${Math.round(currentPercent)}% · ${positionLabel}` : "等待 Demo"}</output>
            </div>

            <div
              ref={timelineRailRef}
              className="cs2d-timeline-rail"
              onPointerDown={onTimelinePointerDown}
              onPointerMove={onTimelinePointerMove}
              onPointerUp={onTimelinePointerUp}
              onPointerCancel={onTimelinePointerUp}
            >
              <div className="cs2d-timeline-rounds" aria-label="选择回合">
                {timelineRounds.map(({ round, leftPercent, widthPercent }) => (
                  <button
                    key={`${round.roundIndex}-${round.roundNumber}`}
                    className="cs2d-timeline-round-button"
                    type="button"
                    style={{ left: `${leftPercent}%`, width: `${widthPercent}%` }}
                    aria-pressed={currentRoundIndex === round.roundIndex}
                    aria-label={round.roundNumber === 0 ? "跳到准备阶段" : `跳到第 ${round.roundNumber} 回合`}
                    title={round.roundNumber === 0 ? "准备阶段" : `第 ${round.roundNumber} 回合`}
                    onPointerDown={(event) => event.stopPropagation()}
                    onClick={() => issueUserCommand({ type: "selectRound", roundIndex: round.roundIndex })}
                  >
                    {round.roundNumber === 0 ? "准备" : `R${round.roundNumber}`}
                  </button>
                ))}
              </div>

              <div className="cs2d-timeline-segment-fills" aria-hidden="true">
                {timelineSegments.map(({ planSegment, leftPercent, widthPercent }) => {
                  const tone = reviewSegmentTone(planSegment.mode);
                  const active = tick >= planSegment.start_tick && tick < planSegment.end_tick;
                  return <span
                    key={planSegment.id}
                    className={`cs2d-timeline-segment-fill cs2d-timeline-segment-fill--${tone}${active ? " is-active" : ""}`}
                    style={{ left: `${leftPercent}%`, width: `${widthPercent}%` }}
                  />;
                })}
              </div>

              <span
                className="cs2d-timeline-playhead"
                style={{ left: `${currentPercent}%` }}
                aria-hidden="true"
              />

              <input
                id="match-progress"
                className="cs2d-timeline-range"
                type="range"
                min={tickMin}
                max={tickMax}
                value={tick}
                disabled={!replay}
                aria-label="A Demo 进度"
                aria-valuetext={positionLabel}
                onInput={(event) => seekFromTimeline(Number(event.currentTarget.value))}
              />
            </div>

            {winRateTimeline?.status === "UNAVAILABLE" ? (
              <div className="cs2d-winrate-unavailable" role="status">
                <strong><span className="cs2d-timeline-axis-tag" aria-hidden="true">B</span> 整场胜率暂不可用</strong>
                <span>{winRateTimeline.unavailableReason ?? "模型资源未就绪；回放和基础教练路线仍可继续。"}</span>
              </div>
            ) : winRateCurve ? (
              <section className="cs2d-winrate-panel" aria-label="B 整场胜率曲线">
                <div className="cs2d-winrate-heading">
                  <div><span className="cs2d-timeline-axis-tag" aria-hidden="true">B</span><strong>你方胜率</strong><span>整场信号 · 当前回合：{currentRoundLabel}</span></div>
                  <output>{Math.round(100 - (currentWinPoint?.y ?? 50))}%</output>
                </div>
                <div
                  className="cs2d-winrate-chart"
                  style={{ height: `${WIN_RATE_BASE_CHART_HEIGHT_REM * winRateVerticalZoom}rem` }}
                >
                  <svg viewBox="0 0 100 100" preserveAspectRatio="none" role="img" aria-label="整场胜率曲线，包含播放头之后的完整比赛信号">
                    <line x1="0" x2="100" y1="50" y2="50" className="cs2d-winrate-midline" />
                    {timelineRounds.slice(1).map((round) => <line key={`curve-round-${round.round.roundIndex}`} x1={round.leftPercent} x2={round.leftPercent} y1="0" y2="100" className="cs2d-winrate-roundline" />)}
                    {winRateCurve.swings.filter((swing) => Math.abs(swing.delta) >= 0.12).map((swing) => <line key={swing.id} x1={swing.x} x2={swing.x} y1={Math.max(0, swing.y - 9)} y2={Math.min(100, swing.y + 9)} className={`cs2d-winrate-swing cs2d-winrate-swing--${swing.direction.toLowerCase()}`} />)}
                    <polyline points={winRateCurve.points.map((point) => `${point.x},${point.y}`).join(" ")} className="cs2d-winrate-line" />
                    <line x1={currentPercent} x2={currentPercent} y1="0" y2="100" className="cs2d-winrate-playhead" />
                  </svg>
                  <div className="cs2d-winrate-hotspots" aria-label="胜率曲线详情">
                    {winRateCurve.rounds.map((round) => (
                      <span
                        key={`curve-round-hotspot-${round.roundNumber}`}
                        className="cs2d-winrate-hotspot cs2d-winrate-hotspot--round"
                        style={{ left: `${round.range.leftPercent}%`, width: `${round.range.widthPercent}%` }}
                        role="img"
                        tabIndex={0}
                        aria-label={round.label}
                        title={round.label}
                      />
                    ))}
                    {winRateCurve.swings.filter((swing) => Math.abs(swing.delta) >= 0.12).map((swing) => {
                      const direction = swing.delta < 0 ? "下降" : "上升";
                      const points = Math.round(Math.abs(swing.delta) * 100);
                      const label = `胜率${direction} ${points} 个百分点${swing.cause === "PLAYER_DEATH" ? " · 死亡摆动" : " · 回合结果"}`;
                      return (
                        <span
                          key={`curve-swing-hotspot-${swing.id}`}
                          className={`cs2d-winrate-hotspot cs2d-winrate-hotspot--swing cs2d-winrate-swing--${swing.direction.toLowerCase()}`}
                          style={{ left: `${swing.x}%`, top: `${swing.y}%` }}
                          role="img"
                          tabIndex={0}
                          aria-label={label}
                          title={label}
                        />
                      );
                    })}
                  </div>
                  <div className="cs2d-winrate-axis" aria-hidden="true"><span>100%</span><span>50%</span><span>0%</span></div>
                </div>
                <div className="cs2d-winrate-note">完整曲线常显；模型信号不等于当时玩家可见信息。橙色竖线表示明显摆动，回合边界与 A 共用横坐标。</div>
              </section>
            ) : null}
          </div>
        </div>

        {activePlan ? (
          <div className="cs2d-timeline-legend" aria-label="教练路线图例">
            <span><i className="is-coach" aria-hidden="true" />教练重点</span>
            <span><i className="is-skip" aria-hidden="true" />低价值</span>
            <span><i className="is-neutral" aria-hidden="true" />普通比赛</span>
          </div>
        ) : null}
      </footer>
    </main>
  );
}

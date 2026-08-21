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
import {
  acceptedPlaybackEvent,
  analysisEventMatchesSelectedPlayer,
  adjacentRoundIndex,
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
  hostCoachingCueSurface
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

export function Cs2dPlaybackHost({
  reviewPreparationDependencies
}: Cs2dPlaybackHostProps = {}) {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const planRef = useRef<ReviewPlan | undefined>(undefined);
  const [benchmarkQuery, setBenchmarkQuery] = useState("");
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
  const guidedSeekEpochRef = useRef(0);
  const guidedSeekGateRef = useRef<GuidedSeekGate | undefined>(undefined);
  const [userTookOver, setUserTookOver] = useState(false);
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

  const invalidateGeneration = useCallback(() => {
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

  const invalidateGuidedSeek = useCallback(() => {
    guidedSeekEpochRef.current += 1;
    guidedSeekGateRef.current = undefined;
  }, []);

  const markUserTookOver = useCallback(() => {
    invalidateGuidedSeek();
    if (!userTookOverRef.current) send({ type: "setCamera", mode: "full" });
    userTookOverRef.current = true;
    setUserTookOver(true);
  }, [invalidateGuidedSeek, send]);

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
  }, [clearUserTakeover, playback?.canonicalTick]);

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
  }, [invalidateGeneration, invalidateGuidedSeek]);

  useEffect(() => () => {
    invalidateGeneration();
  }, [invalidateGeneration]);

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
              setNarrationByCue((current) => ({ ...current, [preparationEvent.cueId]: preparationEvent.result.narration }));
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
              setSession(reduceCoachingSession(
                preparationEvent.plan,
                createCoachingSession(preparationEvent.plan, `session-${preparationEvent.plan.id}`, preparationEvent.routeState),
                { type: "START" }
              ));
            }
          });
        } catch (error) {
          setAnalysisError(error instanceof Error ? error.message : "分析结果校验失败。");
          setReviewPreparationStatus({ phase: "ERROR", detail: "教学路线输入校验失败。" });
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
  }, [config.origin, invalidateGeneration, invalidateGuidedSeek, resetAnalysis, reviewPreparationDependencies]);

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
    ? `${Math.min(activePlan.segments.length, session.current_segment_index + 1)} / ${activePlan.segments.length}`
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
            <span className="cs2d-coach-badge">{sessionProgress ?? "LOCAL"}</span>
          </div>

          {session && userTookOver ? (
            <div className="cs2d-coach-takeover" role="status">
              <span>手动复查中</span>
              <button type="button" onClick={resumeGuidedRoute}>返回教练路线</button>
            </div>
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
              <div className="cs2d-coach-result-actions">
                <button type="button" onClick={() => transition({ type: "REPLAY_OUTCOME" })}>再看一遍</button>
                <button className="cs2d-coach-primary" type="button" onClick={() => transition({ type: "ADVANCE_SEGMENT" })}>继续下一段</button>
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

          {session && !userTookOver && ["WRAP_UP", "COMPLETED"].includes(session.phase) ? (
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

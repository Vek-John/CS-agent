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
  Pause,
  Play,
  RotateCcw,
  RotateCw,
  SkipBack,
  SkipForward
} from "lucide-react";
import type {
  CoachingSessionState,
  PlaybackBridgeEvent,
  PlaybackCommand,
  PlaybackStateEvent,
  PlayerSelectedEvent,
  ReplayReadyEvent,
  ReviewPlan
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
import { enrichReviewPlanWithNarration } from "../lib/coach-narration";
import {
  guidedPlaybackDirective,
  guidedTransitionKey
} from "../lib/cs2d-guided-session";
import {
  acceptedPlaybackEvent,
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
  HOST_SPEED_OPTIONS
} from "../lib/cs2d-playback-host";

type HostPhase = "BOOTING" | "WAITING_FOR_DEMO" | "READY" | "ERROR";

const phaseText: Record<CoachingSessionState["phase"], string> = {
  INTRO: "准备讲解",
  PLAYING: "带你看比赛",
  SKIPPING: "自动跳过",
  PAUSED_FOR_COACHING: "教练暂停",
  REVEALING: "播放结果",
  REPLAYING: "再次回看",
  WRAP_UP: "全场总结",
  COMPLETED: "复盘完成"
};

export function Cs2dPlaybackHost() {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const planRef = useRef<ReviewPlan | undefined>(undefined);
  const config = useMemo(() => cs2dHostConfig(), []);
  const [phase, setPhase] = useState<HostPhase>("BOOTING");
  const [replay, setReplay] = useState<ReplayReadyEvent>();
  const [selected, setSelected] = useState<PlayerSelectedEvent>();
  const [playback, setPlayback] = useState<PlaybackStateEvent>();
  const [bundle, setBundle] = useState<Cs2dAnalysisBundle>();
  const [plan, setPlan] = useState<ReviewPlan>();
  const [session, setSession] = useState<CoachingSessionState>();
  const [analysisError, setAnalysisError] = useState<string>();
  const timelineRailRef = useRef<HTMLDivElement>(null);
  const userTookOverRef = useRef(false);
  const [userTookOver, setUserTookOver] = useState(false);

  const tickMin = replay?.startCanonicalTick ?? 0;
  const tickMax = replay?.endCanonicalTick ?? Math.max(1, tickMin + 1);
  const tick = clampCanonicalTick(playback?.canonicalTick ?? tickMin, tickMin, tickMax);
  const currentRoundIndex = replay
    ? clampCanonicalTick(playback?.roundIndex ?? 0, 0, Math.max(0, replay.rounds.length - 1))
    : 0;

  const send = useCallback((command: PlaybackCommand) => {
    iframeRef.current?.contentWindow?.postMessage(playbackCommandMessage(command), config.origin);
  }, [config.origin]);

  const markUserTookOver = useCallback(() => {
    if (!userTookOverRef.current) send({ type: "setCamera", mode: "full" });
    userTookOverRef.current = true;
    setUserTookOver(true);
  }, [send]);

  const clearUserTakeover = useCallback(() => {
    userTookOverRef.current = false;
    setUserTookOver(false);
  }, []);

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

  const resetAnalysis = useCallback(() => {
    planRef.current = undefined;
    setSelected(undefined);
    setBundle(undefined);
    setPlan(undefined);
    setSession(undefined);
    setAnalysisError(undefined);
    userTookOverRef.current = false;
    setUserTookOver(false);
  }, []);

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
        setReplay(payload);
        setPlayback(undefined);
        resetAnalysis();
        setPhase("READY");
        return;
      }
      if (payload.type === "PLAYER_SELECTED") {
        setSelected(payload);
        setAnalysisError(undefined);
        return;
      }
      if (payload.type === "ANALYSIS_FAILED") {
        setAnalysisError(payload.message);
        setBundle(undefined);
        setPlan(undefined);
        setSession(undefined);
        planRef.current = undefined;
        userTookOverRef.current = false;
        setUserTookOver(false);
        return;
      }
      if (payload.type === "ANALYSIS_READY") {
        try {
          const nextBundle = deserializeCs2dAnalysisBundle(payload.bundleJson);
          if (nextBundle.selected_steam_id !== payload.selectedPlayerId) {
            throw new Error("分析结果与所选玩家不一致。");
          }
          const deterministicPlan = nextBundle.review_plan;
          planRef.current = deterministicPlan;
          setBundle(nextBundle);
          setPlan(deterministicPlan);
          setAnalysisError(undefined);
          userTookOverRef.current = false;
          setUserTookOver(false);
          setSession(reduceCoachingSession(
            deterministicPlan,
            createCoachingSession(deterministicPlan, `session-${deterministicPlan.id}`),
            { type: "START" }
          ));

          void enrichReviewPlanWithNarration(deterministicPlan, {
            redaction: {
              playerNames: nextBundle.match_timeline.players.map((player) => player.display_name),
              additionalForbiddenValues: nextBundle.match_timeline.players.map((player) => player.player_id)
            }
          }).then((narrated) => {
            if (planRef.current?.id !== narrated.id) return;
            planRef.current = narrated;
            setPlan(narrated);
          });
        } catch (error) {
          setAnalysisError(error instanceof Error ? error.message : "分析结果校验失败。");
        }
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
  }, [config.origin, resetAnalysis]);

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
    const directive = guidedPlaybackDirective(activePlan, session);
    directive.commands.forEach(send);
    if (directive.automaticAction) {
      setSession((current) => current
        ? reduceCoachingSession(activePlan, current, directive.automaticAction!)
        : current);
    }
  }, [playback !== undefined, send, transitionKey, userTookOver]);

  const activePlan = plan ?? bundle?.review_plan;
  const segment = activePlan && session ? getCurrentSegment(activePlan, session) : undefined;
  const cue = activePlan && session ? getCurrentCue(activePlan, session) : undefined;
  const cueRevealed = Boolean(cue && session?.revealed_cue_ids.includes(cue.id));
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
            allow="fullscreen"
            onLoad={() => setPhase((current) => current === "BOOTING" ? "WAITING_FOR_DEMO" : current)}
            onError={() => setPhase("ERROR")}
          />
        </div>

        <aside className="cs2d-host-coach" aria-label="AI 教练">
          <div className="cs2d-coach-heading">
            <div>
              <small>教练</small>
              {selected ? <p className="cs2d-coach-focus" title={selected.displayName}>正在复盘：{selected.displayName}</p> : null}
              <h2>{userTookOver ? "自由查看" : session ? phaseText[session.phase] : selected ? `正在分析 ${selected.displayName}` : replay ? "先在地图内选择玩家" : "等待 Demo"}</h2>
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

          {session && !userTookOver && cue && session.phase === "PAUSED_FOR_COACHING" ? (
            <section className="cs2d-coach-cue" aria-live="polite">
              <small>{cueRevealed ? "结果已播放" : "教练判断与理由"}</small>
              <h3>{cue.title}</h3>
              {!cueRevealed ? (
                <>
                  <ul>
                    {cue.facts
                      .filter((fact) => cue.observable_fact_refs.includes(fact.id))
                      .slice(0, 3)
                      .map((fact) => <li key={fact.id}>{fact.text}</li>)}
                  </ul>
                  <p>{cue.question}</p>
                  {cue.advice[0] ? (
                    <div className="cs2d-coach-action">
                      <b>主动作</b>
                      <p>{cue.advice[0].text}</p>
                      <small>触发条件：{cue.advice[0].trigger}</small>
                    </div>
                  ) : null}
                  <button className="cs2d-coach-primary" type="button" onClick={() => transition({ type: "REVEAL_OUTCOME" })}>看结果</button>
                </>
              ) : (
                <div className="cs2d-coach-result-actions">
                  <p>这波结果看完了。可以再看一遍，或者接着往下走。</p>
                  <button type="button" onClick={() => transition({ type: "REPLAY_OUTCOME" })}>再看一遍</button>
                  <button className="cs2d-coach-primary" type="button" onClick={() => transition({ type: "ADVANCE_SEGMENT" })}>继续下一段</button>
                </div>
              )}
            </section>
          ) : null}

          {session && !userTookOver && !cue && ["PLAYING", "SKIPPING"].includes(session.phase) ? (
            <section className="cs2d-coach-card" aria-live="polite">
              <small>{session.phase === "SKIPPING" ? "低价值片段" : "正在带看"}</small>
              <p>{segment?.display_reason ?? "教练会在下一个关键决策前自动暂停。"}</p>
            </section>
          ) : null}

          {session && !userTookOver && cue && ["PLAYING", "REVEALING", "REPLAYING"].includes(session.phase) ? (
            <section className="cs2d-coach-card" aria-live="polite">
              <small>{session.phase === "PLAYING" ? "接近讲解点" : "正在播放结果"}</small>
              <p>{session.phase === "PLAYING" ? "到关键决策前会自动暂停并直接讲解。" : "跟住你这一波处理，看结果怎么落地。"}</p>
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

        <div className="cs2d-timeline-heading">
          <label htmlFor="match-progress">整场进度</label>
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
            aria-label="整场比赛进度"
            aria-valuetext={positionLabel}
            onInput={(event) => seekFromTimeline(Number(event.currentTarget.value))}
          />
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

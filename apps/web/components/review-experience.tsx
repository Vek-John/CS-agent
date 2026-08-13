"use client";

import type { FormEvent } from "react";
import { useEffect, useMemo, useReducer, useState } from "react";
import type {
  CoachCue,
  CoachingSessionPhase,
  MatchTimeline,
  MatchPlayer,
  QuestionAnswer,
  ReviewPlan,
  ReviewMode,
  ReviewSegment
} from "@cs-coach/contracts";
import {
  getRoundAtTick,
  sampleTrackAtTick
} from "@cs-coach/demo-domain";
import { createFixtureReviewPlan } from "@cs-coach/review-planner";
import {
  answerCurrentCueQuestion,
  buildSessionSummary,
  createCoachingSession,
  getCurrentCue,
  getCurrentSegment,
  reduceCoachingSession,
  type SessionAction
} from "@cs-coach/session";
import { ReplayViewer, type ReplayPerspective } from "./replay-viewer";
import { createFixtureReplayView, type ReplayViewModel } from "../lib/replay-bundle";
import { sampleStateAtTick } from "../lib/replay-sampling";

const fixtureView = createFixtureReplayView();

const modeLabels: Record<ReviewMode, string> = {
  SKIP: "跳过",
  BRIEF: "带过",
  OBSERVE: "观察",
  DEEP_DIVE: "深入讲解",
  HABIT_CHECK: "习惯复查"
};

const phaseLabels: Record<CoachingSessionPhase, string> = {
  INTRO: "准备开始",
  PLAYING: "正在带看",
  SKIPPING: "建议跳过",
  PAUSED_FOR_COACHING: "教练暂停",
  REVEALING: "播放真实结果",
  REPLAYING: "回看结果",
  WRAP_UP: "全场已看完",
  COMPLETED: "复盘完成"
};

function formatClock(tick: number, tickRate: number): string {
  const seconds = Math.max(0, Math.round(tick / tickRate));
  const minutes = Math.floor(seconds / 60);
  return `${minutes}:${String(seconds % 60).padStart(2, "0")}`;
}

function formatCoachAnswer(text: string): string {
  return text
    .replace(/。；/g, "；")
    .replace(/；。/g, "；")
    .replace(/。{2,}/g, "。")
    .trim();
}

function currentPlayerScene(view: ReplayViewModel, player: MatchPlayer, tick: number) {
  if (view.player_states.length > 0) {
    return sampleStateAtTick(view.player_states, player.player_id, tick);
  }
  const track = view.timeline.tracks.find((candidate) => candidate.player_id === player.player_id);
  return track ? sampleTrackAtTick(track, tick) : undefined;
}

function roundContextAtTick(timeline: MatchTimeline, tick: number) {
  const exact = timeline.rounds.find(
    (round) => tick >= round.start_tick && tick < round.end_tick
  );
  if (exact) return { round: exact, isTransition: false };

  const previous = [...timeline.rounds]
    .filter((round) => round.end_tick <= tick)
    .sort((left, right) => right.end_tick - left.end_tick)[0];
  const next = timeline.rounds.find((round) => round.start_tick > tick);
  return {
    round: previous ?? next ?? getRoundAtTick(timeline, tick),
    isTransition: Boolean(previous && next)
  };
}

function Timeline({
  timeline,
  plan,
  currentSegment,
  currentTick
}: {
  timeline: MatchTimeline;
  plan: ReviewPlan;
  currentSegment?: ReviewSegment;
  currentTick: number;
}) {
  const totalTicks = timeline.end_tick - timeline.start_tick;
  return (
    <section className="timeline" aria-label="完整比赛复盘时间轴">
      <div className="timeline-heading">
        <div>
          <span className="eyebrow">完整覆盖</span>
          <strong>{timeline.rounds.length} 回合 · {plan.segments.length} 个连续区间</strong>
        </div>
        <span>{Math.min(100, Math.round(((currentTick - timeline.start_tick) / totalTicks) * 100))}%</span>
      </div>
      <div className="timeline-track">
        {plan.segments.map((segment) => {
          const width = ((segment.end_tick - segment.start_tick) / totalTicks) * 100;
          const active = segment.id === currentSegment?.id;
          const done = currentTick >= segment.end_tick;
          return (
            <div
              className={`timeline-segment mode-${segment.mode.toLowerCase()} ${active ? "is-active" : ""} ${done ? "is-done" : ""}`}
              key={segment.id}
              style={{ width: `${width}%` }}
              title={`第 ${segment.round_number} 回合 · ${modeLabels[segment.mode]} · ${segment.display_reason}`}
            >
              <span>{segment.round_number}</span>
            </div>
          );
        })}
        <div
          className="timeline-playhead"
          style={{ transform: `translateX(${Math.min(100, Math.max(0, ((currentTick - timeline.start_tick) / totalTicks) * 100))}%)` }}
        />
      </div>
      <div className="timeline-legend" aria-label="时间轴图例">
        {(["SKIP", "BRIEF", "OBSERVE", "DEEP_DIVE", "HABIT_CHECK"] as ReviewMode[]).map(
          (mode) => (
            <span key={mode}><i className={`legend-${mode.toLowerCase()}`} />{modeLabels[mode]}</span>
          )
        )}
      </div>
    </section>
  );
}

function CoachContent({
  timeline,
  plan,
  isFixture,
  phase,
  segment,
  cue,
  revealed,
  answer,
  question,
  onQuestionChange,
  onQuestionSubmit,
  dispatch,
  setRunning,
  running
}: {
  timeline: MatchTimeline;
  plan: ReviewPlan;
  isFixture: boolean;
  phase: CoachingSessionPhase;
  segment?: ReviewSegment;
  cue?: CoachCue;
  revealed: boolean;
  answer?: QuestionAnswer;
  question: string;
  onQuestionChange: (value: string) => void;
  onQuestionSubmit: (event: FormEvent) => void;
  dispatch: (action: SessionAction) => void;
  setRunning: (running: boolean) => void;
  running: boolean;
}) {
  if (phase === "INTRO") {
    const estimatedMinutes = Math.max(1, Math.round(plan.estimated_duration_seconds / 60));
    return (
      <div className="coach-state" key="intro">
        <span className="coach-kicker">本场开场</span>
        <h1>我会带你看完，<br />不是先扔给你结论。</h1>
        <p>{isFixture
          ? `这是一场 ${timeline.rounds.length} 回合的合成验证局。低价值片段会明确跳过，关键选择会在结果发生前暂停。`
          : `这场真实 Demo 共 ${timeline.rounds.length} 回合。AI 已先看完整场并排好路线：普通片段明确带过，关键选择会在结果发生前暂停。`}</p>
        <div className="intro-facts">
          <span><b>约 {estimatedMinutes} 分钟</b>复盘时长</span>
          <span><b>{plan.cues.length} 个</b>决策讲解点</span>
          <span><b>100%</b>时间轴覆盖</span>
        </div>
        <button className="primary-action" onClick={() => dispatch({ type: "START" })}>
          从第一回合开始
          <span aria-hidden="true">→</span>
        </button>
        <small>{isFixture
          ? "结构与节奏可运行；画面数据是合成夹具，不是实际 Demo tick。"
          : "地图是讲解证据画布；事实来自真实 Demo，建议来自版本化规则，缺失信息会明确说明。"}</small>
      </div>
    );
  }

  if (phase === "WRAP_UP" || phase === "COMPLETED") {
    return null;
  }

  if (!segment) return null;

  if (phase === "SKIPPING") {
    const seconds = Math.round((segment.end_tick - segment.start_tick) / timeline.tick_rate);
    return (
      <div className="coach-state" key={segment.id}>
        <span className="coach-kicker">第 {segment.round_number} 回合 · 建议跳过</span>
        <h2>这里没有教学增量。</h2>
        <p>{segment.display_reason}</p>
        <div className="skip-duration"><strong>{seconds}</strong><span>秒将被显式带过</span></div>
        <div className="action-row">
          <button className="primary-action" onClick={() => dispatch({ type: "SKIP_SEGMENT" })}>
            跳到下一段 <span aria-hidden="true">→</span>
          </button>
          <button className="secondary-action" onClick={() => { dispatch({ type: "EXPAND_SKIP" }); setRunning(true); }}>
            展开播放
          </button>
        </div>
      </div>
    );
  }

  if (phase === "PLAYING") {
    const cueAhead = cue && !revealed;
    return (
      <div className="coach-state" key={`${segment.id}-playing`}>
        <span className="coach-kicker">第 {segment.round_number} 回合 · {modeLabels[segment.mode]}</span>
        <h2>{cueAhead ? "先看局面怎么形成。" : segment.mode === "OBSERVE" ? "这次处理值得保留。" : "这段快速带过。"}</h2>
        <p>{segment.display_reason}</p>
        {cueAhead ? (
          <button className="primary-action" onClick={() => dispatch({ type: "TICK", tick: cue.decision_tick })}>
            快进到决策前 <span aria-hidden="true">→</span>
          </button>
        ) : (
          <button className="primary-action" onClick={() => dispatch({ type: "ADVANCE_SEGMENT" })}>
            本段看完，继续 <span aria-hidden="true">→</span>
          </button>
        )}
      </div>
    );
  }

  if (!cue) return null;

  const observableFacts = cue.facts.filter((fact) => cue.observable_fact_refs.includes(fact.id));
  const outcomeFacts = cue.facts.filter((fact) => fact.availability === "OUTCOME");

  if (phase === "REVEALING" || phase === "REPLAYING") {
    const playbackLabel = phase === "REVEALING" ? "播放真实结果" : "回看结果";
    return (
      <div className="coach-state" key={`${cue.id}-${phase}`}>
        <span className="coach-kicker">第 {segment.round_number} 回合 · {playbackLabel}</span>
        <h2>{running ? `${playbackLabel}中。` : `${playbackLabel}已暂停。`}</h2>
        <p>
          {running
            ? "请看下方地图和播放条；播放完成后会自动回到结果卡片。"
            : "播放已暂停，点击下方播放按钮继续；也可以用前后 5 秒检查这段画面。"}
        </p>
        <div className="playback-status" role="status" aria-live="polite">
          <i aria-hidden="true" />
          <span>{running ? "自动播放进行中" : "已暂停，等待继续"}</span>
        </div>
      </div>
    );
  }

  return (
    <div className="coach-state" key={`${cue.id}-${revealed ? "revealed" : "decision"}`}>
      <span className="coach-kicker">
        第 {segment.round_number} 回合 · {revealed ? "结果已揭示" : "决策前暂停"}
      </span>
      <h2>{cue.title}</h2>
      <p className="coach-question">{cue.question}</p>

      <div className="evidence-block">
        <span>你当时能知道</span>
        {observableFacts.map((fact) => <p key={fact.id}>{fact.text}</p>)}
      </div>

      {!revealed ? (
        <>
          <div className="inference-block">
            <span>教练判断 · {Math.round(cue.confidence * 100)}% 置信</span>
            <p>{cue.inferences[0]?.text}</p>
          </div>
          <button
            className="primary-action reveal-action"
            onClick={() => { dispatch({ type: "REVEAL_OUTCOME" }); setRunning(true); }}
          >
            播放真实结果 <span aria-hidden="true">▶</span>
          </button>
        </>
      ) : (
        <>
          <div className="outcome-block">
            <span>真实结果</span>
            {outcomeFacts.map((fact) => <p key={fact.id}>{fact.text}</p>)}
          </div>
          <div className="advice-block">
            <span>下次这样执行</span>
            <p>{cue.advice[0]?.text}</p>
          </div>
          <div className="action-row">
            <button className="primary-action" onClick={() => dispatch({ type: "ADVANCE_SEGMENT" })}>
              记住了，继续 <span aria-hidden="true">→</span>
            </button>
            <button
              className="secondary-action"
              onClick={() => { dispatch({ type: "REPLAY_OUTCOME" }); setRunning(true); }}
            >
              再看一遍
            </button>
          </div>
        </>
      )}

      <form className="question-form" onSubmit={onQuestionSubmit}>
        <label htmlFor="coach-question">围绕当前局面追问</label>
        <div>
          <input
            id="coach-question"
            value={question}
            onChange={(event) => onQuestionChange(event.target.value)}
            placeholder="例如：如果队友有语音指令呢？"
          />
          <button type="submit" disabled={!question.trim()} aria-label="发送追问">↑</button>
        </div>
      </form>
      {answer ? (
        <div className="answer-block" role="status">
          <p>{formatCoachAnswer(answer.text)}</p>
          <span>引用 {answer.citation_refs.join(" · ")}</span>
          {answer.limitation ? <small>{answer.limitation}</small> : null}
        </div>
      ) : null}
      <p className="limitation">{cue.limitations[0]}</p>
    </div>
  );
}

export function ReviewExperience({
  view = fixtureView,
  onOpenFreeReplay,
  onChangeDemo
}: {
  view?: ReplayViewModel;
  onOpenFreeReplay?: () => void;
  onChangeDemo?: () => void;
} = {}) {
  const { timeline } = view;
  const isFixture = view.source_kind === "SYNTHETIC_FIXTURE";
  const plan = view.review_plan ?? (isFixture ? createFixtureReviewPlan(timeline) : undefined);
  if (!plan) {
    throw new Error("A real coaching session requires a generated ReviewPlan.");
  }
  const activePlan: ReviewPlan = plan;
  const [state, dispatch] = useReducer(
    (current: ReturnType<typeof createCoachingSession>, action: SessionAction) =>
      reduceCoachingSession(activePlan, current, action),
    activePlan,
    (initialPlan) => createCoachingSession(initialPlan, `session-${initialPlan.id}`)
  );
  const [running, setRunning] = useState(false);
  const [showGroundTruth, setShowGroundTruth] = useState(false);
  const [perspective, setPerspective] = useState<ReplayPerspective>("PLAYER_KNOWLEDGE");
  const [selectedPlayerId, setSelectedPlayerId] = useState(timeline.selected_player_id);
  const [question, setQuestion] = useState("");
  const [answer, setAnswer] = useState<QuestionAnswer>();

  const segment = getCurrentSegment(activePlan, state);
  const cue = getCurrentCue(activePlan, state);
  const revealed = cue ? state.revealed_cue_ids.includes(cue.id) : false;
  const { round, isTransition } = roundContextAtTick(timeline, state.current_tick);
  const selected = timeline.players.find((player) => player.is_selected);
  if (!selected) throw new Error("Replay plan has no selected player.");

  const aliveCounts = timeline.players.reduce(
    (counts, player) => {
      const scene = currentPlayerScene(view, player, state.current_tick);
      if (scene?.alive) {
        const side = "side" in scene ? scene.side : player.side;
        counts[side] += 1;
      }
      return counts;
    },
    { T: 0, CT: 0 }
  );

  const canShowGroundTruth = !cue || revealed;
  const isPlaybackPhase = ["PLAYING", "REVEALING", "REPLAYING"].includes(state.phase);
  const summary = useMemo(
    () => (state.phase === "WRAP_UP" || state.phase === "COMPLETED" ? buildSessionSummary(activePlan, state) : undefined),
    [activePlan, state]
  );

  useEffect(() => {
    if (!running || !isPlaybackPhase) return;
    const timer = window.setInterval(() => {
      const speed = state.phase === "REVEALING" || state.phase === "REPLAYING"
        ? 0.75
        : segment?.playback_speed ?? 1;
      const step = Math.max(1, Math.round(timeline.tick_rate * speed * 0.08));
      dispatch({ type: "TICK", tick: state.current_tick + step });
    }, 80);
    return () => window.clearInterval(timer);
  }, [isPlaybackPhase, running, segment?.playback_speed, state.current_tick, state.phase]);

  useEffect(() => {
    if (!isPlaybackPhase) setRunning(false);
  }, [isPlaybackPhase]);

  useEffect(() => {
    if (!canShowGroundTruth) {
      setShowGroundTruth(false);
      setPerspective("PLAYER_KNOWLEDGE");
    }
  }, [canShowGroundTruth]);

  useEffect(() => {
    setQuestion("");
    setAnswer(undefined);
  }, [cue?.id]);

  function submitQuestion(event: FormEvent) {
    event.preventDefault();
    if (!question.trim()) return;
    const nextAnswer = answerCurrentCueQuestion(activePlan, state, question);
    setAnswer(nextAnswer);
    dispatch({ type: "QUESTION_ASKED", question });
    setQuestion("");
  }

  const showAnnotations = Boolean(
    cue && ["PAUSED_FOR_COACHING", "REVEALING", "REPLAYING"].includes(state.phase)
  );

  return (
    <main className="app-shell">
      <header className="topbar">
        <div className="brand-lockup">
          <div className="brand-mark" aria-hidden="true"><i /><i /><i /></div>
          <div><strong>Demo Coach</strong><span>CS2 · Mirage</span></div>
        </div>
        <div className="source-status">
          <span className="status-dot" />
          {isFixture ? "合成纵向夹具" : "真实 Demo · AI 路线"}
          <small>{isFixture ? "非真实 Demo 解析" : `${activePlan.cues.length} 个可追溯讲解点`}</small>
        </div>
        <div className="session-utility-actions">
          {onOpenFreeReplay ? <button type="button" className="fixture-back-button" onClick={onOpenFreeReplay}>自由复查</button> : null}
          {onChangeDemo ? <button type="button" className="fixture-back-button" onClick={onChangeDemo}>选择其他 Demo</button> : null}
        </div>
        <div className="session-status">
          <span>{phaseLabels[state.phase]}</span>
          <b>{Math.min(activePlan.segments.length, state.current_segment_index + 1)} / {activePlan.segments.length}</b>
        </div>
      </header>

      <div className="review-grid">
        <section className="player-column" aria-label="二维回放与完整时间轴">
          <div className="player-stage">
            <div className="hud-row">
              <div className="score-block"><span>T</span><strong>{round.score_before[0]}</strong></div>
              <div className="round-block">
                <span>{isTransition ? `第 ${round.round_number} 回合结束` : `第 ${round.round_number} 回合`}</span>
                <strong>{formatClock(state.current_tick, timeline.tick_rate)}</strong>
                <small>tick {Math.round(state.current_tick)}</small>
              </div>
              <div className="score-block ct"><strong>{round.score_before[1]}</strong><span>CT</span></div>
            </div>

            <div className="map-wrap">
              <ReplayViewer
                view={view}
                tick={state.current_tick}
                perspective={perspective}
                cue={cue}
                showAnnotations={showAnnotations}
                selectedPlayerId={selectedPlayerId}
                onSelectPlayer={setSelectedPlayerId}
              />
              <div className="alive-hud"><span className="t-alive">{aliveCounts.T}</span><i />{aliveCounts.CT}<span className="ct-label"> 存活</span></div>
              <div className="perspective-control" role="group" aria-label="回放信息视角">
                <button
                  className={!showGroundTruth ? "is-selected" : ""}
                  onClick={() => { setShowGroundTruth(false); setPerspective("PLAYER_KNOWLEDGE"); }}
                  aria-pressed={!showGroundTruth}
                >玩家已知</button>
                <button
                  className={showGroundTruth ? "is-selected" : ""}
                  onClick={() => { setShowGroundTruth(true); setPerspective("OMNISCIENT"); }}
                  aria-pressed={showGroundTruth}
                  disabled={!canShowGroundTruth}
                  title={!canShowGroundTruth ? "先播放真实结果，避免决策前泄漏未来信息" : undefined}
                >完整复盘</button>
              </div>
              {!canShowGroundTruth ? <div className="future-lock">决策前隐藏未来敌情</div> : null}
            </div>

            <div className="playback-bar">
              <button
                className="icon-action"
                aria-label="后退 5 秒"
                onClick={() => dispatch({ type: "SEEK", tick: state.current_tick - timeline.tick_rate * 5 })}
                disabled={state.phase === "INTRO" || state.phase === "WRAP_UP" || state.phase === "COMPLETED"}
              >−5</button>
              <button
                className="play-action"
                aria-label={running ? "暂停" : "播放"}
                onClick={() => setRunning((value) => !value)}
                disabled={!isPlaybackPhase}
              ><span aria-hidden="true">{running ? "Ⅱ" : "▶"}</span></button>
              <button
                className="icon-action"
                aria-label="前进 5 秒"
                onClick={() => dispatch({ type: "SEEK", tick: state.current_tick + timeline.tick_rate * 5 })}
                disabled={state.phase === "INTRO" || state.phase === "WRAP_UP" || state.phase === "COMPLETED"}
              >+5</button>
              <div className="playback-meta">
                <span>{segment ? `${modeLabels[segment.mode]} · ${segment.playback_speed}×` : "复盘结束"}</span>
                <div><i style={{ transform: `scaleX(${Math.max(0.005, (state.current_tick - (segment?.start_tick ?? 0)) / Math.max(1, (segment?.end_tick ?? timeline.end_tick) - (segment?.start_tick ?? 0)))})` }} /></div>
              </div>
            </div>
          </div>

          <Timeline timeline={timeline} plan={activePlan} currentSegment={segment} currentTick={state.current_tick} />
        </section>

        <aside className="coach-panel" aria-label="AI 教练窗口">
          <div className="coach-header">
            <div className="coach-avatar" aria-hidden="true"><span>AI</span></div>
            <div><strong>你的 Demo 教练</strong><span>只引用当前可用证据</span></div>
            <div
              className={`phase-indicator phase-${state.phase.toLowerCase()}`}
              aria-live="polite"
            ><i />{phaseLabels[state.phase]}</div>
          </div>

          <div className="coach-scroll">
            {summary ? (
              <div className="summary-state">
                <span className="coach-kicker">全场总结 · 已解锁</span>
                <h1>这一场，先改一个习惯。</h1>
                <div className="summary-hero">
                  <span>{summary.habit_occurrences} 次</span>
                  <p>{summary.habit_title}</p>
                  <small>代表回合 {summary.representative_rounds.join("、")}</small>
                </div>
                <section><span>做得好的地方</span><p>{summary.positive}</p></section>
                <section className="goal-section"><span>下一场唯一目标</span><p>{summary.next_match_goal}</p></section>
                <div className="checkpoints">
                  {summary.checkpoints.map((checkpoint, index) => <p key={checkpoint}><b>{index + 1}</b>{checkpoint}</p>)}
                </div>
                {state.phase === "WRAP_UP" ? (
                  <button className="primary-action" onClick={() => dispatch({ type: "COMPLETE_SESSION" })}>
                    完成本次复盘 <span aria-hidden="true">✓</span>
                  </button>
                ) : <div className="completion-note"><i /> 本次复盘已完成，所有结论均来自已观看节点。</div>}
              </div>
            ) : (
              <CoachContent
                timeline={timeline}
                plan={activePlan}
                isFixture={isFixture}
                phase={state.phase}
                segment={segment}
                cue={cue}
                revealed={revealed}
                answer={answer}
                question={question}
                onQuestionChange={setQuestion}
                onQuestionSubmit={submitQuestion}
                dispatch={dispatch}
                setRunning={setRunning}
                running={running}
              />
            )}
          </div>

          <footer className="coach-footer">
            <span className={summary ? "is-unlocked" : ""}><i />{summary ? "总结已生成" : "看完最后一回合后解锁总结"}</span>
            <button aria-label="复盘信息" title={isFixture ? "当前为本地合成夹具" : `真实 Demo · ${activePlan.generation_manifest.planner_version}`}>ⓘ</button>
          </footer>
        </aside>
      </div>
    </main>
  );
}

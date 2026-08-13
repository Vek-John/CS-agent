"use client";

import { useEffect, useRef, useState } from "react";
import type { MatchEvent } from "@cs-coach/contracts";
import { ReplayViewer, type ReplayPerspective } from "./replay-viewer";
import { ReviewExperience } from "./review-experience";
import {
  loadReplayBundle,
  type ReplayViewModel,
  REPLAY_BUNDLE_URL
} from "../lib/replay-bundle";

function eventLabel(event: MatchEvent): string {
  const actor = event.actor_player_id ? ` · ${event.actor_player_id}` : "";
  return `${event.event_type}${actor}`;
}

function formatTick(tick: number, tickRate: number): string {
  const seconds = Math.max(0, Math.floor(tick / tickRate));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

interface LocalDemoPlayer {
  player_id: string;
  display_name: string;
  side?: "T" | "CT";
}

interface LocalDemoJob {
  id: string;
  status: "INSPECTING" | "AWAITING_PLAYER" | "ANALYZING" | "READY" | "FAILED";
  original_name: string;
  size_bytes: number;
  map_name?: string;
  players: LocalDemoPlayer[];
  selected_player_id?: string;
  bundle_url?: string;
  error?: string;
}

function formatFileSize(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(bytes >= 100 * 1024 * 1024 ? 0 : 1)} MB`;
}

async function readJsonResponse<T>(response: Response): Promise<T> {
  const payload = await response.json() as T & { error?: string };
  if (!response.ok) throw new Error(payload.error || `请求失败（HTTP ${response.status}）`);
  return payload;
}

function DemoIntake({
  job,
  busy,
  error,
  onFile,
  onAnalyze,
  onOpenSample
}: {
  job?: LocalDemoJob;
  busy: boolean;
  error?: string;
  onFile: (file: File) => void;
  onAnalyze: (playerId: string) => void;
  onOpenSample: () => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const awaitingPlayer = job?.status === "AWAITING_PLAYER";
  const unknownPlayers = job?.players.filter((player) => player.side !== "T" && player.side !== "CT") ?? [];
  return (
    <main className="demo-intake-shell">
      <header className="demo-intake-topbar">
        <div className="replay-brand">
          <span className="replay-brand-mark">AI</span>
          <span><b>Demo Coach</b><small>localhost · 数据留在本机</small></span>
        </div>
        <span className="replay-source-badge is-real">选择 Demo → 选择玩家 → AI 带看</span>
      </header>

      <section className="demo-intake-card" aria-live="polite">
        <input
          ref={inputRef}
          className="demo-file-input"
          type="file"
          accept=".dem,application/octet-stream"
          onChange={(event) => {
            const file = event.currentTarget.files?.[0];
            if (file) onFile(file);
            event.currentTarget.value = "";
          }}
        />
        <div className="demo-intake-copy">
          <span className="replay-eyebrow">START A REVIEW</span>
          <h1>{awaitingPlayer ? "这场要分析谁？" : "选择一场 CS2 Demo"}</h1>
          <p>{awaitingPlayer
            ? "AI 会以所选玩家为观察者，重新生成当时可知信息、关键暂停点和全场路线。"
            : "选择本机文件夹里的 .dem。先只读取比赛和玩家名单；你确认玩家之后，才开始完整分析。"}</p>
        </div>

        {!awaitingPlayer ? (
          <div className="demo-file-picker">
            <button
              type="button"
              className="demo-file-button"
              onClick={() => inputRef.current?.click()}
              disabled={busy}
            >
              <span className="demo-file-icon" aria-hidden="true">＋</span>
              <b>{busy ? "正在读取 Demo…" : "选择本地 .dem"}</b>
              <small>单个文件 · 最大 512 MB · 不上传到外网</small>
            </button>
          </div>
        ) : null}

        {job ? (
          <div className="demo-job-summary">
            <div><span>文件</span><b>{job.original_name}</b></div>
            <div><span>地图</span><b>{job.map_name || "解析器未提供"}</b></div>
            <div><span>大小</span><b>{formatFileSize(job.size_bytes)}</b></div>
            <div><span>玩家</span><b>{job.players.length}</b></div>
          </div>
        ) : null}

        {awaitingPlayer ? (
          <div className="demo-player-picker" role="list" aria-label="选择 AI 分析玩家">
            {(["T", "CT"] as const).map((side) => (
              <section key={side}>
                <header><span className={`side-dot is-${side.toLowerCase()}`} />{side === "T" ? "进攻方" : "防守方"}</header>
                {job.players.filter((player) => player.side === side).map((player) => (
                  <button
                    type="button"
                    role="listitem"
                    key={player.player_id}
                    onClick={() => onAnalyze(player.player_id)}
                    disabled={busy}
                  >
                    <span>{player.display_name.slice(0, 1).toUpperCase()}</span>
                    <b>{player.display_name}</b>
                    <small>{player.player_id.slice(-6)}</small>
                    <i aria-hidden="true">→</i>
                  </button>
                ))}
              </section>
            ))}
            {unknownPlayers.length > 0 ? (
              <section>
                <header>阵营未提供</header>
                {unknownPlayers.map((player) => (
                  <button
                    type="button"
                    role="listitem"
                    key={player.player_id}
                    onClick={() => onAnalyze(player.player_id)}
                    disabled={busy}
                  >
                    <span>{player.display_name.slice(0, 1).toUpperCase()}</span>
                    <b>{player.display_name}</b>
                    <small>{player.player_id.slice(-6)}</small>
                    <i aria-hidden="true">→</i>
                  </button>
                ))}
              </section>
            ) : null}
          </div>
        ) : null}

        {job?.status === "ANALYZING" ? (
          <div className="demo-analysis-progress" role="status">
            <i aria-hidden="true" />
            <div><b>正在为 {job.players.find((player) => player.player_id === job.selected_player_id)?.display_name} 生成 AI 路线</b><span>解析完整时间轴、玩家已知信息、投掷物与教学节点…</span></div>
          </div>
        ) : null}
        {error || job?.error ? <div className="demo-intake-error" role="alert">{error || job?.error}</div> : null}

        <footer className="demo-intake-footer">
          {awaitingPlayer ? <button type="button" onClick={() => inputRef.current?.click()} disabled={busy}>换一个 Demo</button> : null}
          <button type="button" onClick={onOpenSample} disabled={busy}>打开内置真实样本</button>
          <span>支持 CS2 PBDEMS2 · 原始文件默认保存在本机 `.local-data`</span>
        </footer>
      </section>
    </main>
  );
}

function NotReady({
  title,
  detail,
  loading,
  onOpenFixture
}: {
  title: string;
  detail: string;
  loading?: boolean;
  onOpenFixture: () => void;
}) {
  return (
    <main className="replay-shell replay-not-ready">
      <header className="replay-topbar">
        <div className="replay-brand">
          <span className="replay-brand-mark">R</span>
          <span><b>CS2 Replay</b><small>Web2D localhost viewer</small></span>
        </div>
        <span className="replay-source-badge is-pending">{loading ? "正在检查 ReplayBundle" : "真实回放未就绪"}</span>
      </header>
      <section className="not-ready-card" aria-live="polite">
        <span className="replay-eyebrow">REAL DEMO REPLAY</span>
        <h1>{title}</h1>
        <p>{detail}</p>
        <div className="not-ready-path">
          <code>{REPLAY_BUNDLE_URL}</code>
          <small>生成文件出现后刷新页面；不会自动以合成夹具替代真实回放。</small>
        </div>
        <div className="not-ready-actions">
          <button type="button" className="replay-primary-button" onClick={() => window.location.reload()}>
            重新检查
          </button>
          <button type="button" className="replay-secondary-button" onClick={onOpenFixture}>
            进入 AI 带看合成夹具
          </button>
        </div>
      </section>
    </main>
  );
}

function RealReplayScreen({
  view,
  onOpenCoaching,
  onChangeDemo
}: {
  view: ReplayViewModel;
  onOpenCoaching: () => void;
  onChangeDemo: () => void;
}) {
  const { timeline } = view;
  const [tick, setTick] = useState(timeline.start_tick);
  const [playing, setPlaying] = useState(false);
  const [perspective, setPerspective] = useState<ReplayPerspective>("OMNISCIENT");
  const [selectedPlayerId, setSelectedPlayerId] = useState(timeline.selected_player_id);

  useEffect(() => {
    setTick(timeline.start_tick);
    setPlaying(false);
    setSelectedPlayerId(timeline.selected_player_id);
  }, [timeline]);

  useEffect(() => {
    if (!playing) return;
    const timer = window.setInterval(() => {
      setTick((currentTick) => {
        const nextTick = currentTick + Math.max(1, Math.round(timeline.tick_rate * 0.1));
        if (nextTick >= timeline.end_tick) {
          setPlaying(false);
          return timeline.end_tick - 1;
        }
        return nextTick;
      });
    }, 100);
    return () => window.clearInterval(timer);
  }, [playing, timeline.end_tick, timeline.tick_rate]);

  const currentEvents = view.events
    .filter((event) => event.tick <= tick)
    .slice(-6)
    .reverse();
  const progress = ((tick - timeline.start_tick) / Math.max(1, timeline.end_tick - timeline.start_tick)) * 100;

  return (
    <main className="replay-shell">
      <header className="replay-topbar">
        <div className="replay-brand">
          <span className="replay-brand-mark">AI</span>
          <span><b>Demo Coach</b><small>{timeline.map_name} · 讲解证据画布</small></span>
        </div>
        <div className="replay-topbar-meta">
          <span className="replay-source-badge is-real">辅助模式 · 自由复查</span>
          <button type="button" className="replay-mode-button" onClick={onOpenCoaching}>
            {view.review_plan ? "返回 AI 带看" : "体验 AI 带看夹具"}
          </button>
          <button type="button" className="replay-mode-button" onClick={onChangeDemo}>选择其他 Demo</button>
        </div>
      </header>

      <div className="real-replay-grid">
        <section className="real-replay-main" aria-label="真实 Demo 回放">
          <div className="real-replay-heading">
            <div>
              <span className="replay-eyebrow">EVIDENCE CANVAS · SECONDARY</span>
              <h1>Mirage · 自由复查</h1>
            </div>
            <span className="real-replay-version">timeline {timeline.timeline_version}</span>
          </div>

          <div className="real-viewer-stage">
            <div className="real-viewer-hud">
              <span><b>{timeline.players.length}</b> players</span>
              <span><b>{timeline.tick_rate}</b> tick/s</span>
              <span>当前 <b>{formatTick(tick, timeline.tick_rate)}</b></span>
            </div>
            <div className="real-perspective-control" role="group" aria-label="回放信息视角">
              <button
                type="button"
                className={perspective === "OMNISCIENT" ? "is-selected" : ""}
                aria-pressed={perspective === "OMNISCIENT"}
                onClick={() => setPerspective("OMNISCIENT")}
              >全知回放</button>
              <button
                type="button"
                className={perspective === "PLAYER_KNOWLEDGE" ? "is-selected" : ""}
                aria-pressed={perspective === "PLAYER_KNOWLEDGE"}
                onClick={() => setPerspective("PLAYER_KNOWLEDGE")}
              >玩家已知</button>
            </div>
            <ReplayViewer
              view={view}
              tick={tick}
              perspective={perspective}
              selectedPlayerId={selectedPlayerId}
              onSelectPlayer={setSelectedPlayerId}
            />
          </div>

          <div className="real-playback-controls">
            <button type="button" className="real-play-button" onClick={() => setPlaying((value) => !value)} aria-label={playing ? "暂停回放" : "播放回放"}>
              {playing ? "Ⅱ" : "▶"}
            </button>
            <button type="button" onClick={() => setTick((value) => Math.max(timeline.start_tick, value - timeline.tick_rate * 5))}>−5s</button>
            <button type="button" onClick={() => setTick((value) => Math.min(timeline.end_tick - 1, value + timeline.tick_rate * 5))}>+5s</button>
            <div className="real-time-slider">
              <input
                type="range"
                min={timeline.start_tick}
                max={Math.max(timeline.start_tick, timeline.end_tick - 1)}
                value={tick}
                onChange={(event) => { setPlaying(false); setTick(Number(event.target.value)); }}
                aria-label="Demo 时间轴"
              />
              <div className="real-time-progress" style={{ transform: `scaleX(${Math.max(0, Math.min(1, progress / 100))})` }} aria-hidden="true" />
            </div>
            <span className="real-time-label">{formatTick(tick, timeline.tick_rate)} / {formatTick(timeline.end_tick, timeline.tick_rate)}</span>
          </div>
        </section>

        <aside className="real-replay-side" aria-label="AI 讲解证据信息">
          <div className="real-side-card">
            <span className="replay-eyebrow">COACHING EVIDENCE</span>
            <h2>地图为讲解提供证据</h2>
            <p>{view.detail}</p>
            <dl className="replay-facts">
              <div><dt>来源</dt><dd>PARSED_DEMO</dd></div>
              <div><dt>玩家状态</dt><dd>{view.player_states.length} samples</dd></div>
              <div><dt>事件</dt><dd>{view.events.length} events</dd></div>
              <div><dt>投掷物轨迹</dt><dd>{view.grenade_tracks.length || "未提供"}</dd></div>
              <div><dt>ReviewPlan</dt><dd>{view.review_plan ? "已生成" : "尚未生成"}</dd></div>
            </dl>
            {!view.review_plan ? <div className="real-plan-limit">ReviewPlan 尚未生成。这里不展示 AI 结论，也不把真实 Demo 假装成已分析的带看。</div> : null}
          </div>
          <div className="real-side-card">
            <div className="real-side-card-heading"><span className="replay-eyebrow">EVENT FEED</span><small>当前 tick 前</small></div>
            {currentEvents.length > 0 ? (
              <div className="real-event-list">
                {currentEvents.map((event) => <p key={event.id}><b>{formatTick(event.tick, timeline.tick_rate)}</b><span>{eventLabel(event)}</span></p>)}
              </div>
            ) : <p className="real-empty-state">当前时间点之前没有可展示事件。</p>}
          </div>
        </aside>
      </div>
    </main>
  );
}

export function RealReplayExperience() {
  const [view, setView] = useState<ReplayViewModel>();
  const [screen, setScreen] = useState<"INTAKE" | "FREE_REPLAY" | "COACHING" | "FIXTURE">("INTAKE");
  const [job, setJob] = useState<LocalDemoJob>();
  const [busy, setBusy] = useState(false);
  const [intakeError, setIntakeError] = useState<string>();
  const [bundleUrl, setBundleUrl] = useState(REPLAY_BUNDLE_URL);

  useEffect(() => {
    let active = true;
    loadReplayBundle(bundleUrl).then((nextView) => {
      if (active) setView(nextView);
    });
    return () => { active = false; };
  }, [bundleUrl]);

  useEffect(() => {
    if (job?.status !== "ANALYZING") return;
    let active = true;
    const timer = window.setInterval(async () => {
      try {
        const nextJob = await readJsonResponse<LocalDemoJob>(await fetch(`/api/local-demo/${job.id}`, { cache: "no-store" }));
        if (!active) return;
        setJob(nextJob);
        if (nextJob.status === "READY" && nextJob.bundle_url) {
          setView(undefined);
          setBundleUrl(nextJob.bundle_url);
          setScreen("COACHING");
          setBusy(false);
        } else if (nextJob.status === "FAILED") {
          setBusy(false);
        }
      } catch (error) {
        if (active) {
          setIntakeError(error instanceof Error ? error.message : "无法读取分析进度。");
          setBusy(false);
        }
      }
    }, 1000);
    return () => { active = false; window.clearInterval(timer); };
  }, [job?.id, job?.status]);

  async function uploadDemo(file: File) {
    setBusy(true);
    setIntakeError(undefined);
    setJob(undefined);
    try {
      setJob(await readJsonResponse<LocalDemoJob>(await fetch("/api/local-demo", {
        method: "POST",
        headers: {
          "content-type": "application/octet-stream",
          "x-demo-name": encodeURIComponent(file.name),
          "x-demo-size": String(file.size)
        },
        body: file
      })));
    } catch (error) {
      setIntakeError(error instanceof Error ? error.message : "Demo 上传失败。");
    } finally {
      setBusy(false);
    }
  }

  async function analyzePlayer(playerId: string) {
    if (!job) return;
    setBusy(true);
    setIntakeError(undefined);
    try {
      const nextJob = await readJsonResponse<LocalDemoJob>(await fetch(`/api/local-demo/${job.id}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ selected_player_id: playerId })
      }));
      setJob(nextJob);
    } catch (error) {
      setBusy(false);
      setIntakeError(error instanceof Error ? error.message : "无法开始分析。");
    }
  }

  if (screen === "INTAKE") {
    return (
      <DemoIntake
        job={job}
        busy={busy}
        error={intakeError}
        onFile={uploadDemo}
        onAnalyze={analyzePlayer}
        onOpenSample={() => {
          if (bundleUrl !== REPLAY_BUNDLE_URL) setView(undefined);
          setBundleUrl(REPLAY_BUNDLE_URL);
          setScreen("COACHING");
        }}
      />
    );
  }

  if (screen === "FIXTURE") {
    return <ReviewExperience onOpenFreeReplay={() => setScreen("FREE_REPLAY")} />;
  }

  if (!view) {
    return <NotReady title="正在等待真实 ReplayBundle" detail="正在检查生成的真实 Demo 数据；加载期间不会用合成坐标伪装真实回放。" loading onOpenFixture={() => setScreen("COACHING")} />;
  }

  if (view.status !== "LOADED") {
    return <NotReady title="真实 Demo 尚未生成" detail={view.detail} onOpenFixture={() => setScreen("COACHING")} />;
  }

  if (screen === "COACHING" && view.review_plan) {
    return (
      <ReviewExperience
        view={view}
        onOpenFreeReplay={() => setScreen("FREE_REPLAY")}
        onChangeDemo={() => setScreen("INTAKE")}
      />
    );
  }

  return (
    <RealReplayScreen
      view={view}
      onOpenCoaching={() => setScreen(view.review_plan ? "COACHING" : "FIXTURE")}
      onChangeDemo={() => setScreen("INTAKE")}
    />
  );
}

"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  PlaybackBridgeEvent,
  PlaybackCommand,
  PlaybackStateEvent,
  PlayerSelectedEvent,
  ReplayReadyEvent
} from "@cs-coach/contracts";
import {
  acceptedPlaybackEvent,
  cs2dHostConfig,
  playbackCommandMessage
} from "../lib/cs2d-playback-host";

type HostPhase = "BOOTING" | "WAITING_FOR_DEMO" | "READY" | "ERROR";

export function Cs2dPlaybackHost() {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const config = useMemo(() => cs2dHostConfig(), []);
  const [phase, setPhase] = useState<HostPhase>("BOOTING");
  const [replay, setReplay] = useState<ReplayReadyEvent>();
  const [selected, setSelected] = useState<PlayerSelectedEvent>();
  const [playback, setPlayback] = useState<PlaybackStateEvent>();

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
        setSelected(undefined);
        setPhase("READY");
      } else if (payload.type === "PLAYER_SELECTED") {
        setSelected(payload);
      } else {
        setPlayback(payload);
      }
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [config.origin]);

  const send = useCallback((command: PlaybackCommand) => {
    iframeRef.current?.contentWindow?.postMessage(playbackCommandMessage(command), config.origin);
  }, [config.origin]);

  const tickMin = replay?.startCanonicalTick ?? 0;
  const tickMax = replay?.endCanonicalTick ?? Math.max(1, tickMin + 1);
  const tick = Math.min(tickMax, Math.max(tickMin, playback?.canonicalTick ?? tickMin));

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
              <h2>{selected ? `正在分析 ${selected.displayName}` : replay ? "先在地图内选择玩家" : "等待 Demo"}</h2>
            </div>
            <span className="cs2d-coach-badge">LOCAL</span>
          </div>

          <section className="cs2d-coach-card">
            <small>当前阶段</small>
            <p>{!replay ? "Demo 会留在浏览器，由 cs2d Worker 解析。" : !selected ? "选择本场分析主体后，教练会接管播放节奏。" : "回放已连接；AI 分析接线将在本纵向链路内生成。"}</p>
          </section>

          {replay ? (
            <dl className="cs2d-coach-facts">
              <div><dt>地图</dt><dd>{replay.map}</dd></div>
              <div><dt>玩家</dt><dd>{replay.players.length}</dd></div>
              <div><dt>回合</dt><dd>{replay.roundCount}</dd></div>
              <div><dt>Tick</dt><dd>{playback?.canonicalTick ?? "—"}</dd></div>
            </dl>
          ) : null}

          <div className="cs2d-host-controls" aria-label="回放控制">
            <button type="button" disabled={!replay} onClick={() => send({ type: playback?.playing ? "pause" : "play" })}>
              {playback?.playing ? "暂停" : "播放"}
            </button>
            {[1, 2, 4, 8].map((speed) => (
              <button key={speed} type="button" disabled={!replay} aria-pressed={playback?.speed === speed} onClick={() => send({ type: "setSpeed", speed })}>{speed}×</button>
            ))}
          </div>

          {replay ? (
            <div className="cs2d-round-list" aria-label="选择回合">
              {replay.rounds.map((round) => (
                <button key={`${round.roundIndex}-${round.roundNumber}`} type="button" aria-pressed={playback?.roundIndex === round.roundIndex} onClick={() => send({ type: "selectRound", roundIndex: round.roundIndex })}>
                  {round.roundNumber === 0 ? "准备" : `R${round.roundNumber}`}
                </button>
              ))}
            </div>
          ) : null}
        </aside>
      </section>

      <footer className="cs2d-host-timeline">
        <label htmlFor="canonical-tick">完整比赛进度</label>
        <input
          id="canonical-tick"
          type="range"
          min={tickMin}
          max={tickMax}
          value={tick}
          disabled={!replay}
          onChange={(event) => send({ type: "seekCanonicalTick", canonicalTick: Number(event.target.value) })}
        />
        <output>{replay ? `${Math.max(0, Math.round(((tick - tickMin) / Math.max(1, tickMax - tickMin)) * 100))}%` : "—"}</output>
      </footer>
    </main>
  );
}

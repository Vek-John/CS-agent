"use client";

import { useEffect, useMemo, useRef, useState, type ReactElement } from "react";
import { Application, Assets, Container } from "pixi.js";
import { loadMirageManifest } from "@cs-coach/map-semantics";
import {
  loadReplayBundle,
  type ReplayViewModel
} from "../../lib/replay/replay-bundle";
import {
  toGroundTruthReplaySource,
  toKnowledgeFrameInput,
  toObservationBoundaryInput,
  type ObservationBoundaryInput
} from "../../lib/legacy/pixi-poc/ground-truth-adapter";
import {
  buildKnowledgeFrame,
  buildOmniscientFrame,
  type GroundTruthReplaySource,
  type PlaybackFrameViewModel,
  type PlaybackPerspective
} from "../../lib/legacy/pixi-poc/playback-frame";
import { PixiPlaybackLayer } from "../../lib/legacy/pixi-poc/pixi-playback-layer";

const manifest = loadMirageManifest({ raster_ref: "/generated-assets/maps/de_mirage.png" });

interface Runtime {
  app: Application;
  layer: PixiPlaybackLayer;
  source: GroundTruthReplaySource;
  observation: ObservationBoundaryInput;
}

interface Camera {
  x: number;
  y: number;
  scale: number;
  initialized: boolean;
}

const pageStyles = {
  shell: {
    minHeight: "100vh",
    background: "#0b0f14",
    color: "#edf2f7",
    fontFamily: "ui-sans-serif, system-ui, -apple-system, sans-serif",
    padding: "clamp(12px, 3vw, 32px)"
  },
  content: { maxWidth: 1120, margin: "0 auto" },
  eyebrow: { color: "#9eb2c7", fontSize: 12, letterSpacing: "0.08em", textTransform: "uppercase" as const },
  title: { margin: "6px 0 4px", fontSize: "clamp(22px, 4vw, 34px)", letterSpacing: "-0.025em" },
  muted: { color: "#aebdca", lineHeight: 1.5, margin: 0 },
  panel: { background: "rgba(20, 28, 38, .9)", border: "1px solid #2a3643", borderRadius: 14, padding: 12 },
  controls: { display: "flex", flexWrap: "wrap" as const, gap: 8, alignItems: "center", margin: "14px 0 10px" },
  button: {
    border: "1px solid #435466",
    borderRadius: 8,
    background: "#17222d",
    color: "#eef4f8",
    minHeight: 36,
    padding: "0 12px",
    cursor: "pointer",
    font: "inherit"
  },
  activeButton: { background: "#d7e7f4", color: "#13202b", border: "1px solid #d7e7f4" },
  stage: {
    position: "relative" as const,
    width: "100%",
    height: "min(68vh, 720px)",
    minHeight: 320,
    overflow: "hidden",
    borderRadius: 14,
    border: "1px solid #344554",
    background: "#111a23",
    touchAction: "none",
    outline: "none"
  },
  timeline: { display: "grid", gap: 8, marginTop: 10 },
  range: { width: "100%", accentColor: "#9fc7e7" },
  status: { display: "flex", flexWrap: "wrap" as const, gap: "8px 16px", color: "#c5d0da", fontSize: 13 }
};

function progressLabel(status: ReplayViewModel["status"]): string {
  if (status === "LOADED") return "已解析 GroundTruth；未二次读取 .dem";
  if (status === "MISSING") return "ReplayBundle 未就绪";
  if (status === "INVALID") return "ReplayBundle 解析失败";
  return "等待真实 ReplayBundle";
}

export function PixiReplayPoc(): ReactElement {
  const hostRef = useRef<HTMLDivElement>(null);
  const runtimeRef = useRef<Runtime | undefined>(undefined);
  const cameraRef = useRef<Camera>({ x: 0, y: 0, scale: 1, initialized: false });
  const dragRef = useRef<{ pointerId: number; x: number; y: number } | undefined>(undefined);
  const tickRef = useRef(0);
  const maxTickRef = useRef(0);
  const playingRef = useRef(false);
  const perspectiveRef = useRef<PlaybackPerspective>("OMNISCIENT");
  const lastUiTickAt = useRef(0);
  const [source, setSource] = useState<GroundTruthReplaySource>();
  const [observation, setObservation] = useState<ObservationBoundaryInput>();
  const [runtimeReady, setRuntimeReady] = useState(false);
  const [perspective, setPerspective] = useState<PlaybackPerspective>("OMNISCIENT");
  const [tick, setTick] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [progress, setProgress] = useState(0);
  const [phase, setPhase] = useState("准备读取真实 ReplayBundle");
  const [status, setStatus] = useState<ReplayViewModel["status"]>("MISSING");
  const [detail, setDetail] = useState("正在读取本地生成资源…");
  const [roundLabel, setRoundLabel] = useState("—");

  useEffect(() => {
    let disposed = false;
    let resizeObserver: ResizeObserver | undefined;
    let app: Application | undefined;
    let layer: PixiPlaybackLayer | undefined;
    let tickerHandler: ((ticker: { deltaMS: number }) => void) | undefined;

    const initialize = async (): Promise<void> => {
      try {
        setPhase("读取 ReplayBundle");
        setProgress(12);
        const view = await loadReplayBundle();
        if (disposed) return;
        setStatus(view.status);
        setDetail(view.detail);
        if (view.status !== "LOADED" || view.source_kind !== "PARSED_DEMO") {
          setPhase(progressLabel(view.status));
          setProgress(100);
          return;
        }

        setPhase("建立一次性 GroundTruth 索引");
        setProgress(48);
        const groundTruth = toGroundTruthReplaySource(view);
        const boundary = toObservationBoundaryInput(view);
        const firstRound = groundTruth.rounds[0];
        const firstTick = firstRound?.start_tick ?? groundTruth.start_tick;
        const lastTick = firstRound?.end_tick ?? groundTruth.end_tick;
        tickRef.current = firstTick;
        maxTickRef.current = lastTick;
        setTick(firstTick);
        setRoundLabel(firstRound ? `R${firstRound.round_number}` : "全局");
        // Publishing the parsed inputs renders the stage host while the radar
        // texture is loading. A separate runtimeReady signal below guarantees
        // that the already-computed first frame is submitted once Pixi exists.
        setSource(groundTruth);
        setObservation(boundary);
        setPhase("加载本地 Valve Mirage radar");
        setProgress(76);
        const texture = await Assets.load(manifest.raster_ref);
        if (disposed) return;
        const host = hostRef.current;
        if (!host) throw new Error("Pixi PoC stage host is unavailable.");
        app = new Application();
        await app.init({
          background: 0x111a23,
          antialias: true,
          autoDensity: true,
          resolution: Math.min(window.devicePixelRatio || 1, 2),
          resizeTo: host
        });
        const scene = new Container();
        app.stage.addChild(scene);
        host.replaceChildren(app.canvas);
        layer = new PixiPlaybackLayer({ root: scene, radarTexture: texture, mapSize: 420 });
        runtimeRef.current = { app, layer, source: groundTruth, observation: boundary };
        setRuntimeReady(true);

        const resize = (): void => {
          const camera = cameraRef.current;
          const width = host.clientWidth;
          const height = host.clientHeight;
          const mapSize = Math.max(240, Math.min(width, height));
          layer?.setMapSize(mapSize);
          if (!camera.initialized) {
            camera.x = (width - mapSize) / 2;
            camera.y = (height - mapSize) / 2;
            camera.initialized = true;
          }
          layer?.setViewport(camera.x, camera.y, camera.scale);
        };
        resizeObserver = new ResizeObserver(resize);
        resizeObserver.observe(host);
        resize();

        tickerHandler = (ticker) => {
          if (!playingRef.current) return;
          const next = Math.min(maxTickRef.current, tickRef.current + (ticker.deltaMS / 1000) * groundTruth.tick_rate);
          tickRef.current = next;
          const renderTick = Math.round(next);
          layer?.update(
            perspectiveRef.current === "OMNISCIENT"
              ? buildOmniscientFrame(groundTruth, renderTick, manifest)
              : buildKnowledgeFrame(
                  toKnowledgeFrameInput(groundTruth, renderTick, boundary, manifest),
                  manifest
                )
          );
          const now = performance.now();
          if (now - lastUiTickAt.current > 80 || next >= maxTickRef.current) {
            lastUiTickAt.current = now;
            setTick(Math.round(next));
          }
          if (next >= maxTickRef.current) {
            playingRef.current = false;
            setPlaying(false);
          }
        };
        app.ticker.add(tickerHandler);
        setPhase("可播放：首个完整回合");
        setProgress(100);
      } catch (error) {
        if (disposed) return;
        setStatus("INVALID");
        setProgress(100);
        setPhase("资源不可用");
        setDetail(
          `真实回放未加载。请确认已生成 apps/web/public/generated-data/test_demo.replay.json，且本地 radar 存在于 ${manifest.raster_ref}。${
            error instanceof Error ? ` ${error.message}` : ""
          }`
        );
      }
    };

    void initialize();
    return () => {
      disposed = true;
      resizeObserver?.disconnect();
      if (app && tickerHandler) app.ticker.remove(tickerHandler);
      layer?.destroy();
      app?.destroy(true);
      runtimeRef.current = undefined;
    };
  }, []);

  const frame = useMemo<PlaybackFrameViewModel | undefined>(() => {
    if (!source || !observation) return undefined;
    if (perspective === "OMNISCIENT") return buildOmniscientFrame(source, tick, manifest);
    return buildKnowledgeFrame(
      toKnowledgeFrameInput(source, tick, observation, manifest),
      manifest
    );
  }, [observation, perspective, source, tick]);

  useEffect(() => {
    if (frame && runtimeReady) runtimeRef.current?.layer.update(frame);
  }, [frame, runtimeReady]);

  useEffect(() => {
    tickRef.current = tick;
  }, [tick]);

  useEffect(() => {
    playingRef.current = playing;
  }, [playing]);

  useEffect(() => {
    perspectiveRef.current = perspective;
  }, [perspective]);

  const resetViewport = (): void => {
    const host = hostRef.current;
    const runtime = runtimeRef.current;
    if (!host || !runtime) return;
    const mapSize = Math.max(240, Math.min(host.clientWidth, host.clientHeight));
    const camera = cameraRef.current;
    camera.scale = 1;
    camera.x = (host.clientWidth - mapSize) / 2;
    camera.y = (host.clientHeight - mapSize) / 2;
    camera.initialized = true;
    runtime.layer.setMapSize(mapSize);
    runtime.layer.setViewport(camera.x, camera.y, camera.scale);
  };

  const zoomAtCenter = (factor: number): void => {
    const host = hostRef.current;
    const runtime = runtimeRef.current;
    if (!host || !runtime) return;
    const camera = cameraRef.current;
    const center = { x: host.clientWidth / 2, y: host.clientHeight / 2 };
    const mapPoint = { x: (center.x - camera.x) / camera.scale, y: (center.y - camera.y) / camera.scale };
    camera.scale = Math.max(0.8, Math.min(3, camera.scale * factor));
    camera.x = center.x - mapPoint.x * camera.scale;
    camera.y = center.y - mapPoint.y * camera.scale;
    runtime.layer.setViewport(camera.x, camera.y, camera.scale);
  };

  const onPointerDown = (event: React.PointerEvent<HTMLDivElement>): void => {
    dragRef.current = { pointerId: event.pointerId, x: event.clientX, y: event.clientY };
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const onPointerMove = (event: React.PointerEvent<HTMLDivElement>): void => {
    const drag = dragRef.current;
    const runtime = runtimeRef.current;
    if (!drag || drag.pointerId !== event.pointerId || !runtime) return;
    const camera = cameraRef.current;
    camera.x += event.clientX - drag.x;
    camera.y += event.clientY - drag.y;
    drag.x = event.clientX;
    drag.y = event.clientY;
    runtime.layer.setViewport(camera.x, camera.y, camera.scale);
  };

  const onPointerUp = (event: React.PointerEvent<HTMLDivElement>): void => {
    if (dragRef.current?.pointerId === event.pointerId) dragRef.current = undefined;
  };

  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>): void => {
    if (event.key === "0") resetViewport();
    if (event.key === "+" || event.key === "=") zoomAtCenter(1.1);
    if (event.key === "-") zoomAtCenter(0.9);
    if (["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(event.key)) {
      event.preventDefault();
      const runtime = runtimeRef.current;
      if (!runtime) return;
      const camera = cameraRef.current;
      if (event.key === "ArrowUp") camera.y += 24;
      if (event.key === "ArrowDown") camera.y -= 24;
      if (event.key === "ArrowLeft") camera.x += 24;
      if (event.key === "ArrowRight") camera.x -= 24;
      runtime.layer.setViewport(camera.x, camera.y, camera.scale);
    }
  };

  const firstRound = source?.rounds[0];
  const minTick = firstRound?.start_tick ?? source?.start_tick ?? 0;
  const maxTick = firstRound?.end_tick ?? source?.end_tick ?? 1;
  const knowledgeUnavailable = perspective === "PLAYER_KNOWLEDGE" && (observation?.observable_states.length ?? 0) === 0;

  return (
    <main style={pageStyles.shell}>
      <div style={pageStyles.content}>
        <p style={pageStyles.eyebrow}>CS2 · isolated playback PoC</p>
        <h1 style={pageStyles.title}>真实 Mirage 回放 · Frame boundary</h1>
        <p style={pageStyles.muted}>
          单次解析后的 GroundTruth 与已过观察边界的玩家已知帧，共用一个 Pixi renderer；不替换现有 AI 带看地图。
        </p>

        <section style={{ ...pageStyles.panel, marginTop: 16 }} aria-label="回放加载状态">
          <div style={{ display: "flex", justifyContent: "space-between", gap: 12, fontSize: 13 }}>
            <span>{phase}</span><span>{progress}%</span>
          </div>
          <progress value={progress} max={100} style={{ width: "100%", marginTop: 8 }} aria-label="读取阶段进度" />
          <p style={{ ...pageStyles.muted, fontSize: 13, marginTop: 8 }}>{detail}</p>
          {status !== "LOADED" && progress === 100 ? (
            <p style={{ ...pageStyles.muted, color: "#f0b38e", fontSize: 13 }}>
              这不是合成回退：没有真实 ReplayBundle 时不会显示真实地图回放。
            </p>
          ) : null}
        </section>

        {source ? (
          <>
            <div style={pageStyles.controls} aria-label="回放模式与相机控制">
              <span style={{ color: "#9eb2c7", fontSize: 13 }}>视角</span>
              {(["OMNISCIENT", "PLAYER_KNOWLEDGE"] as const).map((mode) => (
                <button
                  key={mode}
                  type="button"
                  aria-pressed={perspective === mode}
                  style={{ ...pageStyles.button, ...(perspective === mode ? pageStyles.activeButton : {}) }}
                  onClick={() => setPerspective(mode)}
                >
                  {mode === "OMNISCIENT" ? "完整复查" : "玩家已知"}
                </button>
              ))}
              <button type="button" style={pageStyles.button} onClick={() => setPlaying((value) => !value)}>
                {playing ? "暂停" : "播放"}
              </button>
              <button type="button" style={pageStyles.button} onClick={() => { tickRef.current = minTick; setTick(minTick); }}>
                回到回合开始
              </button>
              <button type="button" style={pageStyles.button} onClick={() => zoomAtCenter(0.9)} aria-label="缩小">−</button>
              <button type="button" style={pageStyles.button} onClick={() => zoomAtCenter(1.1)} aria-label="放大">＋</button>
              <button type="button" style={pageStyles.button} onClick={resetViewport}>重置视图</button>
            </div>

            <div
              ref={hostRef}
              role="application"
              aria-label="Pixi Mirage 回放地图，可拖动、滚轮缩放，方向键平移，0 重置"
              tabIndex={0}
              style={pageStyles.stage}
              onPointerDown={onPointerDown}
              onPointerMove={onPointerMove}
              onPointerUp={onPointerUp}
              onPointerCancel={onPointerUp}
              onWheel={(event) => { event.preventDefault(); zoomAtCenter(event.deltaY < 0 ? 1.1 : 0.9); }}
              onKeyDown={onKeyDown}
            />

            <div style={pageStyles.timeline} aria-label="回放时间轴">
              <input
                type="range"
                min={minTick}
                max={Math.max(minTick + 1, maxTick)}
                step={1}
                value={Math.min(maxTick, Math.max(minTick, tick))}
                onChange={(event) => { setPlaying(false); setTick(Number(event.target.value)); }}
                style={pageStyles.range}
                aria-label="当前 Demo tick"
              />
              <div style={pageStyles.status}>
                <span>{roundLabel} · tick {tick}</span>
                <span>帧：{frame?.actors.length ?? 0} 玩家 / {frame?.projectiles.length ?? 0} 投掷物 / {frame?.evidence.length ?? 0} 已知证据</span>
                <span>雷达坐标：normalized · 真实资产 1024×1024</span>
              </div>
              {knowledgeUnavailable ? (
                <p style={{ ...pageStyles.muted, color: "#f0c48d", fontSize: 13 }}>
                  信息重建尚未生成：当前 bundle 没有 ObservableState，玩家已知视角不会使用完整复查点位。
                </p>
              ) : null}
            </div>
          </>
        ) : null}
      </div>
    </main>
  );
}

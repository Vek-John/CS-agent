"use client";

import type { CSSProperties, PointerEvent as ReactPointerEvent, WheelEvent as ReactWheelEvent } from "react";
import { useMemo, useRef, useState } from "react";
import type {
  CoachCue,
  MatchPlayer,
  MatchTimeline,
  ObservationClaim,
  PlayerStateSample,
  Point2D,
  TeamSide
} from "@cs-coach/contracts";
import { normalizedToWorld, loadMirageManifest, worldToNormalized } from "@cs-coach/map-semantics";
import { filterClaimsAtTick } from "@cs-coach/observation";
import { sampleTrackAtTick } from "@cs-coach/demo-domain";
import type { ReplayViewModel } from "../../lib/replay/replay-bundle";
import { formatItem } from "../../lib/assets/item-display";
import { sampleStateAtTick } from "../../lib/replay/replay-sampling";
import {
  annotationPointToRadarPercent,
  annotationRadiusToRadarPercent
} from "../../lib/replay/replay-annotations";
import {
  buildKnowledgeEvidenceOverlays,
  getRenderablePlayerClaims,
  type KnowledgeEvidenceOverlay
} from "../../lib/replay/replay-knowledge";
import {
  formatMatchEvent,
  windowedTrackSamples
} from "../../lib/replay/replay-display";
import { formatGrenadeType, renderGrenadeTracksAtTick, type GrenadeTrackInput } from "../../lib/replay/replay-grenades";
import { PlayerRail } from "./player-rail";

const mirageManifest = loadMirageManifest({
  raster_ref: "/generated-assets/maps/de_mirage.png"
});

export type ReplayPerspective = "OMNISCIENT" | "PLAYER_KNOWLEDGE";

interface RenderPlayer {
  player: MatchPlayer;
  currentSide: TeamSide;
  point: Point2D;
  alive?: boolean;
  yaw?: number;
  health?: number;
  armor?: number;
  activeItem?: PlayerStateSample["active_item"];
  inventory?: PlayerStateSample["inventory"];
  money?: number;
  hasDefuseKit?: boolean;
  carriesC4?: boolean;
  source: "PLAYER_STATE_SAMPLE" | "LEGACY_FIXTURE" | "OBSERVATION_CLAIM";
  claim?: ObservationClaim;
}

interface ReplayViewerProps {
  view: ReplayViewModel;
  tick: number;
  perspective: ReplayPerspective;
  cue?: CoachCue;
  showAnnotations?: boolean;
  selectedPlayerId: string;
  onSelectPlayer: (playerId: string) => void;
}

interface PointerDrag {
  id: number;
  x: number;
  y: number;
  panX: number;
  panY: number;
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function formatMoney(value: number | undefined): string {
  return value === undefined ? "未知" : `$${value.toLocaleString("en-US")}`;
}

function formatInventory(inventory: PlayerStateSample["inventory"] | undefined): string {
  if (!inventory) return "未知";
  if (inventory.length === 0) return "无";
  return inventory
    .map((item) => `${formatItem(item)}${item.count > 1 ? ` ×${item.count}` : ""}`)
    .join("、");
}

function formatBinary(value: boolean | undefined, yes: string, no: string): string {
  return value === undefined ? "未知" : value ? yes : no;
}

function playerById(timeline: MatchTimeline, playerId: string): MatchPlayer | undefined {
  return timeline.players.find((player) => player.player_id === playerId);
}

function pointFromWorld(worldPoint: PlayerStateSample["world_position"]): Point2D {
  return worldToNormalized(worldPoint, mirageManifest);
}

function pointFromLegacy(sample: { x: number; y: number }): Point2D {
  // The fixture still has a legacy normalized track. Keep that adapter local
  // and project through the real manifest so the renderer never uses CSS map
  // geometry or treats fixture coordinates as parsed Demo world facts.
  const normalized = {
    x: clamp01(sample.x / 100),
    y: clamp01(sample.y / 100)
  };
  return pointFromWorld(normalizedToWorld(normalized, mirageManifest));
}

function renderFromPlayerState(player: MatchPlayer, sample: PlayerStateSample): RenderPlayer {
  return {
    player,
    currentSide: sample.side,
    point: pointFromWorld(sample.world_position),
    alive: sample.alive,
    yaw: sample.yaw,
    health: sample.health,
    armor: sample.armor,
    activeItem: sample.active_item,
    inventory: sample.inventory,
    money: sample.money,
    hasDefuseKit: sample.has_defuse_kit,
    carriesC4: sample.carries_c4,
    source: "PLAYER_STATE_SAMPLE"
  };
}

function renderLegacyPlayers(view: ReplayViewModel, tick: number): RenderPlayer[] {
  return view.timeline.players.flatMap((player) => {
    const track = view.timeline.tracks.find((candidate) => candidate.player_id === player.player_id);
    if (!track) return [];
    const sample = sampleTrackAtTick(track, tick);
    return [{
      player,
      currentSide: player.side,
      point: pointFromLegacy(sample),
      alive: sample.alive,
      source: "LEGACY_FIXTURE"
    }];
  });
}

function spatialPoint(claim: ObservationClaim): Point2D | undefined {
  const spatial = claim.spatial_estimate;
  if (spatial.type === "EXACT_POINT") return pointFromWorld(spatial.point);
  return undefined;
}

function renderKnowledgePlayers(
  view: ReplayViewModel,
  tick: number
): { players: RenderPlayer[]; evidenceOverlays: KnowledgeEvidenceOverlay[]; message?: string } {
  const selectedPlayer = playerById(view.timeline, view.timeline.selected_player_id);
  const selectedSample = selectedPlayer && view.player_states.length > 0
    ? sampleStateAtTick(view.player_states, selectedPlayer.player_id, tick)
    : undefined;
  // Health, armor, inventory and the active item are always known to the
  // subject. Keep that first-person state available even between sparse
  // ObservableState checkpoints; enemy information still requires claims.
  const selfPlayers = selectedPlayer && selectedSample
    ? [renderFromPlayerState(selectedPlayer, selectedSample)]
    : [];

  if (view.observable_states.length === 0) {
    return {
      players: selfPlayers,
      evidenceOverlays: [],
      message: selfPlayers.length > 0
        ? "当前只显示主体自身状态；bundle 尚未提供可用的对手或共享信息 claims。"
        : "信息重建尚未生成：当前 bundle 没有 ObservableState，未使用旧 observed_by_selected 字段隐藏敌方。"
    };
  }

  const states = view.observable_states
    .filter((state) => state.observer_player_id === view.timeline.selected_player_id && state.at_tick <= tick)
    .sort((left, right) => right.at_tick - left.at_tick);
  const state = states[0];
  if (!state) {
    return {
      players: selfPlayers,
      evidenceOverlays: [],
      message: selfPlayers.length > 0
        ? "当前只显示主体自身状态；此 tick 尚无其他玩家已知 claims。"
        : "当前 tick 尚无可用的玩家已知 claims。"
    };
  }

  let claims: ObservationClaim[];
  try {
    claims = filterClaimsAtTick(state.claims, tick);
  } catch {
    claims = [];
  }

  const evidenceOverlays = buildKnowledgeEvidenceOverlays(claims, mirageManifest);
  const seen = new Set<string>(selfPlayers.map((item) => item.player.player_id));
  const claimedPlayers = getRenderablePlayerClaims(claims).flatMap((claim) => {
    if (!claim.subject_ref || seen.has(claim.subject_ref)) return [];
    const point = spatialPoint(claim);
    const player = playerById(view.timeline, claim.subject_ref);
    if (!point || !player) return [];
    seen.add(claim.subject_ref);
    return [{
      player,
      currentSide: player.side,
      point,
      source: "OBSERVATION_CLAIM" as const,
      claim
    }];
  });
  const players = [...selfPlayers, ...claimedPlayers];

  return {
    players,
    evidenceOverlays,
    message: claimedPlayers.length === 0 && evidenceOverlays.length === 0
      ? "当前仅显示主体自身状态；没有可定位的对手或共享 claim。"
      : undefined
  };
}

function trackPoints(view: ReplayViewModel, playerId: string, tick: number): string {
  if (view.player_states.length > 0) {
    return windowedTrackSamples(
      view.player_states.filter((sample) => sample.player_id === playerId),
      tick,
      view.timeline.tick_rate
    )
      .map((sample) => {
        const point = pointFromWorld(sample.world_position);
        return `${point.x},${point.y}`;
      })
      .join(" ");
  }

  const track = view.timeline.tracks.find((candidate) => candidate.player_id === playerId);
  if (!track) return "";
  return windowedTrackSamples(track.samples, tick, view.timeline.tick_rate)
    .map((sample) => {
      const point = pointFromLegacy(sample);
      return `${point.x},${point.y}`;
    })
    .join(" ");
}

function AnnotationLayer({ cue }: { cue?: CoachCue }) {
  if (!cue) return null;
  return (
    <div className="replay-annotation-layer" aria-hidden="true">
      {cue.annotations.map((annotation) => {
        if (annotation.type === "AREA") {
          const center = annotationPointToRadarPercent(annotation.center, annotation.coordinate_space, mirageManifest);
          const radius = annotationRadiusToRadarPercent(
            annotation.center,
            annotation.radius,
            annotation.coordinate_space,
            mirageManifest
          );
          return (
            <div
              className="replay-annotation-area"
              key={annotation.id}
              style={{
                left: `${center.x}%`,
                top: `${center.y}%`,
                width: `${radius * 2}%`
              }}
            >
              <span>{annotation.label}</span>
            </div>
          );
        }
        if (annotation.type === "LINE") {
          const from = annotationPointToRadarPercent(annotation.from, annotation.coordinate_space, mirageManifest);
          const to = annotationPointToRadarPercent(annotation.to, annotation.coordinate_space, mirageManifest);
          const deltaX = to.x - from.x;
          const deltaY = to.y - from.y;
          const distance = Math.sqrt(deltaX ** 2 + deltaY ** 2);
          return (
            <div
              className="replay-annotation-line"
              key={annotation.id}
              style={{
                left: `${from.x}%`,
                top: `${from.y}%`,
                width: `${distance}%`,
                transform: `rotate(${Math.atan2(deltaY, deltaX) * (180 / Math.PI)}deg)`
              }}
            >
              <span>{annotation.label}</span>
            </div>
          );
        }
        const point = annotationPointToRadarPercent(annotation.point, annotation.coordinate_space, mirageManifest);
        const label = annotation.label
          .replace(/主体决策前位置[（(]WORLD[）)]/u, "决策点")
          .replace(/[（(]WORLD[）)]/gu, "")
          .trim();
        return (
          <div
            className="replay-annotation-point"
            key={annotation.id}
            style={{ left: `${point.x}%`, top: `${point.y}%` }}
          >
            <span>{label}</span>
          </div>
        );
      })}
    </div>
  );
}

function KnowledgeEvidenceLayer({ overlays }: { overlays: readonly KnowledgeEvidenceOverlay[] }) {
  if (overlays.length === 0) return null;
  return (
    <svg
      className="map-layer map-knowledge-evidence-layer"
      viewBox="0 0 1 1"
      role="img"
      aria-label="玩家已知证据范围"
    >
      {overlays.map((overlay) => {
        if (overlay.type === "DIRECTION_SECTOR") {
          return (
            <g className="knowledge-direction-hint" key={overlay.id}>
              <path className="knowledge-direction-boundaries" d={overlay.boundaryPath} />
              <path className="knowledge-direction-ray" d={overlay.rayPath} />
              <title>可能听见的脚步/枪声方向；不是敌人位置或可见范围</title>
            </g>
          );
        }
        return (
          <circle
            className={overlay.type === "AREA" ? "knowledge-area" : "knowledge-last-known"}
            key={overlay.id}
            cx={overlay.center.x}
            cy={overlay.center.y}
            r={Math.max(0.008, overlay.radius)}
            style={overlay.opacity === undefined ? undefined : { opacity: overlay.opacity }}
          >
            <title>{overlay.type === "AREA" ? "不确定范围" : "最后已知位置（随时间衰减）"}</title>
          </circle>
        );
      })}
    </svg>
  );
}

function PlayerMarker({
  item,
  selected,
  hovered,
  onSelect,
  onHover
}: {
  item: RenderPlayer;
  selected: boolean;
  hovered: boolean;
  onSelect: () => void;
  onHover: (hovered: boolean) => void;
}) {
  const stateLabel = item.alive === undefined ? "状态未知" : item.alive ? "存活" : "已阵亡";
  return (
    <button
      type="button"
      className={`replay-marker team-${item.currentSide.toLowerCase()} ${selected ? "is-selected" : ""} ${
        item.alive === false ? "is-dead" : ""
      } ${hovered ? "is-hovered" : ""}`}
      style={{ left: `${item.point.x * 100}%`, top: `${item.point.y * 100}%` }}
      aria-label={`${item.player.display_name}，${item.currentSide}，${stateLabel}`}
      title={`${item.player.display_name} · ${item.currentSide} · ${stateLabel}`}
      aria-pressed={selected}
      onPointerDown={(event) => event.stopPropagation()}
      onClick={(event) => {
        event.stopPropagation();
        onSelect();
      }}
      onMouseEnter={() => onHover(true)}
      onMouseLeave={() => onHover(false)}
    >
      {item.yaw !== undefined ? (
        <span className="replay-marker-yaw" style={{ transform: `rotate(${item.yaw}deg)` }} aria-hidden="true" />
      ) : null}
      <span className="replay-marker-core">{selected ? "你" : ""}</span>
      <span className="replay-marker-name">{item.player.display_name}</span>
    </button>
  );
}

export function TacticalMap({
  view,
  tick,
  perspective,
  cue,
  showAnnotations,
  selectedPlayerId,
  onSelectPlayer
}: ReplayViewerProps) {
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [hoveredPlayerId, setHoveredPlayerId] = useState<string>();
  const [radarState, setRadarState] = useState<"loading" | "ready" | "error">("loading");
  const [showTracks, setShowTracks] = useState(false);
  const [showEvents, setShowEvents] = useState(false);
  const [showGrenades, setShowGrenades] = useState(false);
  const pointerDrag = useRef<PointerDrag | undefined>(undefined);

  const knowledge = useMemo(
    () => perspective === "PLAYER_KNOWLEDGE"
      ? renderKnowledgePlayers(view, tick)
      : { players: [], evidenceOverlays: [] },
    [perspective, tick, view]
  );
  const renderPlayers = useMemo(() => {
    if (perspective === "PLAYER_KNOWLEDGE") return knowledge.players;
    if (view.player_states.length > 0) {
      return view.timeline.players.flatMap((player) => {
        const state = sampleStateAtTick(view.player_states, player.player_id, tick);
        return state ? [renderFromPlayerState(player, state)] : [];
      });
    }
    return view.status === "LOADED" ? [] : renderLegacyPlayers(view, tick);
  }, [knowledge.players, perspective, tick, view]);
  const renderById = useMemo(
    () => new Map(renderPlayers.map((item) => [item.player.player_id, item])),
    [renderPlayers]
  );
  const playersBySide = useMemo(() => ({
    T: view.timeline.players.filter((player) => (renderById.get(player.player_id)?.currentSide ?? player.side) === "T"),
    CT: view.timeline.players.filter((player) => (renderById.get(player.player_id)?.currentSide ?? player.side) === "CT")
  }), [renderById, view.timeline.players]);
  const grenadeTracks = useMemo(
    () => renderGrenadeTracksAtTick(
      view.grenade_tracks as readonly GrenadeTrackInput[],
      tick,
      view.timeline.tick_rate,
      mirageManifest
    ),
    [tick, view.grenade_tracks, view.timeline.tick_rate]
  );
  const grenadeTypeLabels = useMemo(() => {
    const itemIds = [
      ...(view.grenade_tracks as readonly GrenadeTrackInput[]).map((track) => formatGrenadeType(track)),
      ...view.events
        .filter((event) => ["GRENADE_THROW", "GRENADE_DETONATE", "UTILITY"].includes(event.event_type))
        .map((event) => event.item_id)
        .filter((itemId): itemId is string => Boolean(itemId?.trim()))
        .map((itemId) => formatItem({ item_id: itemId, item_class: "grenade" }))
    ];
    return [...new Set(itemIds)];
  }, [view.events, view.grenade_tracks]);
  const matchEvents = useMemo(
    () => (view.timeline.match_events && view.timeline.match_events.length > 0
      ? view.timeline.match_events
      : view.events),
    [view.events, view.timeline.match_events]
  );
  const displayNames = useMemo(
    () => new Map(view.timeline.players.map((player) => [player.player_id, player.display_name])),
    [view.timeline.players]
  );
  const syncEvent = useMemo(
    () => matchEvents
      .filter((event) => Math.abs(event.tick - tick) <= Math.round(view.timeline.tick_rate * 0.75))
      .sort((left, right) => Math.abs(left.tick - tick) - Math.abs(right.tick - tick))[0],
    [matchEvents, tick, view.timeline.tick_rate]
  );
  const activePlayer = renderById.get(selectedPlayerId);
  const events = useMemo(
    () => matchEvents.filter(
      (event) => event.tick <= tick && event.tick >= tick - Math.round(view.timeline.tick_rate * 8)
    ),
    [matchEvents, tick, view.timeline.tick_rate]
  );
  const hasTrackData = view.player_states.length > 0 || view.timeline.tracks.length > 0;
  const hasEventData = matchEvents.length > 0;
  const hasSpatialEventData = matchEvents.some((event) => event.world_origin !== undefined);
  const hasSpatialGrenadeData = view.grenade_tracks.length > 0 || view.events.some((event) =>
    ["GRENADE_THROW", "GRENADE_DETONATE", "UTILITY"].includes(event.event_type) && event.world_origin !== undefined
  );

  function changeZoom(nextZoom: number) {
    setZoom(Math.max(1, Math.min(2.4, nextZoom)));
    if (nextZoom <= 1) setPan({ x: 0, y: 0 });
  }

  function handlePointerDown(event: ReactPointerEvent<HTMLDivElement>) {
    if (event.button !== 0 || !event.isPrimary || pointerDrag.current) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    pointerDrag.current = { id: event.pointerId, x: event.clientX, y: event.clientY, panX: pan.x, panY: pan.y };
  }

  function handlePointerMove(event: ReactPointerEvent<HTMLDivElement>) {
    const drag = pointerDrag.current;
    if (!drag || drag.id !== event.pointerId) return;
    setPan({ x: drag.panX + event.clientX - drag.x, y: drag.panY + event.clientY - drag.y });
  }

  function handlePointerUp(event: ReactPointerEvent<HTMLDivElement>) {
    if (pointerDrag.current?.id === event.pointerId) pointerDrag.current = undefined;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  }

  function handleWheel(event: ReactWheelEvent<HTMLDivElement>) {
    event.preventDefault();
    changeZoom(zoom + (event.deltaY < 0 ? 0.12 : -0.12));
  }

  const sceneStyle = {
    transform: `translate3d(-50%, -50%, 0) translate3d(${pan.x}px, ${pan.y}px, 0) scale(${zoom})`
  } as CSSProperties;

  return (
    <div className="replay-viewer">
      <div className="replay-map-layout">
        <PlayerRail
          side="T"
          players={playersBySide.T}
          stateById={renderById}
          selectedPlayerId={selectedPlayerId}
          assetCatalog={view.asset_catalog}
          onSelectPlayer={onSelectPlayer}
        />
        <div className="replay-map-center">
          <div
            className="map-viewport"
            aria-label="Mirage 真实雷达二维回放"
            onPointerDown={handlePointerDown}
            onPointerMove={handlePointerMove}
            onPointerUp={handlePointerUp}
            onPointerCancel={handlePointerUp}
            onWheel={handleWheel}
          >
        <div className="map-scene" style={sceneStyle}>
          <img
            className="map-radar"
            src={mirageManifest.raster_ref}
            alt="Valve Mirage 雷达图"
            draggable={false}
            onLoad={() => setRadarState("ready")}
            onError={() => setRadarState("error")}
          />
          <div className="map-radar-shade" aria-hidden="true" />
          {showTracks ? (
            <svg className="map-layer map-track-layer" viewBox="0 0 1 1" aria-hidden="true">
              {view.timeline.players.map((player) => {
                const points = trackPoints(view, player.player_id, tick);
                const currentSide = renderById.get(player.player_id)?.currentSide ?? player.side;
                return points ? <polyline key={player.player_id} points={points} className={`track-${currentSide.toLowerCase()}`} /> : null;
              })}
            </svg>
          ) : null}
          {showEvents || showGrenades ? (
            <svg className="map-layer map-event-layer" viewBox="0 0 1 1" aria-hidden="true">
              {events.map((event) => {
                if (!event.world_origin) return null;
                const point = pointFromWorld(event.world_origin);
                const grenade = ["GRENADE_THROW", "GRENADE_DETONATE", "UTILITY"].includes(event.event_type);
                if (grenade && !showGrenades) return null;
                if (!grenade && !showEvents) return null;
                return (
                  <g key={event.id} transform={`translate(${point.x} ${point.y})`}>
                    <title>{formatMatchEvent(event, displayNames)}</title>
                    <circle className={grenade ? "event-grenade" : "event-dot"} r={grenade ? 0.018 : 0.012} />
                  </g>
                );
              })}
              {showGrenades ? grenadeTracks.map((track) => (
                <g key={`grenade-track-${track.id}`}>
                  {track.flightPoints.length > 1 ? (
                    <polyline
                      className="grenade-flight"
                      points={track.flightPoints.map((point) => `${point.x},${point.y}`).join(" ")}
                    />
                  ) : null}
                  {track.effectArea ? (
                    <circle
                      className="grenade-effect-area"
                      cx={track.effectArea.center.x}
                      cy={track.effectArea.center.y}
                      r={track.effectArea.radius}
                    />
                  ) : null}
                  {track.currentPoint ? (
                    <circle className="grenade-current" cx={track.currentPoint.x} cy={track.currentPoint.y} r="0.018" />
                  ) : null}
                  {track.landingPoint ? (
                    <circle className="grenade-landing" cx={track.landingPoint.x} cy={track.landingPoint.y} r="0.014" />
                  ) : null}
                  <title>{track.label}</title>
                </g>
              )) : null}
            </svg>
          ) : null}
          {perspective === "PLAYER_KNOWLEDGE" ? (
            <KnowledgeEvidenceLayer overlays={knowledge.evidenceOverlays} />
          ) : null}
          {perspective === "PLAYER_KNOWLEDGE" && knowledge.players.map((item) => (
            <div
              className="knowledge-claim-ring"
              key={`claim-${item.player.player_id}`}
              style={{ left: `${item.point.x * 100}%`, top: `${item.point.y * 100}%` }}
              title={item.claim?.source_type || "玩家已知位置"}
            />
          ))}
          {renderPlayers.map((item) => (
            <PlayerMarker
              key={item.player.player_id}
              item={item}
              selected={selectedPlayerId === item.player.player_id}
              hovered={hoveredPlayerId === item.player.player_id}
              onSelect={() => onSelectPlayer(item.player.player_id)}
              onHover={(hovered) => setHoveredPlayerId(hovered ? item.player.player_id : undefined)}
            />
          ))}
          {showAnnotations ? <AnnotationLayer cue={cue} /> : null}
        </div>

        <div className="map-zoom-controls" aria-label="雷达图缩放控制" onPointerDown={(event) => event.stopPropagation()}>
          <button type="button" onClick={() => changeZoom(zoom + 0.2)} aria-label="放大雷达图">＋</button>
          <span>{Math.round(zoom * 100)}%</span>
          <button type="button" onClick={() => changeZoom(zoom - 0.2)} aria-label="缩小雷达图">−</button>
          <button type="button" onClick={() => { setZoom(1); setPan({ x: 0, y: 0 }); }} aria-label="重置雷达图视图">重置</button>
        </div>
        <div className="map-gesture-hint">拖动画布 · 滚轮缩放</div>
        {radarState === "error" ? (
          <div className="map-asset-error" role="alert">
            <strong>真实雷达资源加载失败</strong>
            <span>请确认 `apps/web/public/generated-assets/maps/de_mirage.png` 存在，并重启 localhost。</span>
          </div>
        ) : null}
        {radarState === "loading" ? <div className="map-asset-loading">正在加载本地 Mirage 雷达…</div> : null}
        {perspective === "PLAYER_KNOWLEDGE" && knowledge.message ? (
          <div className="knowledge-not-ready" role="status">{knowledge.message}</div>
        ) : null}
        {syncEvent ? (
          <div className="map-sync-event" role="status" aria-live="polite">
            <span>同步事件</span>
            <b>{formatMatchEvent(syncEvent, displayNames)}</b>
            <small>tick {syncEvent.tick}</small>
          </div>
        ) : null}
          </div>

          <div className="map-info-row">
        <div className="map-layer-controls" aria-label="雷达图图层">
          <span>图层</span>
          <button type="button" className={showTracks ? "is-on" : ""} aria-pressed={showTracks} disabled={!hasTrackData} onClick={() => setShowTracks((value) => !value)}>
            轨迹 {hasTrackData ? "· 4s" : "· 未提供"}
          </button>
          <button type="button" className={showEvents ? "is-on" : ""} aria-pressed={showEvents} disabled={!hasEventData} onClick={() => setShowEvents((value) => !value)}>
            事件 {hasEventData ? `· ${matchEvents.length}` : "· 未提供"}
          </button>
          <button type="button" className={showGrenades ? "is-on" : ""} aria-pressed={showGrenades} disabled={!hasSpatialGrenadeData} onClick={() => setShowGrenades((value) => !value)}>
            投掷物 {hasSpatialGrenadeData ? (view.grenade_tracks.length > 0 ? `· ${view.grenade_tracks.length}` : "· 事件") : "· 未提供"}
          </button>
        </div>
        {!hasSpatialEventData && hasEventData ? <small className="map-layer-note">事件已提供，但当前 bundle 没有可落图的 world_origin。</small> : null}
        <div className="map-legend" aria-label="玩家已知图例">
          <span><i className="legend-visual" />视觉确认</span>
          <span><i className="legend-sound" />可能听见方向（非位置）</span>
          <span><i className="legend-last-known" />最后已知</span>
          <span><i className="legend-shared" />验证共享</span>
        </div>
        <div className="grenade-type-legend" aria-label="投掷物图例">
          <strong>投掷物</strong>
          <span><i />飞行</span>
          <span><i className="legend-landing" />落点</span>
          <span><i className="legend-effect" />生效范围（数据提供时）</span>
          {grenadeTypeLabels.length > 0
            ? grenadeTypeLabels.map((label) => <span key={label}>{label}</span>)
            : <span>类型未提供</span>}
        </div>
      </div>

          {activePlayer ? (
            <div className="selected-player-detail" role="status">
              <b>{activePlayer.player.display_name}</b>
              <span>{activePlayer.currentSide} · {activePlayer.source === "OBSERVATION_CLAIM" ? "玩家已知 claim" : activePlayer.source === "PLAYER_STATE_SAMPLE" ? "PlayerStateSample" : "合成夹具轨迹"}</span>
              <span>{activePlayer.yaw === undefined ? "朝向未知" : `yaw ${Math.round(activePlayer.yaw)}°（仅表示朝向，不代表已观察）`}</span>
              <span>HP {activePlayer.health ?? "未知"} · 甲 {activePlayer.armor ?? "未知"} · {formatItem(activePlayer.activeItem)}</span>
              <span>背包 {formatInventory(activePlayer.inventory)} · {formatMoney(activePlayer.money)} · C4 {formatBinary(activePlayer.carriesC4, "有", "无")} · 拆弹器 {formatBinary(activePlayer.hasDefuseKit, "有", "无")}</span>
            </div>
          ) : null}
        </div>

        <PlayerRail
          side="CT"
          players={playersBySide.CT}
          stateById={renderById}
          selectedPlayerId={selectedPlayerId}
          assetCatalog={view.asset_catalog}
          onSelectPlayer={onSelectPlayer}
        />
      </div>
    </div>
  );
}

export function ReplayViewer(props: ReplayViewerProps) {
  return <TacticalMap {...props} />;
}

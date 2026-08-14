import type {
  ActiveItem,
  GameAssetCatalog,
  InventoryItem,
  MatchPlayer,
  PlayerStateSample,
  TeamSide
} from "@cs-coach/contracts";
import { formatItem } from "../lib/item-display";
import { resolveItemPresentation } from "../lib/game-asset-display";

export interface PlayerRailState {
  currentSide: TeamSide;
  alive?: boolean;
  health?: number;
  armor?: number;
  activeItem?: PlayerStateSample["active_item"];
  inventory?: PlayerStateSample["inventory"];
  money?: number;
  hasDefuseKit?: boolean;
  carriesC4?: boolean;
}

interface ItemGlyphProps {
  item: ActiveItem | undefined;
  catalog: GameAssetCatalog | undefined;
  compact?: boolean;
}

function formatMoney(value: number | undefined): string {
  return value === undefined ? "未知" : `$${value.toLocaleString("en-US")}`;
}

function formatBinary(value: boolean | undefined): string {
  return value === undefined ? "未知" : value ? "有" : "无";
}

function formatInventoryLabel(inventory: readonly InventoryItem[] | undefined): string {
  if (!inventory) return "未知";
  if (inventory.length === 0) return "无";
  return inventory.map((item) => `${formatItem(item)}${item.count > 1 ? ` ×${item.count}` : ""}`).join("、");
}

function itemAccessibleLabel(item: ActiveItem | undefined, catalog: GameAssetCatalog | undefined): string {
  const presentation = resolveItemPresentation(catalog, item);
  return presentation.fallbackReason
    ? `${presentation.label}，图标未提供`
    : presentation.label;
}

function ItemGlyph({ item, catalog, compact = false }: ItemGlyphProps) {
  if (!item) {
    return <span className={`player-item-glyph is-unknown ${compact ? "is-compact" : ""}`}>未知</span>;
  }
  const presentation = resolveItemPresentation(catalog, item);
  const fallbackTitle = presentation.fallbackReason ? " · 图标未提供" : "";
  return (
    <span
      className={`player-item-glyph ${presentation.iconRef ? "has-icon" : "is-text"} ${compact ? "is-compact" : ""}`}
      title={`${presentation.label}${fallbackTitle}`}
      aria-label={itemAccessibleLabel(item, catalog)}
      data-icon-state={presentation.iconRef ? "cached" : "missing"}
    >
      {presentation.iconRef ? (
        <img src={presentation.iconRef} alt="" width={presentation.icon?.width} height={presentation.icon?.height} />
      ) : null}
      <span className="player-item-glyph-label">{presentation.label}</span>
    </span>
  );
}

function statusText(state: PlayerRailState | undefined): string {
  if (state?.alive === undefined) return "状态未知";
  return state.alive ? "存活" : "已阵亡";
}

function keyItem(
  label: string,
  item: ActiveItem,
  value: boolean | undefined,
  catalog: GameAssetCatalog | undefined
) {
  return (
    <span className={`player-rail-key-item ${value === true ? "is-present" : ""}`}>
      {value === true ? <ItemGlyph item={item} catalog={catalog} compact /> : null}
      <span>{label} {formatBinary(value)}</span>
    </span>
  );
}

function PlayerRailRow({
  player,
  state,
  selected,
  catalog,
  onSelect
}: {
  player: MatchPlayer;
  state?: PlayerRailState;
  selected: boolean;
  catalog?: GameAssetCatalog;
  onSelect: () => void;
}) {
  const side = state?.currentSide ?? player.side;
  const currentItemLabel = state?.activeItem ? formatItem(state.activeItem) : "未知";
  const inventoryLabel = formatInventoryLabel(state?.inventory);
  const label = `${player.display_name}，${side}，${statusText(state)}，HP ${state?.health ?? "未知"}，甲 ${state?.armor ?? "未知"}，手持 ${currentItemLabel}，背包 ${inventoryLabel}，C4 ${formatBinary(state?.carriesC4)}，拆弹器 ${formatBinary(state?.hasDefuseKit)}`;

  return (
    <button
      type="button"
      className={`player-rail-row ${selected ? "is-selected" : ""} ${state?.alive === false ? "is-dead" : ""}`}
      aria-label={label}
      aria-pressed={selected}
      onClick={onSelect}
    >
      <span className={`player-rail-status ${state?.alive === false ? "is-dead" : ""}`} aria-hidden="true" />
      <span className="player-rail-content">
        <span className="player-rail-name-line">
          <strong>{player.display_name}</strong>
          <small>{statusText(state)}</small>
        </span>
        <span className="player-rail-vitals" aria-label={`HP ${state?.health ?? "未知"}，甲 ${state?.armor ?? "未知"}`}>
          <span>HP <b>{state?.health ?? "未知"}</b></span>
          <span>甲 <b>{state?.armor ?? "未知"}</b></span>
          <span>{formatMoney(state?.money)}</span>
        </span>
        <span className="player-rail-loadout">
          <small>手持</small>
          <ItemGlyph item={state?.activeItem} catalog={catalog} />
        </span>
        <span className="player-rail-inventory" title={inventoryLabel}>
          <small>背包</small>
          {state?.inventory?.length ? state.inventory.map((item, index) => (
            <ItemGlyph
              key={`${item.item_id}-${item.count}-${index}`}
              item={item}
              catalog={catalog}
              compact
            />
          )) : <span className="player-rail-unknown">{state?.inventory ? "无" : "未知"}</span>}
        </span>
        <span className="player-rail-key-items">
          {keyItem("C4", { item_id: "c4", item_class: "objective" }, state?.carriesC4, catalog)}
          {keyItem("拆弹", { item_id: "defuse_kit", item_class: "equipment" }, state?.hasDefuseKit, catalog)}
        </span>
      </span>
    </button>
  );
}

export function PlayerRail({
  side,
  players,
  stateById,
  selectedPlayerId,
  assetCatalog,
  onSelectPlayer
}: {
  side: TeamSide;
  players: readonly MatchPlayer[];
  stateById: ReadonlyMap<string, PlayerRailState>;
  selectedPlayerId: string;
  assetCatalog?: GameAssetCatalog;
  onSelectPlayer: (playerId: string) => void;
}) {
  const sideLabel = side === "T" ? "进攻方" : "防守方";
  return (
    <section className={`player-rail player-rail-${side.toLowerCase()}`} aria-label={`${side} 玩家状态`}>
      <header className="player-rail-heading">
        <div>
          <strong>{side}</strong>
          <span>{sideLabel}</span>
        </div>
        <small>{players.length}/5</small>
      </header>
      <div className="player-rail-list">
        {players.map((player) => (
          <PlayerRailRow
            key={player.player_id}
            player={player}
            state={stateById.get(player.player_id)}
            selected={selectedPlayerId === player.player_id}
            catalog={assetCatalog}
            onSelect={() => onSelectPlayer(player.player_id)}
          />
        ))}
        {players.length === 0 ? <p className="player-rail-empty">未提供队伍名单</p> : null}
      </div>
    </section>
  );
}

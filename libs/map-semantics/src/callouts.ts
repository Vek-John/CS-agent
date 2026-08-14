/**
 * Mirage callouts emitted by CS2 itself through
 * `CCSPlayerPawn.m_szLastPlaceName`.
 *
 * The engine token is the fact. Chinese labels are presentation vocabulary;
 * this module never infers a place from an enemy position or a future frame.
 */
export const MIRAGE_CALLOUTS_VERSION = "mirage-engine-callouts/1.0.0" as const;

export interface MirageCalloutDefinition {
  readonly id: string;
  readonly engine_place_name: string;
  readonly zh_cn: string;
  readonly english: string;
  readonly aliases: readonly string[];
}

export type MirageCalloutMatch =
  | {
      readonly status: "EXACT";
      readonly source: "ENGINE_PLACE_NAME" | "EXPLICIT_ALIAS";
      readonly callout: MirageCalloutDefinition;
    }
  | {
      readonly status: "AMBIGUOUS";
      readonly candidates: readonly MirageCalloutDefinition[];
    }
  | {
      readonly status: "UNKNOWN";
      readonly raw?: string;
    };

/**
 * Tokens observed in both `test_demo.dem` and the Falcons vs Spirit Mirage
 * fixture. Keep stable IDs/engine tokens; display wording may improve without
 * changing the parser contract.
 */
export const MIRAGE_CALLOUTS: readonly MirageCalloutDefinition[] = [
  { id: "MIRAGE_APARTMENTS", engine_place_name: "Apartments", zh_cn: "B二楼", english: "B Apartments", aliases: ["B apps", "Apartments", "B二楼"] },
  { id: "MIRAGE_BACK_ALLEY", engine_place_name: "BackAlley", zh_cn: "B二楼外", english: "Back Alley", aliases: ["Back Alley", "B二楼外", "二楼外"] },
  { id: "MIRAGE_A_SITE", engine_place_name: "BombsiteA", zh_cn: "A包点", english: "A Site", aliases: ["A site", "A包点", "A点"] },
  { id: "MIRAGE_B_SITE", engine_place_name: "BombsiteB", zh_cn: "B包点", english: "B Site", aliases: ["B site", "B包点", "B点"] },
  { id: "MIRAGE_CT_SPAWN", engine_place_name: "CTSpawn", zh_cn: "警家", english: "CT Spawn", aliases: ["CT spawn", "CT家", "警家"] },
  { id: "MIRAGE_CATWALK", engine_place_name: "Catwalk", zh_cn: "B小", english: "Catwalk", aliases: ["Catwalk", "B short", "B小"] },
  { id: "MIRAGE_CONNECTOR", engine_place_name: "Connector", zh_cn: "连接", english: "Connector", aliases: ["Connector", "连接", "中连接"] },
  { id: "MIRAGE_HOUSE", engine_place_name: "House", zh_cn: "电视房", english: "House", aliases: ["House", "TV room", "电视房"] },
  { id: "MIRAGE_JUNGLE", engine_place_name: "Jungle", zh_cn: "拱门", english: "Jungle", aliases: ["Jungle", "拱门", "丛林"] },
  { id: "MIRAGE_LADDER", engine_place_name: "Ladder", zh_cn: "狗洞", english: "Ladder Room", aliases: ["Ladder", "Ladder room", "狗洞", "梯子间"] },
  { id: "MIRAGE_MIDDLE", engine_place_name: "Middle", zh_cn: "中路", english: "Middle", aliases: ["Middle", "Mid", "中路"] },
  { id: "MIRAGE_PALACE_ALLEY", engine_place_name: "PalaceAlley", zh_cn: "A宫外", english: "Palace Alley", aliases: ["Palace Alley", "A宫外", "宫外"] },
  { id: "MIRAGE_PALACE", engine_place_name: "PalaceInterior", zh_cn: "A宫", english: "Palace", aliases: ["Palace", "A宫", "宫内"] },
  { id: "MIRAGE_SCAFFOLDING", engine_place_name: "Scaffolding", zh_cn: "脚手架", english: "Scaffolding", aliases: ["Scaffolding", "脚手架", "木架"] },
  { id: "MIRAGE_MARKET", engine_place_name: "Shop", zh_cn: "超市", english: "Market", aliases: ["Shop", "Market", "超市"] },
  { id: "MIRAGE_SIDE_ALLEY", engine_place_name: "SideAlley", zh_cn: "匪家侧道", english: "Side Alley", aliases: ["Side Alley", "匪家侧道", "侧道"] },
  { id: "MIRAGE_WINDOW", engine_place_name: "SnipersNest", zh_cn: "VIP", english: "Sniper's Nest", aliases: ["Snipers Nest", "Window", "VIP", "狙击位"] },
  { id: "MIRAGE_STAIRS", engine_place_name: "Stairs", zh_cn: "A楼梯", english: "Stairs", aliases: ["Stairs", "A stairs", "A楼梯"] },
  { id: "MIRAGE_A_RAMP", engine_place_name: "TRamp", zh_cn: "A大", english: "A Ramp", aliases: ["T Ramp", "A ramp", "A大", "A坡"] },
  { id: "MIRAGE_T_SPAWN", engine_place_name: "TSpawn", zh_cn: "匪家", english: "T Spawn", aliases: ["T spawn", "T家", "匪家"] },
  { id: "MIRAGE_TOP_MID", engine_place_name: "TopofMid", zh_cn: "中远（匪口）", english: "Top Mid", aliases: ["Top of Mid", "Top Mid", "中远", "中路匪口"] },
  { id: "MIRAGE_TRUCK", engine_place_name: "Truck", zh_cn: "B车", english: "Truck", aliases: ["Truck", "Van", "B车", "白车"] },
  { id: "MIRAGE_UNDERPASS", engine_place_name: "Underpass", zh_cn: "下水道", english: "Underpass", aliases: ["Underpass", "下水道"] }
] as const;

function normalize(value: string): string {
  return value
    .normalize("NFKC")
    .trim()
    .toLocaleLowerCase("en-US")
    .replace(/[\s_\-']/g, "");
}

const byEngineName = new Map(
  MIRAGE_CALLOUTS.map((definition) => [normalize(definition.engine_place_name), definition])
);

const byAlias = new Map<string, MirageCalloutDefinition[]>();
for (const definition of MIRAGE_CALLOUTS) {
  for (const alias of [definition.zh_cn, definition.english, ...definition.aliases]) {
    const key = normalize(alias);
    const current = byAlias.get(key) ?? [];
    if (!current.some((candidate) => candidate.id === definition.id)) {
      byAlias.set(key, [...current, definition]);
    }
  }
}

/** Resolves an exact Source engine place token. No fuzzy or nearest-area guess. */
export function resolveMirageEnginePlaceName(
  value: string | null | undefined
): MirageCalloutMatch {
  if (typeof value !== "string" || !value.trim()) return { status: "UNKNOWN" };
  const callout = byEngineName.get(normalize(value));
  return callout
    ? { status: "EXACT", source: "ENGINE_PLACE_NAME", callout }
    : { status: "UNKNOWN", raw: value.trim() };
}

/** Resolves explicit UI/user vocabulary without silently guessing near matches. */
export function resolveMirageCalloutAlias(
  value: string | null | undefined
): MirageCalloutMatch {
  if (typeof value !== "string" || !value.trim()) return { status: "UNKNOWN" };
  const exactEngine = byEngineName.get(normalize(value));
  if (exactEngine) return { status: "EXACT", source: "ENGINE_PLACE_NAME", callout: exactEngine };
  const candidates = byAlias.get(normalize(value)) ?? [];
  if (candidates.length === 1) {
    return { status: "EXACT", source: "EXPLICIT_ALIAS", callout: candidates[0] };
  }
  if (candidates.length > 1) return { status: "AMBIGUOUS", candidates };
  return { status: "UNKNOWN", raw: value.trim() };
}

export function mirageChineseCallout(
  enginePlaceName: string | null | undefined
): string | undefined {
  const match = resolveMirageEnginePlaceName(enginePlaceName);
  return match.status === "EXACT" ? match.callout.zh_cn : undefined;
}

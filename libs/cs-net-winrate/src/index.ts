/**
 * cs-net win-rate adapter.
 *
 * This is a TypeScript port of the pinned cs-net `get_round_win_rate.py`
 * feature contract. It consumes the structured Replay emitted by cs2d; it
 * never opens a demo or imports demoparser2. The model itself is executed by
 * `runtime.ts` in a Worker.
 */

export const CS_NET_SOURCE = {
  repository: "cs-net",
  commit: "e15acc3fda3de21f25fe12a5ca31722381f40162",
  checkpointSha256: "23a8c07280542644d0609a4ab072c03f96001a95f50211d424248bfe4620c92d",
  configSha256: "c4e745d44fd2f8787b9724f8d64e03266ec77f7ce1dc550b71c502bf3c1ba056",
  tokenizerSha256: "2c01ac2e2a04fbc149efbc19149934573b1e7fd35de257fc102e77942d42da57",
  featureBuilderSha256: "f9f50fd955690236d7de9d944d81b8f53444be17b710c89212dba91bb5115bd1",
  modelSourceSha256: "fb40c6be85e55fb9ac1fa46a8619d18ebe66382d3d51df8f5d9fdc44542e77d6",
  temperature: 1.0613423585891724,
  modelRevision: "csmodelv3-win-space-only-int8-2026-08-18",
  assetSha256: "3916d0db3df65b8ff0406769e52f8e21f19911dc753b4fc497f5c88cdf371ef8",
  assetBytes: 10302780,
  assetUrl: "/models/cs-net/win-rate.int8.onnx",
} as const;

export const CS_NET_TIMELINE_VERSION = "win-probability-timeline.v1" as const;
export const CS_NET_FEATURE_VERSION = "cs-net-space-only-features/1.0.0" as const;
export const CS_NET_MAP = "de_mirage" as const;
export const CS_NET_SPACE_SIZE = 31;
export const CS_NET_PLAYERS = 10;

export type CsNetEconomyClass = "PISTOL" | "ECO" | "FORCE" | "FULL" | "UNKNOWN";
export type CsNetSwingDirection = "UP" | "DOWN" | "FLAT";

export interface CsNetPlayer {
  steamId: string;
  name?: string;
  startSide?: "CT" | "T";
}

export interface CsNetPlayerState {
  steamId: string;
  x: number;
  y: number;
  z: number;
  yaw: number;
  health: number;
  alive: boolean;
  side: "CT" | "T";
  weapon: string;
  primary?: string;
  money: number;
  equipValue: number;
  armor: number;
  helmet?: boolean;
  defuser?: boolean;
  grenades?: readonly string[];
  lastPlaceName?: string;
}

export interface CsNetFrame {
  tick: number;
  t: number;
  players: readonly CsNetPlayerState[];
}

export interface CsNetEvent {
  type: "kill" | "bomb_planted" | "bomb_defused" | "bomb_exploded" | "grenade" | "shot";
  tick: number;
  t: number;
  attackerSteamId?: string | null;
  victimSteamId?: string;
  playerSteamId?: string | null;
  kind?: "smoke" | "fire" | "he" | "flash" | "decoy";
  x?: number;
  y?: number;
  z?: number;
  endT?: number;
}

export interface CsNetBombKeyframe {
  t: number;
  state: "carried" | "ground" | "planted" | "gone";
  x?: number;
  y?: number;
  z?: number;
  carrierSteamId?: string;
}

export interface CsNetRound {
  number: number;
  freezeStartTick: number;
  startTick: number;
  decidedTick: number;
  endTick: number;
  postEndTick: number;
  winner: "CT" | "T" | null;
  scoreCt: number;
  scoreT: number;
  frames: readonly CsNetFrame[];
  events: readonly CsNetEvent[];
  bomb?: readonly CsNetBombKeyframe[];
}

export interface CsNetReplay {
  map: string;
  demoTickRate: number;
  frameRate: number;
  players: readonly CsNetPlayer[];
  rounds: readonly CsNetRound[];
  finalScoreCt?: number;
  finalScoreT?: number;
}

export interface CsNetFeatureSample {
  roundNumber: number;
  tick: number;
  t: number;
  /** The model expects the first five tokens to be CT and the next five T. */
  sideOrder: readonly string[];
  inputs: CsNetModelInputs;
}

export interface CsNetModelInputs {
  mlp1_f: number[][][];
  mlp1_i: number[][];
  mlp1_mask: boolean[][];
  mlp2_f: number[][][];
  mlp2_mask: boolean[][];
  mlp3_f: number[][][];
  mlp3_i: number[][];
  mlp3_mask: boolean[][];
  mlp4_f: number[][][];
  mlp4_mask: boolean[][];
  mlp5_f: number[][][][];
  mlp5_i: number[][][];
  mlp5_mask: boolean[][][];
  emb1_i: number[][][];
  emb1_mask: boolean[][][];
  emb2_i: number[][];
  emb2_mask: boolean[][];
  dead_mask: boolean[][];
  pad_mask: boolean[][];
}

export interface CsNetModelBatch {
  samples: readonly CsNetFeatureSample[];
  inputs: CsNetModelInputs;
}

export interface WinProbabilitySample {
  tick: number;
  probability: number;
  roundNumber: number;
  side: "CT" | "T";
  source: "CS_NET";
}

export interface WinProbabilityTerminalPoint {
  tick: number;
  probability: 0 | 1;
  winner: "CT" | "T";
  source: "ROUND_WINNER";
}

export interface WinProbabilityEconomy {
  ct: CsNetEconomyClass;
  t: CsNetEconomyClass;
  ctValue: number;
  tValue: number;
}

export interface WinProbabilityRound {
  roundNumber: number;
  startTick: number;
  endTick: number;
  winner: "CT" | "T" | null;
  economy: WinProbabilityEconomy;
  samples: readonly WinProbabilitySample[];
  terminal?: WinProbabilityTerminalPoint;
}

export interface WinProbabilitySwing {
  id: string;
  tick: number;
  before: number;
  after: number;
  delta: number;
  direction: CsNetSwingDirection;
  cause: "PLAYER_DEATH" | "ROUND_RESULT";
  victimSide?: "CT" | "T";
  selectedPlayerDeath?: boolean;
  economy?: CsNetEconomyClass;
}

export interface WinProbabilityTimelineV1 {
  version: typeof CS_NET_TIMELINE_VERSION;
  status: "AVAILABLE" | "UNAVAILABLE";
  model: {
    provider: "CS_NET";
    revision: string;
    assetUrl: string;
    assetSha256: string;
    assetBytes: number;
    quantization: "INT8" | "FP16" | "FP32";
    temperature: number;
    sourceCommit: string;
    featureVersion: string;
  };
  tickRate: number;
  rounds: readonly WinProbabilityRound[];
  swings: readonly WinProbabilitySwing[];
  limitations: readonly string[];
  unavailableReason?: string;
}

const MIRAGE_CENTER = [-605.8900146484375, -866.8900146484375, -171.6199951171875] as const;
const MAP_INDEX = 0;
const MAX_PROJECTILES = 20;
const WEAPON_NAMES = [
  "Desert Eagle", "Dual Berettas", "Five-SeveN", "Glock-18", "AK-47", "AUG", "AWP", "FAMAS", "G3SG1", "Galil AR", "M249", "M4A4", "MAC-10", "P90", "MP5-SD", "UMP-45", "XM1014", "PP-Bizon", "MAG-7", "Negev", "Sawed-Off", "Tec-9", "Zeus x27", "P2000", "MP7", "MP9", "Nova", "P250", "SCAR-20", "SG 553", "SSG 08", "knife", "Flashbang", "High Explosive Grenade", "Smoke Grenade", "Molotov", "Decoy Grenade", "Incendiary Grenade", "C4 Explosive", "Kevlar Vest", "Kevlar & Helmet", "Heavy Assault Suit", "item_nvg", "Defuse Kit", "Rescue Kit", "Medi-Shot", "M4A1-S", "USP-S", "Trade Up Contract", "CZ75-Auto", "R8 Revolver",
] as const;
const WEAPON_INDEX = new Map<string, number>(WEAPON_NAMES.map((name, index) => [name, index]));
const PROJECTILE_INDEX = new Map<string, number>([["smokegrenade", 0], ["inferno", 1]]);

function finite(value: unknown, fallback = 0): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function clipScale(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value)) / Math.max(Math.abs(min), Math.abs(max));
}

function xyz(x: number, y: number, z: number): [number, number, number] {
  return [clipScale(finite(x) - MIRAGE_CENTER[0], -5000, 5000), clipScale(finite(y) - MIRAGE_CENTER[1], -5000, 5000), clipScale(finite(z) - MIRAGE_CENTER[2], -2000, 2000)];
}

function zeroFeature(): CsNetModelInputs {
  return {
    mlp1_f: [Array.from({ length: 31 }, () => [0, 0, 0])],
    mlp1_i: [Array(31).fill(0)],
    mlp1_mask: [Array(31).fill(false)],
    mlp2_f: [Array.from({ length: 31 }, () => Array(14).fill(0))],
    mlp2_mask: [Array(31).fill(false)],
    mlp3_f: [Array.from({ length: 31 }, () => [0])],
    mlp3_i: [Array(31).fill(0)],
    mlp3_mask: [Array(31).fill(false)],
    mlp4_f: [Array.from({ length: 31 }, () => Array(4).fill(0))],
    mlp4_mask: [Array(31).fill(false)],
    mlp5_f: [Array.from({ length: 31 }, () => Array.from({ length: 9 }, () => Array(13).fill(0)))],
    mlp5_i: [Array.from({ length: 31 }, () => Array(9).fill(0))],
    mlp5_mask: [Array.from({ length: 31 }, () => Array(9).fill(false))],
    emb1_i: [Array.from({ length: 31 }, () => Array(9).fill(0))],
    emb1_mask: [Array.from({ length: 31 }, () => Array(9).fill(false))],
    emb2_i: [Array(31).fill(0)],
    emb2_mask: [Array(31).fill(false)],
    dead_mask: [Array(31).fill(false)],
    pad_mask: [Array(31).fill(false)],
  };
}

function normalizeWeapon(value: string): string {
  const aliases: Record<string, string> = {
    Deagle: "Desert Eagle", "Flash": "Flashbang", HE: "High Explosive Grenade", Smoke: "Smoke Grenade", Molotov: "Molotov", Incendiary: "Incendiary Grenade", C4: "C4 Explosive", "USP-Silencer": "USP-S", "M4A1": "M4A1-S",
  };
  return aliases[value] ?? value;
}

function weaponId(value: string): number {
  return WEAPON_INDEX.get(normalizeWeapon(value)) ?? WEAPON_INDEX.get("knife")!;
}

function inventoryIds(player: CsNetPlayerState): number[] {
  const names = [player.primary, ...(player.grenades ?? []), player.weapon].filter((value): value is string => Boolean(value));
  return [...new Set(names.map(weaponId))].slice(0, 9);
}

function activeBomb(round: CsNetRound, t: number): CsNetBombKeyframe | undefined {
  return [...(round.bomb ?? [])].filter((keyframe) => finite(keyframe.t) <= t).at(-1);
}

function economyForValue(value: number, players: readonly CsNetPlayerState[]): CsNetEconomyClass {
  if (!players.length || !Number.isFinite(value)) return "UNKNOWN";
  const weapons = players.filter((player) => player.alive).map((player) => normalizeWeapon(player.primary ?? player.weapon));
  const hasRifle = weapons.some((weapon) => /AK|M4|AWP|AUG|FAMAS|GALIL|SG 553|SSG|SCAR|G3SG1/i.test(weapon));
  if (value <= 7_500) return "PISTOL";
  if (value < 12_000 && !hasRifle) return "ECO";
  if (value < 18_000) return "FORCE";
  return "FULL";
}

export function classifyEconomy(players: readonly CsNetPlayerState[], side: "CT" | "T"): { kind: CsNetEconomyClass; value: number } {
  const sidePlayers = players.filter((player) => player.side === side);
  if (!sidePlayers.length) return { kind: "UNKNOWN", value: 0 };
  const value = sidePlayers.reduce((total, player) => total + Math.max(finite(player.equipValue), finite(player.money)), 0);
  return { kind: economyForValue(value, sidePlayers), value };
}

function toModelState(round: CsNetRound, frame: CsNetFrame): Record<string, unknown> {
  const players = [...frame.players].sort((a, b) => (a.side === b.side ? 0 : a.side === "CT" ? -1 : 1)).slice(0, 10);
  const bomb = activeBomb(round, frame.t);
  const projectiles = round.events
    .filter((event) => event.type === "grenade" && (event.kind === "smoke" || event.kind === "fire") && finite(event.t) <= frame.t && finite(event.endT, frame.t) >= frame.t)
    .slice(0, MAX_PROJECTILES)
    .map((event) => ({ type: event.kind === "smoke" ? "smokegrenade" : "inferno", position: [finite(event.x), finite(event.y), finite(event.z)], duration: Math.max(0, frame.t - finite(event.t)) }));
  return {
    players_info: players.map((player, index) => ({
      X: finite(player.x), Y: finite(player.y), Z: finite(player.z), steamid: player.steamId, is_alive: player.alive, armor: finite(player.armor), has_helmet: Boolean(player.helmet), has_defuser: Boolean(player.defuser), flash_duration: 0, pitch: 0, yaw: finite(player.yaw), health: finite(player.health), team_num: player.side, velocity: 0, velocity_X: 0, velocity_Y: 0, velocity_Z: 0, inventory: inventoryIds(player), _index: index,
    })),
    map_name: CS_NET_MAP,
    bomb_position: bomb && bomb.state !== "gone" && bomb.x !== undefined ? [finite(bomb.x), finite(bomb.y), finite(bomb.z)] : undefined,
    is_bomb_planted: bomb?.state === "planted",
    is_bomb_dropped: bomb?.state === "ground",
    bomb_planted_duration: bomb?.state === "planted" ? Math.max(0, frame.t - finite(round.events.find((event) => event.type === "bomb_planted")?.t)) : 0,
    round_seconds: Math.max(0, frame.t),
    projectiles,
  };
}

function buildFeatureFromState(state: Record<string, unknown>): CsNetModelInputs {
  const out = zeroFeature();
  const players = (state.players_info as Array<Record<string, unknown>> | undefined) ?? [];
  for (let index = 0; index < Math.min(10, players.length); index += 1) {
    const player = players[index];
    if (!player.is_alive) {
      out.dead_mask[0][index] = true;
      continue;
    }
    const x = finite(player.X), y = finite(player.Y), z = finite(player.Z);
    out.mlp1_f[0][index] = xyz(x, y, z);
    out.mlp1_i[0][index] = MAP_INDEX;
    out.mlp1_mask[0][index] = true;
    const pitch = finite(player.pitch) * Math.PI / 180;
    const yaw = finite(player.yaw) * Math.PI / 180;
    out.mlp2_f[0][index] = [Number(finite(player.armor) > 0), Number(Boolean(player.has_helmet)), Number(Boolean(player.has_defuser)), Number(finite(player.flash_duration) > 0), Math.cos(pitch), Math.sin(pitch), Math.cos(yaw), Math.sin(yaw), finite(player.health) / 100, Number(player.team_num === "CT"), clipScale(finite(player.velocity), 0, 8000), clipScale(finite(player.velocity_X), -8000, 8000), clipScale(finite(player.velocity_Y), -8000, 8000), clipScale(finite(player.velocity_Z), -1000, 1000)];
    out.mlp2_mask[0][index] = true;
    const inventory = Array.isArray(player.inventory) ? player.inventory as number[] : [];
    out.emb1_i[0][index] = inventory.slice(0, 9).concat(Array(9).fill(0)).slice(0, 9);
    out.emb1_mask[0][index] = inventory.slice(0, 9).map(() => true).concat(Array(9).fill(false)).slice(0, 9);
  }
  const bomb = state.bomb_position as number[] | undefined;
  if (bomb) {
    out.mlp1_f[0][10] = xyz(bomb[0], bomb[1], bomb[2]);
    out.mlp1_i[0][10] = MAP_INDEX;
    out.mlp1_mask[0][10] = true;
    out.emb2_i[0][10] = MAP_INDEX;
    out.emb2_mask[0][10] = true;
    out.mlp4_f[0][10] = [finite(state.round_seconds) / 160, Number(Boolean(state.is_bomb_planted)), Number(Boolean(state.is_bomb_dropped)), finite(state.bomb_planted_duration) / 40];
    out.mlp4_mask[0][10] = true;
  }
  const projectiles = (state.projectiles as Array<Record<string, unknown>> | undefined) ?? [];
  for (let index = 0; index < Math.min(MAX_PROJECTILES, projectiles.length); index += 1) {
    const projectile = projectiles[index];
    const token = index + 11;
    const type = String(projectile.type);
    const position = Array.isArray(projectile.position) ? projectile.position as number[] : [0, 0, 0];
    const projectileIndex = PROJECTILE_INDEX.get(type);
    if (projectileIndex === undefined) continue;
    out.mlp1_f[0][token] = xyz(position[0], position[1], position[2]);
    out.mlp1_i[0][token] = MAP_INDEX;
    out.mlp1_mask[0][token] = true;
    out.mlp3_f[0][token] = [finite(projectile.duration) / 25];
    out.mlp3_i[0][token] = projectileIndex;
    out.mlp3_mask[0][token] = true;
  }
  for (let index = 11 + Math.min(MAX_PROJECTILES, projectiles.length); index < 31; index += 1) out.pad_mask[0][index] = true;
  for (let index = 0; index < Math.min(10, players.length); index += 1) {
    const player = players[index];
    if (!player.is_alive) continue;
    const rels: number[][] = [];
    const ids: number[] = [];
    for (let otherIndex = 0; otherIndex < Math.min(10, players.length); otherIndex += 1) {
      if (otherIndex === index || !players[otherIndex].is_alive) continue;
      const other = players[otherIndex];
      const dx = finite(other.X) - finite(player.X), dy = finite(other.Y) - finite(player.Y), dz = finite(other.Z) - finite(player.Z);
      const distance = Math.hypot(dx, dy, dz);
      const yaw = finite(player.yaw) * Math.PI / 180;
      const xy = Math.hypot(dx, dy);
      const dot = xy > 0 ? Math.max(-1, Math.min(1, (dx * Math.cos(yaw) + dy * Math.sin(yaw)) / xy)) : 1;
      const dxy = Math.acos(dot);
      const targetPitch = xy > 0 ? Math.atan2(dz, xy) : Math.sign(dz) * Math.PI / 2;
      const dzAngle = Math.abs(finite(player.pitch) * Math.PI / 180 - targetPitch);
      const teammate = player.team_num === other.team_num;
      rels.push([clipScale(dx, -5000, 5000), clipScale(dy, -5000, 5000), clipScale(dz, -2000, 2000), Math.log(clipScale(distance, 0, 5000) + 1), Number(teammate), Number(!teammate), 0, 0, 0, Math.cos(dxy), Math.sin(dxy), Math.cos(dzAngle), Math.sin(dzAngle)]);
      ids.push(otherIndex);
    }
    out.mlp5_f[0][index] = rels.slice(0, 9).concat(Array.from({ length: Math.max(0, 9 - rels.length) }, () => Array(13).fill(0)));
    out.mlp5_i[0][index] = ids.slice(0, 9).concat(Array(9).fill(0)).slice(0, 9);
    out.mlp5_mask[0][index] = ids.slice(0, 9).map(() => true).concat(Array(9).fill(false)).slice(0, 9);
  }
  return out;
}

function stackSamples(samples: readonly CsNetModelInputs[]): CsNetModelInputs {
  const keys = Object.keys(samples[0] ?? {}) as (keyof CsNetModelInputs)[];
  const result = {} as CsNetModelInputs;
  for (const key of keys) Object.assign(result, { [key]: samples.flatMap((sample) => sample[key] as unknown[]) });
  return result;
}

function buildCsNetFeatureSample(round: CsNetRound, frame: CsNetFrame): CsNetFeatureSample {
  const sorted = [...frame.players].sort((a, b) => (a.side === b.side ? 0 : a.side === "CT" ? -1 : 1)).slice(0, 10);
  const normalizedFrame = { ...frame, players: sorted };
  return {
    roundNumber: round.number,
    tick: frame.tick,
    t: frame.t,
    sideOrder: sorted.map((player) => player.steamId),
    inputs: buildFeatureFromState(toModelState(round, normalizedFrame)),
  };
}

function batchFromSamples(samples: readonly CsNetFeatureSample[]): CsNetModelBatch {
  return { samples, inputs: stackSamples(samples.map((sample) => sample.inputs)) };
}

export function buildCsNetFeatureBatch(replay: CsNetReplay): CsNetModelBatch {
  if (replay.map !== CS_NET_MAP) throw new Error(`cs-net win-rate head currently supports ${CS_NET_MAP}; received ${replay.map}.`);
  const samples: CsNetFeatureSample[] = [];
  for (const round of replay.rounds) {
    for (const frame of round.frames) samples.push(buildCsNetFeatureSample(round, frame));
  }
  if (samples.length === 0) throw new Error("cs-net replay contains no inference samples.");
  return batchFromSamples(samples);
}

/**
 * Stream feature batches without constructing one giant model tensor. The
 * yielded sample order is the canonical round/frame order and is intentionally
 * independent of the requested inference batch size.
 */
export function *buildCsNetFeatureBatches(
  replay: CsNetReplay,
  batchSize: number,
): Generator<CsNetModelBatch> {
  if (replay.map !== CS_NET_MAP) throw new Error(`cs-net win-rate head currently supports ${CS_NET_MAP}; received ${replay.map}.`);
  const size = Math.max(1, Math.floor(batchSize));
  let pending: CsNetFeatureSample[] = [];
  for (const round of replay.rounds) {
    for (const frame of round.frames) {
      pending.push(buildCsNetFeatureSample(round, frame));
      if (pending.length >= size) {
        yield batchFromSamples(pending);
        pending = [];
      }
    }
  }
  if (pending.length > 0) yield batchFromSamples(pending);
}

export function flattenFeatureBatch(batch: CsNetModelBatch): Record<string, Float32Array | BigInt64Array | Uint8Array> {
  const out: Record<string, Float32Array | BigInt64Array | Uint8Array> = {};
  const floatKeys: (keyof CsNetModelInputs)[] = ["mlp1_f", "mlp2_f", "mlp3_f", "mlp4_f", "mlp5_f"];
  const intKeys: (keyof CsNetModelInputs)[] = ["mlp1_i", "mlp3_i", "mlp5_i", "emb1_i", "emb2_i"];
  const boolKeys: (keyof CsNetModelInputs)[] = ["mlp1_mask", "mlp2_mask", "mlp3_mask", "mlp4_mask", "mlp5_mask", "emb1_mask", "emb2_mask", "dead_mask", "pad_mask"];
  const flat = (value: unknown): number[] => Array.isArray(value) ? value.flat(Infinity) as number[] : [];
  for (const key of floatKeys) out[key] = new Float32Array(flat(batch.inputs[key]));
  for (const key of intKeys) out[key] = new BigInt64Array(flat(batch.inputs[key]).map((value) => BigInt(Math.trunc(value))));
  for (const key of boolKeys) out[key] = new Uint8Array(flat(batch.inputs[key]).map((value) => value ? 1 : 0));
  return out;
}

export function sigmoidTemperature(logit: number, temperature = CS_NET_SOURCE.temperature): number {
  const scaled = finite(logit) / temperature;
  return 1 / (1 + Math.exp(-Math.max(-40, Math.min(40, scaled))));
}

export function classifyRoundEconomy(round: CsNetRound): WinProbabilityEconomy {
  const first = round.frames.find((frame) => frame.tick >= round.startTick) ?? round.frames[0];
  const ct = first ? classifyEconomy(first.players, "CT") : { kind: "UNKNOWN" as const, value: 0 };
  const t = first ? classifyEconomy(first.players, "T") : { kind: "UNKNOWN" as const, value: 0 };
  return { ct: ct.kind, t: t.kind, ctValue: ct.value, tValue: t.value };
}

export function buildWinProbabilityTimeline(args: {
  replay: CsNetReplay;
  samples: readonly CsNetFeatureSample[];
  logits: readonly number[];
  selectedPlayerId?: string;
  model?: Partial<WinProbabilityTimelineV1["model"]>;
}): WinProbabilityTimelineV1 {
  const model = { provider: "CS_NET" as const, revision: CS_NET_SOURCE.modelRevision, assetUrl: CS_NET_SOURCE.assetUrl, assetSha256: CS_NET_SOURCE.assetSha256, assetBytes: CS_NET_SOURCE.assetBytes, quantization: "INT8" as const, temperature: CS_NET_SOURCE.temperature, sourceCommit: CS_NET_SOURCE.commit, featureVersion: CS_NET_FEATURE_VERSION, ...args.model };
  const samples = args.samples.map((sample, index) => ({ tick: sample.tick, probability: sigmoidTemperature(args.logits[index] ?? 0), roundNumber: sample.roundNumber, side: "CT" as const, source: "CS_NET" as const }));
  const rounds: WinProbabilityRound[] = args.replay.rounds.map((round) => {
    const roundSamples = samples.filter((sample) => sample.roundNumber === round.number);
    const first = roundSamples[0];
    const last = roundSamples.at(-1);
    const terminal = round.winner ? { tick: Math.max(round.endTick, round.postEndTick), probability: round.winner === "CT" ? 1 as const : 0 as const, winner: round.winner, source: "ROUND_WINNER" as const } : undefined;
    return { roundNumber: round.number, startTick: round.freezeStartTick, endTick: round.postEndTick, winner: round.winner, economy: classifyRoundEconomy(round), samples: first && last ? roundSamples : [], terminal };
  });
  const swings: WinProbabilitySwing[] = [];
  for (const round of rounds) {
    const roundSamples = round.samples;
    for (let index = 1; index < roundSamples.length; index += 1) {
      const before = roundSamples[index - 1]; const after = roundSamples[index]; const delta = after.probability - before.probability;
      if (Math.abs(delta) < 0.12) continue;
      const kill = args.replay.rounds.find((candidate) => candidate.number === round.roundNumber)?.events.find((event) => event.type === "kill" && Math.abs(event.tick - after.tick) <= Math.max(1, args.replay.demoTickRate / 2));
      swings.push({ id: `swing-${round.roundNumber}-${after.tick}`, tick: after.tick, before: before.probability, after: after.probability, delta, direction: delta > 0 ? "UP" : "DOWN", cause: kill ? "PLAYER_DEATH" : "ROUND_RESULT", victimSide: kill ? args.replay.players.find((player) => player.steamId === kill.victimSteamId)?.startSide : undefined, selectedPlayerDeath: Boolean(kill?.victimSteamId && kill.victimSteamId === args.selectedPlayerId), economy: round.economy[args.replay.players.find((player) => player.steamId === args.selectedPlayerId)?.startSide === "T" ? "t" : "ct"] });
    }
  }
  return { version: CS_NET_TIMELINE_VERSION, status: "AVAILABLE", model, tickRate: args.replay.demoTickRate, rounds, swings, limitations: ["Full-match signal is model evidence, not an ObservableClaim.", "Yaw/pitch visibility and velocity are absent from the pinned cs2d frame schema and are zero/derived conservatively.", "Terminal points use canonical round winner metadata and are not model samples."] };
}

export function unavailableWinProbabilityTimeline(reason: string, tickRate = 64): WinProbabilityTimelineV1 {
  return { version: CS_NET_TIMELINE_VERSION, status: "UNAVAILABLE", model: { provider: "CS_NET", revision: CS_NET_SOURCE.modelRevision, assetUrl: CS_NET_SOURCE.assetUrl, assetSha256: CS_NET_SOURCE.assetSha256, assetBytes: CS_NET_SOURCE.assetBytes, quantization: "INT8", temperature: CS_NET_SOURCE.temperature, sourceCommit: CS_NET_SOURCE.commit, featureVersion: CS_NET_FEATURE_VERSION }, tickRate, rounds: [], swings: [], limitations: ["Model unavailable; deterministic Director fallback remains active."], unavailableReason: reason.slice(0, 240) };
}

export function outcomeImpactText(before: number, after: number): string {
  const beforePct = Math.round(before * 100); const afterPct = Math.round(after * 100); const points = Math.round(Math.abs(after - before) * 100);
  if (points === 0) return `这段处理前后我方胜率都在 ${beforePct}% 左右，先把信息拿全再接下一步。`;
  const verb = after < before ? "掉了" : "抬到";
  return `这段处理前我方胜率约 ${beforePct}%，处理后${verb} ${afterPct}%，${points} 个百分点；先小身位 peek 拿信息，再决定要不要拉。`;
}

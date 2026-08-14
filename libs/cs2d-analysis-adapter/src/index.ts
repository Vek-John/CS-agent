import type {
  Advice,
  Annotation,
  CoachCue,
  Evidence,
  Fact,
  Inference,
  MatchEvent,
  MatchPlayer,
  MatchTimeline,
  PlayerStateSample,
  PlayerTrack,
  PlayerTrackSample,
  ReviewPlan,
  ReviewSegment,
  RoundTimeline,
  TeamSide
} from "@cs-coach/contracts";
import type {
  ObservableState,
  WorldPoint
} from "@cs-coach/contracts";
import {
  assertValidObservableState,
  buildObservableState,
  directVisionFactFromSample
} from "@cs-coach/observation";
import { assertValidReviewPlan } from "@cs-coach/review-planner";

/**
 * The adapter's only upstream dependency is this structural port.  It is
 * intentionally not an import from `.local-data/upstream/cs2d`: that checkout
 * has no LICENSE and its implementation is not copied into this repository.
 *
 * The fields below match the pinned cs2d replay-core schema closely enough for
 * a parsed Replay to be passed directly from the WASM worker.  Optional fields
 * are deliberately tolerated so old/sparse replay JSON can degrade with
 * explicit limitations instead of inventing facts.
 */
export const CS2D_SOURCE = {
  repository: "zenojunior/cs2d",
  commit: "dbbe698c9b9c91f9a14cecea92374b4114bf60ec",
  license_status: "NO_LICENSE_FOUND_DO_NOT_COPY_IMPLEMENTATION",
  input_boundary: "WASM_WORKER_STRUCTURED_REPLAY_ONLY"
} as const;

export const CS2D_ADAPTER_VERSION = "cs2d-analysis-adapter/1.1.0" as const;
export const CS2D_TIMELINE_VERSION = "zenojunior/cs2d@dbbe698c9b9c91f9a14cecea92374b4114bf60ec/timeline/1.0.0" as const;
export const CS2D_OBSERVATION_VERSION = "cs2d-analysis-adapter/1.0.0/internal-observation" as const;
export const CS2D_SIGNAL_VERSION = "cs2d-analysis-adapter/1.1.0/signals" as const;
export const CS2D_PLANNER_VERSION = "cs2d-analysis-adapter/1.1.0/planner" as const;

/** MVP pacing target: a full match should feel coached, not interrupted. */
const MAX_TEACHING_CUES = 8;
const OUTCOME_WINDOW_SECONDS = 4;

export const CS2D_LIMITATIONS = {
  frameSampling:
    "cs2d Frame 是下采样状态（常见约 8Hz），不是逐 tick/lossless 状态；帧间变化只能作为区间或趋势证据。",
  shotAttribution:
    "cs2d ShotEvent 没有 shooterSteamId；适配层不把射击归因到任何玩家，等待 parser 扩展。",
  hurtEvents:
    "当前 cs2d GameEvent 没有 HurtEvent；Round.damage 只有回合聚合，不能伪装成逐 tick 受击。",
  observationBoundary:
    "内部 ObservationState 只服务于选手决策证据和 LLM 引用，不是用户视角或 renderer 输入。",
  parserExtension:
    "若需要逐次伤害或射击主体，需要 parser 提供 HurtEvent 与 ShotEvent.shooterSteamId。"
} as const;

export interface Cs2dPlayerMeta {
  readonly steamId: string;
  readonly name: string;
  readonly startSide: TeamSide;
  readonly compColor?: number;
}

export interface Cs2dPlayerState {
  readonly steamId: string;
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly yaw: number;
  readonly health: number;
  readonly alive: boolean;
  readonly side: TeamSide;
  readonly weapon: string;
  readonly primary?: string;
  readonly money: number;
  readonly equipValue: number;
  readonly armor: number;
  readonly helmet?: boolean;
  readonly defuser?: boolean;
  readonly grenades?: readonly string[];
}

export interface Cs2dFrame {
  readonly tick: number;
  readonly t: number;
  readonly players: readonly Cs2dPlayerState[];
}

export interface Cs2dKillEvent {
  readonly type: "kill";
  readonly tick: number;
  readonly t: number;
  readonly attackerSteamId: string | null;
  readonly victimSteamId: string;
  readonly assisterSteamId: string | null;
  readonly assistedFlash: boolean;
  readonly weapon: string;
  readonly headshot: boolean;
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

export interface Cs2dBombEvent {
  readonly type: "bomb_planted" | "bomb_defused" | "bomb_exploded";
  readonly tick: number;
  readonly t: number;
  readonly playerSteamId: string | null;
}

export interface Cs2dGrenadeEvent {
  readonly type: "grenade";
  readonly tick: number;
  readonly t: number;
  readonly kind: "smoke" | "fire" | "he" | "flash" | "decoy";
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly endT: number;
}

export interface Cs2dShotEvent {
  readonly type: "shot";
  readonly tick: number;
  readonly t: number;
  readonly x: number;
  readonly y: number;
  readonly yaw: number;
}

export type Cs2dGameEvent =
  | Cs2dKillEvent
  | Cs2dBombEvent
  | Cs2dGrenadeEvent
  | Cs2dShotEvent;

export interface Cs2dGrenadePathPoint {
  readonly t: number;
  readonly x: number;
  readonly y: number;
}

export interface Cs2dGrenadePath {
  readonly kind: "smoke" | "fire" | "he" | "flash" | "decoy";
  readonly points: readonly Cs2dGrenadePathPoint[];
  readonly throwerSteamId: string | null;
}

/** Minimal structural subset of a cs2d Round. */
export interface Cs2dRound {
  readonly number: number;
  readonly freezeStartTick: number;
  readonly startTick: number;
  readonly decidedTick: number;
  readonly endTick: number;
  readonly postEndTick: number;
  readonly winner: "CT" | "T" | null;
  readonly scoreCt: number;
  readonly scoreT: number;
  readonly damage?: Readonly<Record<string, number>>;
  readonly frames: readonly Cs2dFrame[];
  readonly events: readonly Cs2dGameEvent[];
  readonly grenadePaths: readonly Cs2dGrenadePath[];
}

/** Minimal structural subset of the cs2d replay-core Replay. */
export interface Cs2dReplay {
  readonly map: string;
  readonly demoTickRate: number;
  readonly frameRate: number;
  readonly players: readonly Cs2dPlayerMeta[];
  readonly rounds: readonly Cs2dRound[];
  readonly finalScoreCt?: number;
  readonly finalScoreT?: number;
}

export interface Cs2dReplaySourceMetadata {
  readonly kind: "CS2D_STRUCTURED_REPLAY";
  readonly repository: typeof CS2D_SOURCE.repository;
  readonly commit: typeof CS2D_SOURCE.commit;
  readonly license_status: typeof CS2D_SOURCE.license_status;
  readonly input_boundary: typeof CS2D_SOURCE.input_boundary;
  readonly parsed_once_in: "WASM_WORKER";
  readonly binary_reparse_by_adapter: false;
  readonly frame_rate: number;
}

export interface Cs2dAnalysisInput {
  readonly replay: Cs2dReplay;
  readonly selectedSteamId: string;
  /** Stable local/demo identifier; it is not sent to the narration provider. */
  readonly demoId: string;
}

export interface Cs2dExcludedRound {
  readonly source_index: number;
  readonly source_round_number: number | null;
  readonly start_tick?: number;
  readonly end_tick?: number;
  readonly reason: "NON_OFFICIAL_ROUND_0" | "MISSING_FORMAL_ROUND_NUMBER" | "MISSING_FORMAL_WINNER" | "DUPLICATE_FORMAL_ROUND_NUMBER";
}

export interface Cs2dAnalysisMetadata {
  readonly adapter_version: typeof CS2D_ADAPTER_VERSION;
  readonly source: Cs2dReplaySourceMetadata;
  readonly input_map: string;
  readonly selected_steam_id: string;
  readonly selection_policy: "EXPLICIT_PLAYER";
  readonly canonical_tick_source: readonly ["ROUND", "FRAME", "GAME_EVENT"];
  readonly canonical_tick_range: { readonly start_tick: number; readonly end_tick: number } | null;
  readonly observation_role: "INTERNAL_LLM_EVIDENCE_ONLY";
  readonly renderer_input: false;
  readonly replay_binary_reparsed: false;
  readonly raw_replay_retained_by_caller: true;
  readonly excluded_rounds: readonly Cs2dExcludedRound[];
  readonly limitations: readonly string[];
  readonly warnings: readonly string[];
}

/** Output intentionally excludes the raw Replay. It is the analysis/session port. */
export interface Cs2dAnalysisBundle {
  readonly demo_id: string;
  readonly selected_steam_id: string;
  readonly match_timeline: MatchTimeline;
  readonly review_plan: ReviewPlan;
  /** Internal evidence component; Session/renderer must not treat it as omniscient state. */
  readonly observation_evidence: readonly ObservableState[];
  readonly metadata: Cs2dAnalysisMetadata;
}

interface NormalizedRound {
  readonly sourceIndex: number;
  readonly number: number;
  readonly startTick: number;
  readonly freezeEndTick: number;
  readonly endTick: number;
  readonly decidedTick: number;
  readonly officialEndTick: number;
  readonly winner: TeamSide;
  readonly scoreCt: number;
  readonly scoreT: number;
  readonly scoreAfter: readonly [number, number];
  readonly damage?: Readonly<Record<string, number>>;
  readonly source: Cs2dRound;
}

interface NormalizedState {
  readonly roundNumber: number;
  readonly sample: PlayerStateSample;
  readonly source: Cs2dPlayerState;
}

type SignalKind = "DEATH" | "KILL" | "BOMB" | "UTILITY" | "HP_CHANGE";

interface SignalCandidate {
  readonly round: NormalizedRound;
  readonly kind: SignalKind;
  readonly habitKey: string;
  readonly sourceTick: number;
  readonly decisionTick: number;
  readonly revealTick: number;
  readonly state?: NormalizedState;
  readonly sourceRef: string;
  readonly utilityKind?: string;
  readonly timingLimitation?: string;
}

interface SelectedCandidate extends SignalCandidate {
  readonly outcomeEndTick: number;
  readonly occurrenceIndex: number;
}

interface Counters {
  fact: number;
  inference: number;
  advice: number;
  evidence: number;
  cue: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function asArray<T>(value: readonly T[] | null | undefined): readonly T[] {
  return Array.isArray(value) ? value : [];
}

function finiteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function finiteTick(value: unknown): value is number {
  return finiteNumber(value) && Number.isSafeInteger(value);
}

function safeText(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

function sideOrFallback(value: unknown, fallback: TeamSide): TeamSide {
  return value === "CT" || value === "T" ? value : fallback;
}

function clampInteger(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, Math.trunc(value)));
}

function uniqueStrings(values: readonly string[]): string[] {
  return [...new Set(values.filter((value) => value.trim()))];
}

function issue(warnings: string[], message: string): void {
  if (!warnings.includes(message)) warnings.push(message);
}

function findFallbackSide(replay: Cs2dReplay): TeamSide {
  const side = replay.players.find((player) => player.startSide === "CT" || player.startSide === "T")?.startSide;
  return sideOrFallback(side, "T");
}

function normalizeRounds(
  replay: Cs2dReplay,
  warnings: string[],
  excludedRounds: Cs2dExcludedRound[]
): NormalizedRound[] {
  const rounds: NormalizedRound[] = [];
  const seenRoundNumbers = new Set<number>();

  asArray(replay.rounds).forEach((source, sourceIndex) => {
    if (!isRecord(source)) {
      issue(warnings, "Round " + String(sourceIndex + 1) + " is not an object and was skipped.");
      excludedRounds.push({ source_index: sourceIndex, source_round_number: null, reason: "MISSING_FORMAL_ROUND_NUMBER" });
      return;
    }

    const rawNumber = finiteTick(source.number) ? source.number : null;
    const frames = asArray(source.frames);
    const events = asArray(source.events);
    const ticks = [
      ...frames.map((frame) => frame?.tick),
      ...events.map((event) => event?.tick)
    ].filter(finiteTick);
    const rawFreeze = finiteTick(source.freezeStartTick) ? source.freezeStartTick : undefined;
    const rawStart = finiteTick(source.startTick) ? source.startTick : undefined;
    const rawDecided = finiteTick(source.decidedTick) ? source.decidedTick : undefined;
    const rawEnd = finiteTick(source.endTick) ? source.endTick : undefined;
    const rawPostEnd = finiteTick(source.postEndTick) ? source.postEndTick : undefined;
    const startTick = rawFreeze ?? rawStart ?? ticks[0];
    const freezeEndTick = rawStart ?? startTick;
    const officialEndTick = rawEnd ?? rawPostEnd ?? (ticks.length ? Math.max(...ticks) + 1 : undefined);
    const endTick = rawPostEnd ?? officialEndTick;

    if (rawNumber === null || rawNumber < 0) {
      issue(warnings, "Round " + String(sourceIndex + 1) + " has no formal round number and was excluded from coaching.");
      excludedRounds.push({
        source_index: sourceIndex,
        source_round_number: rawNumber,
        ...(startTick === undefined ? {} : { start_tick: startTick }),
        ...(endTick === undefined ? {} : { end_tick: endTick }),
        reason: "MISSING_FORMAL_ROUND_NUMBER"
      });
      return;
    }
    if (rawNumber === 0) {
      issue(warnings, "Non-official Round0 was excluded; the caller retains the original cs2d Replay.");
      excludedRounds.push({
        source_index: sourceIndex,
        source_round_number: rawNumber,
        ...(startTick === undefined ? {} : { start_tick: startTick }),
        ...(endTick === undefined ? {} : { end_tick: endTick }),
        reason: "NON_OFFICIAL_ROUND_0"
      });
      return;
    }
    if (seenRoundNumbers.has(rawNumber)) {
      issue(warnings, "Formal round " + String(rawNumber) + " is duplicated and the later copy was excluded.");
      excludedRounds.push({
        source_index: sourceIndex,
        source_round_number: rawNumber,
        ...(startTick === undefined ? {} : { start_tick: startTick }),
        ...(endTick === undefined ? {} : { end_tick: endTick }),
        reason: "DUPLICATE_FORMAL_ROUND_NUMBER"
      });
      return;
    }
    if (source.winner !== "CT" && source.winner !== "T") {
      issue(warnings, "Formal round " + String(rawNumber) + " has no winner and was excluded instead of guessing one.");
      excludedRounds.push({
        source_index: sourceIndex,
        source_round_number: rawNumber,
        ...(startTick === undefined ? {} : { start_tick: startTick }),
        ...(endTick === undefined ? {} : { end_tick: endTick }),
        reason: "MISSING_FORMAL_WINNER"
      });
      return;
    }
    if (
      startTick === undefined ||
      endTick === undefined ||
      officialEndTick === undefined ||
      endTick <= startTick ||
      officialEndTick <= startTick
    ) {
      issue(warnings, "Formal round " + String(rawNumber) + " has no valid canonical tick range and was excluded.");
      excludedRounds.push({
        source_index: sourceIndex,
        source_round_number: rawNumber,
        ...(startTick === undefined ? {} : { start_tick: startTick }),
        ...(endTick === undefined ? {} : { end_tick: endTick }),
        reason: "MISSING_FORMAL_ROUND_NUMBER"
      });
      return;
    }
    if (rawFreeze === undefined) issue(warnings, "Formal round " + String(rawNumber) + " is missing freezeStartTick.");
    if (rawEnd === undefined) issue(warnings, "Formal round " + String(rawNumber) + " is missing official endTick; available end is used for cue bounds.");
    if (rawPostEnd === undefined) issue(warnings, "Formal round " + String(rawNumber) + " is missing postEndTick; official end is used for timeline coverage.");

    const normalizedEnd = Math.max(startTick + 1, endTick);
    const normalizedOfficialEnd = clampInteger(officialEndTick, startTick + 1, normalizedEnd);
    const normalizedFreezeEnd = clampInteger(freezeEndTick ?? startTick, startTick, normalizedOfficialEnd);
    const normalizedDecided = clampInteger(rawDecided ?? normalizedOfficialEnd, normalizedFreezeEnd, normalizedOfficialEnd);
    rounds.push({
      sourceIndex,
      number: rawNumber,
      startTick,
      freezeEndTick: normalizedFreezeEnd,
      endTick: normalizedEnd,
      decidedTick: normalizedDecided,
      officialEndTick: normalizedOfficialEnd,
      winner: source.winner,
      scoreCt: finiteNumber(source.scoreCt) ? source.scoreCt : 0,
      scoreT: finiteNumber(source.scoreT) ? source.scoreT : 0,
      scoreAfter: [0, 0],
      damage: source.damage,
      source
    });
    seenRoundNumbers.add(rawNumber);
  });

  rounds.sort((left, right) => left.startTick - right.startTick || left.sourceIndex - right.sourceIndex);
  const nonOverlapping: NormalizedRound[] = [];
  for (const round of rounds) {
    const previous = nonOverlapping.at(-1);
    if (previous && round.startTick < previous.endTick) {
      issue(warnings, "Formal round " + String(round.number) + " overlaps the prior round and was excluded.");
      excludedRounds.push({
        source_index: round.sourceIndex,
        source_round_number: round.number,
        start_tick: round.startTick,
        end_tick: round.endTick,
        reason: "DUPLICATE_FORMAL_ROUND_NUMBER"
      });
      continue;
    }
    nonOverlapping.push(round);
  }

  return nonOverlapping.map((round, index, all) => {
    const next = all[index + 1];
    const scoreAfter: readonly [number, number] = next
      ? [next.scoreT, next.scoreCt]
      : finiteNumber(replay.finalScoreT) && finiteNumber(replay.finalScoreCt)
        ? [replay.finalScoreT, replay.finalScoreCt]
        : [
            round.scoreT + (round.winner === "T" ? 1 : 0),
            round.scoreCt + (round.winner === "CT" ? 1 : 0)
          ];
    return { ...round, scoreAfter };
  });
}

function normalizeStateSample(
  state: Cs2dPlayerState,
  tick: number,
  factRef: string,
  warnings: string[]
): PlayerStateSample | undefined {
  if (!isRecord(state) || typeof state.steamId !== "string" || !state.steamId.trim()) return undefined;
  if (![state.x, state.y, state.z, state.yaw, state.health, state.armor].every(finiteNumber)) {
    issue(warnings, `Frame state for ${state.steamId} at tick ${tick} has incomplete numeric position/health fields.`);
    return undefined;
  }
  const missingFields: string[] = ["pitch", "velocity"];
  const weapon = safeText(state.weapon, "UNKNOWN_ITEM");
  if (weapon === "UNKNOWN_ITEM") missingFields.push("active_item");
  if (!finiteNumber(state.money)) missingFields.push("money");
  if (!finiteNumber(state.equipValue)) missingFields.push("equipment_value");
  if (state.grenades === undefined) missingFields.push("inventory");

  const inventory = asArray(state.grenades).filter((item): item is string => typeof item === "string" && Boolean(item.trim())).map((item) => ({
    item_id: item,
    item_class: "UTILITY",
    count: 1
  }));
  const activeItem = weapon === "UNKNOWN_ITEM"
    ? undefined
    : { item_id: weapon, item_class: classifyItem(weapon) };

  return {
    player_id: state.steamId,
    tick,
    side: sideOrFallback(state.side, "T"),
    world_position: { x: state.x, y: state.y, z: state.z },
    yaw: state.yaw,
    pitch: 0,
    alive: state.alive === true,
    health: Math.max(0, state.health),
    armor: Math.max(0, state.armor),
    has_helmet: state.helmet === true,
    ...(finiteNumber(state.money) ? { money: state.money } : {}),
    ...(finiteNumber(state.equipValue) ? { equipment_value: state.equipValue } : {}),
    ...(activeItem ? { active_item: activeItem } : {}),
    inventory,
    ...(state.defuser === true ? { has_defuse_kit: true } : {}),
    fact_refs: [factRef],
    missing_fields: uniqueStrings(missingFields)
  };
}

function classifyItem(item: string): string {
  const normalized = item.toLowerCase();
  if (["smoke", "fire", "he", "flash", "decoy", "molotov", "incendiary"].some((word) => normalized.includes(word))) {
    return "UTILITY";
  }
  if (
    normalized.includes("knife") ||
    normalized.includes("bayonet") ||
    normalized === "faca" ||
    normalized.includes("karambit")
  ) return "KNIFE";
  if (normalized.includes("bomb") || normalized === "c4") return "BOMB";
  return "WEAPON";
}

function decisionHabitKey(candidate: SignalCandidate): string {
  const source = candidate.state?.source;
  let context = "contact-preparation";
  if (source) {
    const activeClass = classifyItem(safeText(source.weapon, "UNKNOWN_ITEM"));
    if (activeClass === "BOMB") context = "bomb-carrier-safety";
    else if (activeClass === "UTILITY") context = "utility-readiness";
    else if (source.health <= 45) context = "low-health-survival";
    else if (activeClass === "KNIFE") context = "rotation-safety";
    else if (source.armor <= 0) context = "unarmored-contact";
  }

  const liveSpan = Math.max(1, candidate.round.decidedTick - candidate.round.freezeEndTick);
  const progress = (candidate.decisionTick - candidate.round.freezeEndTick) / liveSpan;
  const phase = progress < 0.34 ? "early" : progress < 0.72 ? "mid" : "late";
  return `${context}.${phase}`;
}

function collectStates(
  replay: Cs2dReplay,
  rounds: readonly NormalizedRound[],
  selectedSteamId: string,
  warnings: string[]
): NormalizedState[] {
  const states: NormalizedState[] = [];
  for (const round of rounds) {
    const seenTicks = new Set<number>();
    for (const frame of asArray(round.source.frames)) {
      if (!finiteTick(frame?.tick) || frame.tick < round.startTick || frame.tick >= round.endTick) continue;
      const sourceState = asArray(frame.players).find((player) => player?.steamId === selectedSteamId);
      if (!sourceState || seenTicks.has(frame.tick)) continue;
      const factRef = `state-${round.number}-${frame.tick}`;
      const sample = normalizeStateSample(sourceState, frame.tick, factRef, warnings);
      if (!sample) continue;
      seenTicks.add(frame.tick);
      states.push({ roundNumber: round.number, sample, source: sourceState });
    }
  }
  states.sort((left, right) => left.sample.tick - right.sample.tick || left.roundNumber - right.roundNumber);
  if (states.length === 0) issue(warnings, `No Frame state was available for selected player ${selectedSteamId}; cues will be downgraded.`);
  if (asArray(replay.rounds).some((round) => asArray(round?.frames).length > 0) && states.length > 0) {
    issue(warnings, CS2D_LIMITATIONS.frameSampling);
  }
  return states;
}

function statesForRound(states: readonly NormalizedState[], round: NormalizedRound): NormalizedState[] {
  return states.filter((state) => state.roundNumber === round.number && state.sample.tick >= round.startTick && state.sample.tick < round.endTick);
}

function stateAtOrBefore(states: readonly NormalizedState[], tick: number): NormalizedState | undefined {
  let best: NormalizedState | undefined;
  for (const state of states) {
    if (state.sample.tick > tick) break;
    best = state;
  }
  return best;
}

function precedingDecisionTick(
  states: readonly NormalizedState[],
  round: NormalizedRound,
  revealTick: number
): number | undefined {
  const prior = [...states].reverse().find((state) => state.sample.tick < revealTick)?.sample.tick;
  const candidate = Math.max(round.freezeEndTick, prior ?? revealTick - 1);
  return candidate < revealTick ? candidate : undefined;
}

function sourceRef(round: NormalizedRound, index: number): string {
  return `cs2d-r${round.number}-event-${index + 1}`;
}

function collectCandidates(
  replay: Cs2dReplay,
  rounds: readonly NormalizedRound[],
  states: readonly NormalizedState[],
  selectedSteamId: string,
  tickRate: number,
  warnings: string[]
): SignalCandidate[] {
  const candidates: SignalCandidate[] = [];
  let sawShot = false;
  let sawAggregateDamage = false;

  for (const round of rounds) {
    const roundStates = statesForRound(states, round);
    const sourceEvents = asArray(round.source.events);
    sourceEvents.forEach((event, eventIndex) => {
      if (!isRecord(event) || !finiteTick(event.tick) || event.tick < round.freezeEndTick || event.tick >= round.decidedTick) return;
      const ref = sourceRef(round, eventIndex);
      if (event.type === "shot") {
        sawShot = true;
        return;
      }

      if (event.type === "kill") {
        const actor = typeof event.attackerSteamId === "string" ? event.attackerSteamId : undefined;
        const victim = typeof event.victimSteamId === "string" ? event.victimSteamId : undefined;
        const kind: SignalKind | undefined = victim === selectedSteamId ? "DEATH" : actor === selectedSteamId ? "KILL" : undefined;
        if (!kind) return;
        const decisionTick = precedingDecisionTick(roundStates, round, event.tick);
        if (decisionTick === undefined) return;
        candidates.push({
          round,
          kind,
          habitKey: "decision-reset",
          sourceTick: event.tick,
          decisionTick,
          revealTick: event.tick,
          state: stateAtOrBefore(roundStates, decisionTick),
          sourceRef: ref
        });
        return;
      }

      if (event.type === "bomb_planted" || event.type === "bomb_defused" || event.type === "bomb_exploded") {
        if (event.playerSteamId !== selectedSteamId) return;
        const decisionTick = precedingDecisionTick(roundStates, round, event.tick);
        if (decisionTick === undefined) return;
        candidates.push({
          round,
          kind: "BOMB",
          habitKey: "decision-reset",
          sourceTick: event.tick,
          decisionTick,
          revealTick: event.tick,
          state: stateAtOrBefore(roundStates, decisionTick),
          sourceRef: ref
        });
      }
    });

    if (round.damage && finiteNumber(round.damage[selectedSteamId]) && round.damage[selectedSteamId] > 0) {
      sawAggregateDamage = true;
    }

    for (const path of asArray(round.source.grenadePaths)) {
      if (path?.throwerSteamId !== selectedSteamId) continue;
      const points = asArray(path.points)
        .filter((point) => finiteNumber(point?.t) && finiteNumber(point?.x) && finiteNumber(point?.y))
        .slice()
        .sort((left, right) => left.t - right.t);
      if (points.length < 2) {
        issue(warnings, "Round " + String(round.number) + " has a selected-player grenade path with insufficient samples.");
        continue;
      }
      const pathResolutionTicks = Math.max(1, Math.ceil(tickRate * 0.1));
      const launchApproxTick = Math.round(round.startTick + points[0].t * tickRate);
      const endApproxTick = Math.round(round.startTick + points.at(-1)!.t * tickRate);
      const launchLowerBound = launchApproxTick - pathResolutionTicks;
      const endUpperBound = endApproxTick + pathResolutionTicks;
      if (launchLowerBound < round.freezeEndTick || endUpperBound >= round.decidedTick) continue;

      const decisionState = [...roundStates].reverse().find(
        (state) => state.sample.tick <= launchLowerBound
      );
      const revealState = roundStates.find(
        (state) => state.sample.tick >= endUpperBound
      );
      if (!decisionState || !revealState || revealState.sample.tick <= decisionState.sample.tick) {
        issue(warnings, "Selected-player GrenadePath was not converted to a cue because no conservative Frame boundaries were available.");
        continue;
      }
      candidates.push({
        round,
        kind: "UTILITY",
        habitKey: "decision-reset",
        sourceTick: launchApproxTick,
        decisionTick: decisionState.sample.tick,
        revealTick: revealState.sample.tick,
        state: decisionState,
        sourceRef: "cs2d-r" + String(round.number) + "-grenade-" + String(points[0].t) + "-" + String(points.at(-1)!.t),
        utilityKind: path.kind
      });
      issue(warnings, "GrenadePath.t is rounded to about 0.1s; utility cue boundaries use conservative canonical Frame ticks and never claim an exact throw or landing tick.");
    }

    for (let index = 1; index < roundStates.length; index += 1) {
      const previous = roundStates[index - 1];
      const current = roundStates[index];
      if (current.roundNumber !== previous.roundNumber || current.sample.tick <= previous.sample.tick || current.sample.tick >= round.decidedTick || current.sample.health >= previous.sample.health) continue;
      const decisionTick = Math.max(round.freezeEndTick, previous.sample.tick);
      if (decisionTick >= current.sample.tick) continue;
      candidates.push({
        round,
        kind: "HP_CHANGE",
        habitKey: "decision-reset",
        sourceTick: current.sample.tick,
        decisionTick,
        revealTick: current.sample.tick,
        state: previous,
        sourceRef: `cs2d-r${round.number}-frame-health-${previous.sample.tick}-${current.sample.tick}`
      });
    }
  }

  if (sawShot) issue(warnings, CS2D_LIMITATIONS.shotAttribution);
  if (sawAggregateDamage) issue(warnings, CS2D_LIMITATIONS.hurtEvents);
  issue(warnings, CS2D_LIMITATIONS.parserExtension);

  const priority: Record<SignalKind, number> = { DEATH: 0, HP_CHANGE: 1, KILL: 2, BOMB: 3, UTILITY: 4 };
  candidates.sort((left, right) =>
    left.decisionTick - right.decisionTick ||
    priority[left.kind] - priority[right.kind] ||
    left.revealTick - right.revealTick ||
    left.sourceRef.localeCompare(right.sourceRef)
  );
  return candidates;
}

function selectCandidates(
  candidates: readonly SignalCandidate[],
  tickRate: number,
  warnings: string[]
): SelectedCandidate[] {
  type WindowedCandidate = SignalCandidate & { outcomeEndTick: number };
  const accepted: WindowedCandidate[] = [];
  let cursorByRound = new Map<number, number>();
  const outcomeSpan = Math.max(1, Math.round(tickRate * OUTCOME_WINDOW_SECONDS));

  for (const candidate of candidates) {
    const cursor = cursorByRound.get(candidate.round.number) ?? candidate.round.freezeEndTick;
    if (candidate.decisionTick < cursor || candidate.revealTick <= candidate.decisionTick || candidate.revealTick >= candidate.round.decidedTick) continue;
    const outcomeEndTick = Math.min(candidate.round.decidedTick, Math.max(candidate.revealTick + 1, candidate.revealTick + outcomeSpan));
    if (outcomeEndTick <= candidate.revealTick) continue;
    accepted.push({
      ...candidate,
      habitKey: decisionHabitKey(candidate),
      outcomeEndTick
    });
    cursorByRound = new Map(cursorByRound).set(candidate.round.number, outcomeEndTick);
  }

  const priority: Record<SignalKind, number> = { DEATH: 0, HP_CHANGE: 1, KILL: 2, BOMB: 3, UTILITY: 4 };
  const byRound = new Map<number, WindowedCandidate[]>();
  for (const candidate of accepted) {
    const group = byRound.get(candidate.round.number) ?? [];
    group.push(candidate);
    byRound.set(candidate.round.number, group);
  }

  const representativePerRound = [...byRound.values()]
    .map((group) => [...group].sort((left, right) =>
      priority[left.kind] - priority[right.kind] ||
      left.decisionTick - right.decisionTick ||
      left.sourceRef.localeCompare(right.sourceRef)
    )[0])
    .filter((candidate): candidate is WindowedCandidate => Boolean(candidate))
    .sort((left, right) => left.decisionTick - right.decisionTick);

  let chosen: WindowedCandidate[];
  if (representativePerRound.length > MAX_TEACHING_CUES) {
    const indexes = new Set<number>();
    for (let index = 0; index < MAX_TEACHING_CUES; index += 1) {
      indexes.add(Math.round(index * (representativePerRound.length - 1) / (MAX_TEACHING_CUES - 1)));
    }
    chosen = [...indexes].map((index) => representativePerRound[index]).filter(Boolean);
  } else {
    chosen = [...representativePerRound];
    const chosenRefs = new Set(chosen.map((candidate) => candidate.sourceRef));
    const remaining = accepted
      .filter((candidate) => !chosenRefs.has(candidate.sourceRef))
      .sort((left, right) =>
        priority[left.kind] - priority[right.kind] ||
        left.decisionTick - right.decisionTick ||
        left.sourceRef.localeCompare(right.sourceRef)
      );
    chosen.push(...remaining.slice(0, Math.max(0, MAX_TEACHING_CUES - chosen.length)));
  }

  chosen.sort((left, right) => left.decisionTick - right.decisionTick || left.sourceRef.localeCompare(right.sourceRef));
  if (accepted.length > chosen.length) {
    issue(warnings, `Teaching cues were paced to ${chosen.length}/${accepted.length} candidates (maximum ${MAX_TEACHING_CUES}); all timeline segments remain covered.`);
  }

  const groupedCounts = new Map<string, number>();
  return chosen.map((candidate) => {
    const occurrenceIndex = (groupedCounts.get(candidate.habitKey) ?? 0) + 1;
    groupedCounts.set(candidate.habitKey, occurrenceIndex);
    return { ...candidate, occurrenceIndex };
  });
}

function buildRoundTimeline(round: NormalizedRound): RoundTimeline {
  return {
    round_number: round.number,
    start_tick: round.startTick,
    freeze_end_tick: round.freezeEndTick,
    end_tick: round.endTick,
    score_before: [round.scoreT, round.scoreCt],
    score_after: round.scoreAfter,
    winner: round.winner
  };
}

function buildPlayerStateTrack(states: readonly NormalizedState[], selectedSteamId: string): PlayerTrack {
  const samples: PlayerTrackSample[] = states
    .filter((state) => state.sample.player_id === selectedSteamId)
    .map((state) => ({
      tick: state.sample.tick,
      x: state.sample.world_position.x,
      y: state.sample.world_position.y,
      alive: state.sample.alive,
      observed_by_selected: true
    }));
  return { player_id: selectedSteamId, samples };
}

function buildPlayers(replay: Cs2dReplay, selectedSteamId: string, warnings: string[]): MatchPlayer[] {
  const players: MatchPlayer[] = [];
  const seen = new Set<string>();
  for (const player of asArray(replay.players)) {
    if (!isRecord(player) || typeof player.steamId !== "string" || !player.steamId.trim() || seen.has(player.steamId)) continue;
    seen.add(player.steamId);
    players.push({
      player_id: player.steamId,
      display_name: safeText(player.name, "Unknown player"),
      side: sideOrFallback(player.startSide, "T"),
      is_selected: player.steamId === selectedSteamId
    });
  }
  if (players.length < 10) issue(warnings, `Replay exposes ${players.length} player metadata entries; ten-player completeness is not guaranteed.`);
  return players;
}

function worldAnnotation(state: NormalizedState | undefined): Annotation[] {
  if (!state) return [];
  const point = state.sample.world_position;
  return [{
    id: "decision-position",
    type: "POINT",
    coordinate_space: "WORLD",
    point,
    label: "选手决策时的自身位置"
  }];
}

function cueText(habitKey: string, isHabit: boolean): {
  title: string;
  explanation: string;
  advice: string;
  trigger: string;
  ruleId: string;
  taxonomy: string;
} {
  const context = habitKey.split(".")[0];
  const base = context === "utility-readiness"
    ? {
        title: "道具出手前先定义它要创造的窗口",
        explanation: "教练判断：你现在手持道具，先确认它要阻断哪条视线、帮助谁启动，以及出手后能否安全回到掩体。",
        advice: "先用一句话定义这颗道具的目标；队友尚未能同步就保留，能同步时再出手。",
        trigger: "手持道具并准备离开掩体或进入投掷动作时",
        ruleId: "utility-window"
      }
    : context === "low-health-survival"
      ? {
          title: "低血量时把第一接触让给更有容错的人",
          explanation: "教练判断：当前生命值压低了你的换血容错，优先保留交叉、补枪或延迟信息价值，而不是主动承担第一接触。",
          advice: "让高血量队友先确认接触，你从第二枪线补枪；独自时只做能立刻撤回的短探。",
          trigger: "生命值较低且下一步可能进入正面接触时",
          ruleId: "low-health-second-contact"
        }
      : context === "rotation-safety"
        ? {
            title: "切刀提速前先确认这段路已经安全",
            explanation: "教练判断：刀在手能换来速度，也会放大突然接触的代价；先用已有信息确认安全窗口，再决定提速距离。",
            advice: "只在已确认安全的路段切刀；接近未知拐角前提前切回武器并完成预瞄。",
            trigger: "刀在手且即将进入未确认区域时",
            ruleId: "rotation-weapon-ready"
          }
        : context === "bomb-carrier-safety"
          ? {
              title: "持包决策先保证掉包位置可以回收",
              explanation: "教练判断：你承担的不只是个人对枪，C4 的可回收性会改变全队后续选择；先把包留在队友能接应的位置。",
              advice: "不要带包单独穿过未知区域；需要先探时把包交出，或让队友建立可回收枪线。",
              trigger: "携带 C4 且准备脱离队友覆盖时",
              ruleId: "bomb-recoverability"
            }
          : context === "unarmored-contact"
            ? {
                title: "无甲接触更依赖第一枪和撤回线",
                explanation: "教练判断：当前护甲不足会降低连续换血容错，接触前要让准星、掩体和撤回方向同时就位。",
                advice: "先把准星落在最可能的第一接触位，只暴露能立即撤回的身位，不做长距离连续找人。",
                trigger: "护甲不足且准备离开掩体进入接触区时",
                ruleId: "unarmored-contact-discipline"
              }
            : {
                title: "接触前把准星和撤回路线对齐",
                explanation: "教练判断：当前最重要的是让第一枪位置、可撤回掩体和队友接应形成同一个动作，而不是边移动边临时决定。",
                advice: "进入未知角度前先停半拍确认准星与退路；没有新增信息时保留可调整站位。",
                trigger: "准备进入下一段未知枪线且退出条件尚未确认时",
                ruleId: "contact-preparation"
              };

  return {
    ...base,
    title: isHabit ? `再次出现：${base.title}` : base.title,
    taxonomy: habitKey
  };
}

function stateFactText(state: NormalizedState): string {
  const source = state.source;
  const weapon = safeText(source.weapon, "未知手持");
  const hp = finiteNumber(source.health) ? String(Math.max(0, source.health)) : "未知";
  const armor = finiteNumber(source.armor) ? String(Math.max(0, source.armor)) : "未知";
  const helmet = source.helmet === true ? "有头盔" : "无头盔";
  const utilityCount = asArray(source.grenades).length;
  return `当前可验证的自身状态：生命值 ${hp}，护甲 ${armor}（${helmet}），手持 ${weapon}，剩余道具 ${utilityCount}；位置来自下采样 Frame。`;
}

function buildCue(
  candidate: SelectedCandidate,
  segmentId: string,
  counters: Counters,
  warnings: readonly string[],
  timelineVersion: string
): { cue: CoachCue; observation?: ObservableState; habitKey: string } {
  const cueId = `c${counters.cue++}`;
  const factRefs: string[] = [];
  const facts: Fact[] = [];
  let observation: ObservableState | undefined;
  if (candidate.state) {
    const factId = `f${counters.fact++}`;
    factRefs.push(factId);
    facts.push({
      id: factId,
      text: stateFactText(candidate.state),
      availability: "DECISION",
      available_at_tick: candidate.state.sample.tick,
      source: "DEMO",
      observed_by_player: true
    });
    const visionFact = directVisionFactFromSample(
      factId,
      candidate.state.sample.player_id,
      {
        player_id: candidate.state.sample.player_id,
        tick: candidate.state.sample.tick,
        world_position: candidate.state.sample.world_position
      }
    );
    observation = buildObservableState({
      id: `obs-${cueId}`,
      demo_id: "pending",
      timeline_version: timelineVersion,
      observer_player_id: candidate.state.sample.player_id,
      at_tick: candidate.decisionTick,
      observation_version: CS2D_OBSERVATION_VERSION,
      facts: [visionFact],
      limitations: [CS2D_LIMITATIONS.observationBoundary, CS2D_LIMITATIONS.frameSampling]
    });
  }

  const text = cueText(candidate.habitKey, candidate.occurrenceIndex > 1);
  const inferenceId = `i${counters.inference++}`;
  const adviceId = `a${counters.advice++}`;
  const evidenceId = `e${counters.evidence++}`;
  const cueLimitations = uniqueStrings([
    CS2D_LIMITATIONS.frameSampling,
    "暂停点可由后续事件索引定位，但决策侧文案、事实和 reason_code 不包含事件类型或结果。"
  ]);
  const inferences: Inference[] = [{
    id: inferenceId,
    text: text.explanation,
    confidence: candidate.state ? 0.72 : 0.45,
    fact_refs: [...factRefs]
  }];
  const advice: Advice[] = [{
    id: adviceId,
    text: text.advice,
    trigger: text.trigger,
    fact_refs: [...factRefs],
    rule_id: text.ruleId
  }];
  const evidence: Evidence[] = [{
    id: evidenceId,
    source: "RULE",
    label: "选手决策时的可执行检查规则",
    sample_count: candidate.state ? 1 : undefined,
    fact_refs: [...factRefs]
  }];

  const cue: CoachCue = {
    id: cueId,
    segment_id: segmentId,
    cue_type: candidate.occurrenceIndex > 1 ? "HABIT_RECHECK" : "DECISION",
    title: text.title,
    question: text.explanation,
    decision_tick: candidate.decisionTick,
    reveal_tick: candidate.revealTick,
    outcome_start_tick: candidate.decisionTick,
    outcome_end_tick: candidate.outcomeEndTick,
    facts,
    inferences,
    advice,
    evidence,
    observable_fact_refs: [...factRefs],
    ...(observation ? { observable_state_id: observation.id } : {}),
    annotations: worldAnnotation(candidate.state),
    confidence: candidate.state ? 0.72 : 0.45,
    limitations: cueLimitations
  };
  return { cue, observation, habitKey: candidate.habitKey };
}

function lowValueSegment(
  id: string,
  roundNumber: number,
  startTick: number,
  endTick: number,
  reasonCode: string,
  displayReason: string
): ReviewSegment {
  return {
    id,
    round_number: roundNumber,
    start_tick: startTick,
    end_tick: endTick,
    mode: "SKIP",
    reason_code: reasonCode,
    display_reason: displayReason,
    playback_speed: 8,
    cue_ids: [],
    expandable: true
  };
}

function buildPlanSegments(
  rounds: readonly NormalizedRound[],
  selected: readonly SelectedCandidate[],
  counters: Counters,
  warnings: readonly string[],
  demoId: string,
  selectedSteamId: string,
  timeline: MatchTimeline
): { segments: ReviewSegment[]; cues: CoachCue[]; observations: ObservableState[]; habitClusters: ReviewPlan["habit_clusters"] } {
  const segments: ReviewSegment[] = [];
  const cues: CoachCue[] = [];
  const observations: ObservableState[] = [];
  const habitCueIds = new Map<string, string[]>();
  const selectedByRound = new Map<number, SelectedCandidate[]>();
  for (const candidate of selected) {
    const list = selectedByRound.get(candidate.round.number) ?? [];
    list.push(candidate);
    selectedByRound.set(candidate.round.number, list);
  }

  for (const round of rounds) {
    let cursor = round.startTick;
    if (round.freezeEndTick > round.startTick) {
      segments.push(lowValueSegment(
        `seg-r${round.number}-freeze`,
        round.number,
        round.startTick,
        round.freezeEndTick,
        "FREEZE_TIME",
        "冻结时间由 Session 自动消费；保留为完整比赛覆盖。"
      ));
      cursor = round.freezeEndTick;
    }

    const candidates = selectedByRound.get(round.number) ?? [];
    for (const candidate of candidates) {
      if (candidate.decisionTick < cursor || candidate.outcomeEndTick <= candidate.decisionTick) continue;
      if (cursor < candidate.decisionTick) {
        segments.push(lowValueSegment(
          `seg-r${round.number}-skip-${cursor}-${candidate.decisionTick}`,
          round.number,
          cursor,
          candidate.decisionTick,
          "LOW_VALUE_FAST_FORWARD",
          "普通低价值区间快速带过；需要时可展开查看。"
        ));
      }
      const cueSegmentId = `seg-r${round.number}-cue-${counters.cue}`;
      const built = buildCue(candidate, cueSegmentId, counters, warnings, timeline.timeline_version);
      if (built.observation) {
        observations.push({
          ...built.observation,
          demo_id: demoId
        });
      }
      cues.push(built.cue);
      const cueIds = habitCueIds.get(built.habitKey) ?? [];
      cueIds.push(built.cue.id);
      habitCueIds.set(built.habitKey, cueIds);
      segments.push({
        id: cueSegmentId,
        round_number: round.number,
        start_tick: candidate.decisionTick,
        end_tick: candidate.outcomeEndTick,
        mode: candidate.occurrenceIndex > 1 ? "HABIT_CHECK" : "DEEP_DIVE",
        reason_code: candidate.occurrenceIndex > 1 ? "REPEATED_DECISION_PATTERN" : "COACH_DECISION_POINT",
        display_reason: candidate.occurrenceIndex > 1
          ? "相同决策模式再次出现：直接复盘判断，再播放结果。"
          : "关键接触前暂停：直接说明当前判断与可执行理由。",
        playback_speed: 1,
        cue_ids: [built.cue.id],
        expandable: true
      });
      cursor = candidate.outcomeEndTick;
    }
    if (cursor < round.decidedTick) {
      segments.push(lowValueSegment(
        `seg-r${round.number}-tail-${cursor}-${round.decidedTick}`,
        round.number,
        cursor,
        round.decidedTick,
        "LOW_VALUE_FAST_FORWARD",
        "普通低价值区间快速带过；完整保留到回合判定。"
      ));
    }
    if (round.decidedTick < round.endTick) {
      segments.push(lowValueSegment(
        `seg-r${round.number}-post-${round.decidedTick}-${round.endTick}`,
        round.number,
        round.decidedTick,
        round.endTick,
        "POST_ROUND",
        "回合胜负判定后的反应与过渡时间显式跳过。"
      ));
    }
  }

  for (let index = 1; index < rounds.length; index += 1) {
    const previous = rounds[index - 1];
    const current = rounds[index];
    if (previous.endTick < current.startTick) {
      segments.push(lowValueSegment(
        `seg-gap-${previous.number}-${current.number}`,
        0,
        previous.endTick,
        current.startTick,
        "INTER_ROUND_GAP",
        "回合之间的非比赛区间显式跳过。"
      ));
    }
  }
  segments.sort((left, right) => left.start_tick - right.start_tick || left.end_tick - right.end_tick || left.id.localeCompare(right.id));

  const habitClusters = [...habitCueIds.entries()]
    .filter(([, cueIds]) => cueIds.length >= 1)
    .map(([habitKey, cueIds], index) => ({
      id: `habit-${index + 1}`,
      title: cueText(habitKey, false).title,
      taxonomy_id: habitKey,
      cue_ids: cueIds,
      occurrence_count: cueIds.length,
      opportunity_count: cueIds.length
    }));

  return { segments, cues, observations, habitClusters };
}

function buildSelectedMatchEvents(
  rounds: readonly NormalizedRound[],
  selectedSteamId: string,
  states: readonly NormalizedState[]
): MatchEvent[] {
  const events: MatchEvent[] = [];
  let index = 1;
  for (const round of rounds) {
    for (const event of asArray(round.source.events)) {
      if (!isRecord(event) || !finiteTick(event.tick) || event.tick < round.startTick || event.tick >= round.officialEndTick) continue;
      if (event.type === "kill") {
        const actor = typeof event.attackerSteamId === "string" ? event.attackerSteamId : undefined;
        const victim = typeof event.victimSteamId === "string" ? event.victimSteamId : undefined;
        if (actor !== selectedSteamId && victim !== selectedSteamId) continue;
        events.push({
          id: `me${index++}`,
          tick: event.tick,
          event_type: victim === selectedSteamId ? "PLAYER_DEATH" : "OTHER",
          ...(actor ? { actor_player_id: actor } : {}),
          ...(victim ? { target_player_id: victim } : {}),
          payload: { source: "cs2d", game_event: "kill", selected_role: victim === selectedSteamId ? "victim" : "attacker" },
          source_parser_event: "cs2d:kill",
          fact_confidence: 1,
          fact_refs: [],
          missing_fields: []
        });
      } else if ((event.type === "bomb_planted" || event.type === "bomb_defused" || event.type === "bomb_exploded") && event.playerSteamId === selectedSteamId) {
        const eventType = event.type === "bomb_planted" ? "BOMB_PLANT" : event.type === "bomb_defused" ? "BOMB_DEFUSE" : "OTHER";
        events.push({
          id: `me${index++}`,
          tick: event.tick,
          event_type: eventType,
          actor_player_id: selectedSteamId,
          payload: { source: "cs2d", game_event: event.type },
          source_parser_event: `cs2d:${event.type}`,
          fact_confidence: 1,
          fact_refs: [],
          missing_fields: []
        });
      }
    }
  }

  for (let stateIndex = 1; stateIndex < states.length; stateIndex += 1) {
    const previous = states[stateIndex - 1];
    const current = states[stateIndex];
    if (current.roundNumber !== previous.roundNumber || current.sample.health >= previous.sample.health || current.sample.tick <= previous.sample.tick || current.sample.tick >= (rounds.find((round) => round.number === current.roundNumber)?.officialEndTick ?? Number.MAX_SAFE_INTEGER)) continue;
    events.push({
      id: `me${index++}`,
      tick: current.sample.tick,
      event_type: "DAMAGE",
      target_player_id: selectedSteamId,
      payload: {
        source: "cs2d-frame-diff",
        prior_health: previous.sample.health,
        current_health: current.sample.health,
        interval_start_tick: previous.sample.tick,
        interval_end_tick: current.sample.tick
      },
      source_parser_event: "cs2d:frame-health-step",
      fact_confidence: 0.45,
      fact_refs: [],
      missing_fields: ["HurtEvent", "exact_attacker", "exact_damage_tick"]
    });
  }
  return events.sort((left, right) => left.tick - right.tick || left.id.localeCompare(right.id));
}

function buildTimeline(
  replay: Cs2dReplay,
  rounds: readonly NormalizedRound[],
  selectedSteamId: string,
  states: readonly NormalizedState[],
  warnings: string[]
): MatchTimeline {
  const startTick = rounds[0]?.startTick ?? 0;
  const endTick = rounds.at(-1)?.endTick ?? startTick;
  const timeline: MatchTimeline = {
    id: `timeline-${replay.map}-${replay.demoTickRate}`,
    demo_id: "pending",
    source_kind: "PARSED_DEMO",
    map_name: "de_mirage",
    tick_rate: finiteNumber(replay.demoTickRate) && replay.demoTickRate > 0 ? replay.demoTickRate : 64,
    start_tick: startTick,
    end_tick: endTick,
    selected_player_id: selectedSteamId,
    players: buildPlayers(replay, selectedSteamId, warnings),
    tracks: [buildPlayerStateTrack(states, selectedSteamId)],
    player_state_tracks: states.map((state) => state.sample),
    match_events: buildSelectedMatchEvents(rounds, selectedSteamId, states),
    rounds: rounds.map(buildRoundTimeline),
    timeline_version: CS2D_TIMELINE_VERSION
  };
  return timeline;
}

function failedBundle(input: Cs2dAnalysisInput, metadata: Cs2dAnalysisMetadata, timeline: MatchTimeline): Cs2dAnalysisBundle {
  const failedPlan: ReviewPlan = {
    id: `plan-${input.demoId}-${input.selectedSteamId}`,
    demo_id: input.demoId,
    player_id: input.selectedSteamId,
    status: "FAILED",
    match_timeline_version: timeline.timeline_version,
    observation_version: CS2D_OBSERVATION_VERSION,
    signal_version: CS2D_SIGNAL_VERSION,
    planner_version: CS2D_PLANNER_VERSION,
    estimated_duration_seconds: 0,
    available_until_round: 0,
    full_match_index_ready: false,
    global_aggregation_ready: false,
    segments: [],
    cues: [],
    habit_clusters: [],
    generation_manifest: {
      parser_version: `${CS2D_SOURCE.repository}@${CS2D_SOURCE.commit}`,
      observation_version: CS2D_OBSERVATION_VERSION,
      signal_version: CS2D_SIGNAL_VERSION,
      planner_version: CS2D_PLANNER_VERSION,
      provider: "DETERMINISTIC_TEMPLATE",
      prompt_version: "cs2d-decision-template/1.1.0",
      status: "FALLBACK",
      narration_deterministic: true,
      analysis_subject_selection: "EXPLICIT_PLAYER",
      analysis_subject_player_id: input.selectedSteamId,
      limitations: [...metadata.limitations]
    }
  };
  return { demo_id: input.demoId, selected_steam_id: input.selectedSteamId, match_timeline: timeline, review_plan: failedPlan, observation_evidence: [], metadata };
}

/** Build a deterministic Session/DeepSeek-ready analysis bundle from one WASM Replay. */
export function buildCs2dAnalysisBundle(input: Cs2dAnalysisInput): Cs2dAnalysisBundle {
  const warnings: string[] = [];
  const limitations: string[] = [
    CS2D_LIMITATIONS.frameSampling,
    CS2D_LIMITATIONS.observationBoundary,
    CS2D_LIMITATIONS.shotAttribution,
    CS2D_LIMITATIONS.hurtEvents
  ];
  const replay = input.replay;
  const players = asArray(replay?.players);
  const selectedPlayer = players.find((player) => player?.steamId === input.selectedSteamId);
  if (!selectedPlayer) {
    throw new Error(`selectedSteamId ${input.selectedSteamId} is not present in cs2d Replay.players.`);
  }
  if (!input.demoId.trim()) throw new Error("demoId must be a stable non-empty identifier.");
  if (replay.map !== "de_mirage") {
    throw new Error(`cs2d analysis currently supports de_mirage only; received ${safeText(replay.map, "unknown")}. The cs2d renderer may still play that map without AI analysis.`);
  }

  const excludedRounds: Cs2dExcludedRound[] = [];
  const rounds = normalizeRounds(replay, warnings, excludedRounds);
  const source: Cs2dReplaySourceMetadata = {
    kind: "CS2D_STRUCTURED_REPLAY",
    repository: CS2D_SOURCE.repository,
    commit: CS2D_SOURCE.commit,
    license_status: CS2D_SOURCE.license_status,
    input_boundary: CS2D_SOURCE.input_boundary,
    parsed_once_in: "WASM_WORKER",
    binary_reparse_by_adapter: false,
    frame_rate: finiteNumber(replay.frameRate) ? replay.frameRate : 0
  };
  const metadataBase: Omit<Cs2dAnalysisMetadata, "limitations" | "warnings"> = {
    adapter_version: CS2D_ADAPTER_VERSION,
    source,
    input_map: safeText(replay.map, "unknown"),
    selected_steam_id: input.selectedSteamId,
    selection_policy: "EXPLICIT_PLAYER" as const,
    canonical_tick_source: ["ROUND", "FRAME", "GAME_EVENT"] as const,
    canonical_tick_range: rounds.length
      ? { start_tick: rounds[0].startTick, end_tick: rounds.at(-1)!.endTick }
      : null,
    observation_role: "INTERNAL_LLM_EVIDENCE_ONLY" as const,
    renderer_input: false as const,
    replay_binary_reparsed: false as const,
    raw_replay_retained_by_caller: true,
    excluded_rounds: [...excludedRounds]
  };

  if (rounds.length === 0) {
    issue(warnings, "No canonical tick range could be derived from Round/Frame/GameEvent data.");
    const emptyTimeline: MatchTimeline = {
      id: `timeline-${safeText(replay.map, "unknown")}-${replay.demoTickRate}`,
      demo_id: input.demoId,
      source_kind: "PARSED_DEMO",
      map_name: "de_mirage",
      tick_rate: finiteNumber(replay.demoTickRate) && replay.demoTickRate > 0 ? replay.demoTickRate : 64,
      start_tick: 0,
      end_tick: 0,
      selected_player_id: input.selectedSteamId,
      players: buildPlayers(replay, input.selectedSteamId, warnings),
      tracks: [{ player_id: input.selectedSteamId, samples: [] }],
      rounds: [],
      timeline_version: CS2D_TIMELINE_VERSION
    };
    const metadata: Cs2dAnalysisMetadata = { ...metadataBase, limitations: [...limitations], warnings: [...warnings] };
    return failedBundle(input, metadata, emptyTimeline);
  }

  const tickRate = finiteNumber(replay.demoTickRate) && replay.demoTickRate > 0 ? replay.demoTickRate : 64;
  const states = collectStates(replay, rounds, input.selectedSteamId, warnings);
  const candidates = collectCandidates(replay, rounds, states, input.selectedSteamId, tickRate, warnings);
  const selected = selectCandidates(candidates, tickRate, warnings);
  const provisionalTimeline = buildTimeline(replay, rounds, input.selectedSteamId, states, warnings);
  const timeline: MatchTimeline = { ...provisionalTimeline, demo_id: input.demoId };
  const counters: Counters = { fact: 1, inference: 1, advice: 1, evidence: 1, cue: 1 };
  const built = buildPlanSegments(rounds, selected, counters, warnings, input.demoId, input.selectedSteamId, timeline);

  const plan: ReviewPlan = {
    id: `plan-${input.demoId}-${input.selectedSteamId}`,
    demo_id: input.demoId,
    player_id: input.selectedSteamId,
    status: "COMPLETE",
    match_timeline_version: timeline.timeline_version,
    observation_version: CS2D_OBSERVATION_VERSION,
    signal_version: CS2D_SIGNAL_VERSION,
    planner_version: CS2D_PLANNER_VERSION,
    estimated_duration_seconds: (timeline.end_tick - timeline.start_tick) / tickRate,
    available_until_round: rounds.at(-1)?.number ?? 0,
    full_match_index_ready: true,
    global_aggregation_ready: true,
    segments: built.segments,
    cues: built.cues,
    habit_clusters: built.habitClusters,
    generation_manifest: {
      parser_version: `${CS2D_SOURCE.repository}@${CS2D_SOURCE.commit}`,
      observation_version: CS2D_OBSERVATION_VERSION,
      signal_version: CS2D_SIGNAL_VERSION,
      planner_version: CS2D_PLANNER_VERSION,
      provider: "DETERMINISTIC_TEMPLATE",
      prompt_version: "cs2d-decision-template/1.0.0",
      status: "DISABLED",
      narration_deterministic: true,
      analysis_subject_selection: "EXPLICIT_PLAYER",
      analysis_subject_player_id: input.selectedSteamId,
      limitations: [...limitations, ...warnings]
    }
  };

  for (const observation of built.observations) {
    // buildCue first constructs the state before the final demo id is known;
    // the replacement here keeps that internal state tied to the stable demo.
    void observation;
  }
  const observationEvidence = built.observations.map((state) => ({ ...state, demo_id: input.demoId }));
  const metadata: Cs2dAnalysisMetadata = {
    ...metadataBase,
    canonical_tick_range: { start_tick: timeline.start_tick, end_tick: timeline.end_tick },
    limitations: uniqueStrings([...limitations, ...warnings]),
    warnings: [...warnings]
  };

  assertValidReviewPlan(timeline, plan);
  return {
    demo_id: input.demoId,
    selected_steam_id: input.selectedSteamId,
    match_timeline: timeline,
    review_plan: plan,
    observation_evidence: observationEvidence,
    metadata
  };
}

const BUNDLE_KEYS = [
  "demo_id",
  "selected_steam_id",
  "match_timeline",
  "review_plan",
  "observation_evidence",
  "metadata"
] as const;

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  return actual.length === sortedExpected.length && actual.every((key, index) => key === sortedExpected[index]);
}

function assertValidBundle(value: unknown): asserts value is Cs2dAnalysisBundle {
  if (!isRecord(value) || !hasExactKeys(value, BUNDLE_KEYS)) {
    throw new Error("cs2d analysis bundle must contain only the documented top-level fields.");
  }
  const plan = value.review_plan;
  const timeline = value.match_timeline;
  const metadata = value.metadata;
  if (
    typeof value.demo_id !== "string" || !value.demo_id.trim() ||
    typeof value.selected_steam_id !== "string" || !value.selected_steam_id.trim() ||
    !isRecord(plan) || !Array.isArray(plan.segments) || !Array.isArray(plan.cues) ||
    !isRecord(timeline) || !Array.isArray(timeline.rounds) ||
    !Array.isArray(value.observation_evidence) || !isRecord(metadata)
  ) {
    throw new Error("cs2d analysis bundle has an invalid structural shape.");
  }

  const bundle = value as unknown as Cs2dAnalysisBundle;
  if (
    bundle.demo_id !== bundle.match_timeline.demo_id ||
    bundle.demo_id !== bundle.review_plan.demo_id ||
    bundle.selected_steam_id !== bundle.match_timeline.selected_player_id ||
    bundle.selected_steam_id !== bundle.review_plan.player_id
  ) {
    throw new Error("cs2d analysis bundle identifiers do not match.");
  }
  if (
    bundle.metadata.adapter_version !== CS2D_ADAPTER_VERSION ||
    bundle.metadata.source.repository !== CS2D_SOURCE.repository ||
    bundle.metadata.source.commit !== CS2D_SOURCE.commit ||
    bundle.metadata.renderer_input !== false ||
    bundle.metadata.replay_binary_reparsed !== false ||
    bundle.metadata.raw_replay_retained_by_caller !== true
  ) {
    throw new Error("cs2d analysis metadata does not match the pinned adapter boundary.");
  }

  if (bundle.review_plan.status === "COMPLETE") {
    assertValidReviewPlan(bundle.match_timeline, bundle.review_plan);
  } else if (bundle.review_plan.segments.length > 0 || bundle.review_plan.cues.length > 0) {
    throw new Error("A non-complete cs2d analysis plan must not expose partial teaching content.");
  }

  const cueByObservation = new Map(
    bundle.review_plan.cues
      .filter((cue) => cue.observable_state_id)
      .map((cue) => [cue.observable_state_id!, cue])
  );
  const seenObservationIds = new Set<string>();
  for (const state of bundle.observation_evidence) {
    assertValidObservableState(state);
    if (seenObservationIds.has(state.id)) {
      throw new Error(`ObservationState ${state.id} is duplicated.`);
    }
    seenObservationIds.add(state.id);
    const cue = cueByObservation.get(state.id);
    if (
      !cue ||
      state.demo_id !== bundle.demo_id ||
      state.timeline_version !== bundle.match_timeline.timeline_version ||
      state.observer_player_id !== bundle.selected_steam_id ||
      state.at_tick > cue.decision_tick
    ) {
      throw new Error(`ObservationState ${state.id} is not bound to its selected-player decision cue.`);
    }
  }
  if (seenObservationIds.size !== cueByObservation.size) {
    throw new Error("Every cue observable_state_id must resolve to exactly one ObservationState.");
  }
}

/** JSON boundary for workers/storage; no Replay or binary demo is serialized here. */
export function serializeCs2dAnalysisBundle(bundle: Cs2dAnalysisBundle): string {
  const whitelisted: Cs2dAnalysisBundle = {
    demo_id: bundle.demo_id,
    selected_steam_id: bundle.selected_steam_id,
    match_timeline: bundle.match_timeline,
    review_plan: bundle.review_plan,
    observation_evidence: bundle.observation_evidence,
    metadata: bundle.metadata
  };
  assertValidBundle(whitelisted);
  return JSON.stringify(whitelisted);
}

export function deserializeCs2dAnalysisBundle(serialized: string): Cs2dAnalysisBundle {
  let parsed: unknown;
  try {
    parsed = JSON.parse(serialized);
  } catch {
    throw new Error("Serialized cs2d analysis bundle is not valid JSON.");
  }
  assertValidBundle(parsed);
  return parsed;
}

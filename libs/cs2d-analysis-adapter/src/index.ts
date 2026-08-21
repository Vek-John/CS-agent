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
  TeamSide,
  OutcomeImpact,
  WinProbabilityTimelineV1,
  WinProbabilityEconomyClass,
  CanonicalAnalysisFact,
  CanonicalPlayerContext,
  CanonicalSignal,
  CandidateGeneratorInput,
  CandidateSet
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
import { mirageChineseCallout } from "@cs-coach/map-semantics";
import {
  assertValidReviewPlan,
  compileReviewPlan,
  deterministicDirectorFallback,
  generateCandidateSet,
  buildOutcomeImpactForCue,
  assembleCandidateSet,
  collectCandidateSetIssues,
  stableFingerprint
} from "@cs-coach/review-planner";

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

export const CS2D_ADAPTER_VERSION = "cs2d-analysis-adapter/1.3.0" as const;
export const CS2D_TIMELINE_VERSION = "zenojunior/cs2d@dbbe698c9b9c91f9a14cecea92374b4114bf60ec/timeline/1.0.0" as const;
export const CS2D_OBSERVATION_VERSION = "cs2d-analysis-adapter/1.0.0/internal-observation" as const;
export const CS2D_SIGNAL_VERSION = "cs2d-analysis-adapter/1.3.0/signals" as const;
export const CS2D_PLANNER_VERSION = "cs2d-analysis-adapter/1.3.0/planner" as const;

/** MVP pacing target: a full match should feel coached, not interrupted. */
const OUTCOME_WINDOW_SECONDS = 4;
const COACHING_PRE_ROLL_SECONDS = 1;

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
  /** Source-engine navigation place token (`m_szLastPlaceName`). */
  readonly lastPlaceName?: string;
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
  /** Optional full-match model output. The adapter stays usable when the model is unavailable. */
  readonly winProbabilityTimeline?: WinProbabilityTimelineV1;
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
  /** Compact parser-neutral candidate index; raw Replay/frames never cross this seam. */
  readonly candidate_set: CandidateSet;
  /** Internal evidence component; Session/renderer must not treat it as omniscient state. */
  readonly observation_evidence: readonly ObservableState[];
  /** Full-match signal; it is not an ObservableClaim and is never sent to narration. */
  readonly win_probability_timeline: WinProbabilityTimelineV1;
  /** Outcome explanation package, unlocked by Session only after the outcome window. */
  readonly outcome_impacts: readonly OutcomeImpact[];
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

interface RawSignalCandidate {
  readonly round: NormalizedRound;
  readonly kind: SignalKind;
  readonly sourceTick: number;
  readonly decisionTick: number;
  readonly revealTick: number;
  readonly state?: NormalizedState;
  readonly sourceRef: string;
  readonly utilityKind?: string;
  readonly bombEventType?: Cs2dBombEvent["type"];
  readonly timingLimitation?: string;
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
): RawSignalCandidate[] {
  const candidates: RawSignalCandidate[] = [];
  let sawShot = false;
  let sawAggregateDamage = false;

  for (const round of rounds) {
    const roundStates = statesForRound(states, round);
    const sourceEvents = asArray(round.source.events);
    sourceEvents.forEach((event, eventIndex) => {
      if (!isRecord(event) || !finiteTick(event.tick) || event.tick < round.freezeEndTick || event.tick > round.decidedTick) return;
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
          sourceTick: event.tick,
          decisionTick,
          revealTick: event.tick,
          state: stateAtOrBefore(roundStates, decisionTick),
          sourceRef: ref,
          bombEventType: event.type
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
      if (current.roundNumber !== previous.roundNumber || current.sample.tick <= previous.sample.tick || current.sample.tick > round.decidedTick || current.sample.health >= previous.sample.health) continue;
      const decisionTick = Math.max(round.freezeEndTick, previous.sample.tick);
      if (decisionTick >= current.sample.tick) continue;
      candidates.push({
        round,
        kind: "HP_CHANGE",
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

function buildRoundTimeline(round: NormalizedRound): RoundTimeline {
  return {
    round_number: round.number,
    start_tick: round.startTick,
    freeze_end_tick: round.freezeEndTick,
    decided_tick: round.decidedTick,
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

function stateCallout(state: NormalizedState | undefined): string | undefined {
  return mirageChineseCallout(state?.source.lastPlaceName);
}

function worldAnnotation(
  state: NormalizedState | undefined,
  callout: string | undefined
): Annotation[] {
  if (!state) return [];
  const point = state.sample.world_position;
  return [{
    id: "decision-position",
    type: "POINT",
    coordinate_space: "WORLD",
    point,
    label: callout ? `你在${callout}的决策位置` : "你的决策位置"
  }];
}

function economyTerm(state: NormalizedState | undefined): WinProbabilityEconomyClass {
  const source = state?.source;
  if (!source || !finiteNumber(source.money) || !finiteNumber(source.equipValue)) return "UNKNOWN";
  if (source.equipValue < 1_800 && source.money < 2_500) return "ECO";
  if (source.equipValue < 3_500 && source.money < 3_000) return "FORCE";
  return "FULL";
}

function stateFactText(state: NormalizedState): string {
  const source = state.source;
  const weapon = safeText(source.weapon, "未知手持");
  const hp = finiteNumber(source.health) ? String(Math.max(0, source.health)) : "未知";
  const armor = finiteNumber(source.armor) ? Math.max(0, source.armor) : undefined;
  const headArmor = armor === undefined
    ? "头甲未知"
    : armor <= 0
      ? "没甲"
      : source.helmet === true
        ? `头甲齐全（${armor} 甲）`
        : source.helmet === false
          ? `有 ${armor} 甲、没头`
          : `${armor} 甲、头盔未知`;
  const utility = source.grenades === undefined ? "道具数量未知" : `有 ${asArray(source.grenades).length} 颗道具`;
  const economy = finiteNumber(source.money) && finiteNumber(source.equipValue)
    ? `，存款 $${Math.max(0, source.money)}、装备价值 $${Math.max(0, source.equipValue)}`
    : "";
  const callout = stateCallout(state);
  return `${callout ? `你在${callout}` : "当前报点未知"}：${hp} HP，${headArmor}，手持 ${weapon}，${utility}${economy}。`;
}

function actionFactText(candidate: RawSignalCandidate): string {
  const callout = stateCallout(candidate.state);
  const place = callout ? `在${callout}` : "在这里";
  switch (candidate.kind) {
    case "DEATH": return `你${place}继续接了这波对枪。`;
    case "KILL": return `你${place}主动接了这波对枪。`;
    case "BOMB":
      if (candidate.bombEventType === "bomb_planted") return `你${place}直接开始下包。`;
      if (candidate.bombEventType === "bomb_defused") return `你${place}直接开始拆包。`;
      return `你${place}继续处理 C4。`;
    case "UTILITY": return `你${place}使用了${candidate.utilityKind ?? "道具"}。`;
    case "HP_CHANGE": return `你${place}继续留在这条枪线里。`;
  }
}

function outcomeFactText(candidate: RawSignalCandidate): string {
  switch (candidate.kind) {
    case "DEATH": return "你随后继续这次接触，并在这次对枪中被击杀。";
    case "KILL": return "你随后在这次接触中完成击杀。";
    case "HP_CHANGE": return "你随后在这次接触中掉血。";
    case "UTILITY": {
      const utilityNames: Record<string, string> = { smoke: "烟雾弹", fire: "燃烧弹", he: "手雷", flash: "闪光弹", decoy: "诱饵弹" };
      return `你随后投出了这颗${utilityNames[candidate.utilityKind ?? ""] ?? "道具"}。`;
    }
    case "BOMB":
      if (candidate.bombEventType === "bomb_planted") return "你随后完成下包。";
      if (candidate.bombEventType === "bomb_defused") return "你随后完成拆包。";
      if (candidate.bombEventType === "bomb_exploded") return "C4 随后爆炸。";
      return "随后发生了一次 C4 事件。";
  }
}

function candidateContext(state: NormalizedState | undefined): string {
  const source = state?.source;
  if (!source) return "contact-preparation";
  const activeClass = classifyItem(safeText(source.weapon, "UNKNOWN_ITEM"));
  if (activeClass === "BOMB") return "bomb-carrier-safety";
  if (activeClass === "UTILITY") return "utility-readiness";
  if (source.health <= 45) return "low-health-survival";
  if (activeClass === "KNIFE") return "rotation-safety";
  if (source.armor <= 0) return "unarmored-contact";
  return "contact-preparation";
}

function buildCanonicalGeneratorInput(
  rawCandidates: readonly RawSignalCandidate[],
  timeline: MatchTimeline,
  demoId: string,
  selectedSteamId: string,
  tickRate: number,
  winProbabilityTimeline: WinProbabilityTimelineV1,
  warnings: string[]
): CandidateGeneratorInput {
  const facts: CanonicalAnalysisFact[] = [];
  const signals: CanonicalSignal[] = [];
  const observations: ObservableState[] = [];
  for (const raw of rawCandidates) {
    const stateFactId = `fact-${raw.sourceRef}-state`;
    const actionFactId = `fact-${raw.sourceRef}-action`;
    const outcomeFactId = `fact-${raw.sourceRef}-outcome`;
    const state = raw.state;
    if (state) {
      facts.push({
        id: stateFactId,
        kind: "DECISION_CONTEXT",
        roundNumber: raw.round.number,
        tick: state.sample.tick,
        text: stateFactText(state),
        sourceRefs: [raw.sourceRef],
        observedByPlayer: true,
        missingFields: [...state.sample.missing_fields],
        limitations: [CS2D_LIMITATIONS.frameSampling]
      });
    }
    facts.push({
      id: actionFactId,
      kind: "PLAYER_ACTION",
      roundNumber: raw.round.number,
      tick: raw.decisionTick,
      text: actionFactText(raw),
      sourceRefs: [raw.sourceRef],
      observedByPlayer: true,
      missingFields: raw.kind === "HP_CHANGE" ? ["HurtEvent", "exact_action_boundary"] : [],
      limitations: raw.kind === "HP_CHANGE" ? ["cs2d 没有逐次 HurtEvent；动作窗口由相邻 Frame 保守界定。"] : []
    });
    facts.push({
      id: outcomeFactId,
      kind: "OUTCOME",
      roundNumber: raw.round.number,
      tick: raw.revealTick,
      text: outcomeFactText(raw),
      sourceRefs: [raw.sourceRef],
      observedByPlayer: true,
      missingFields: [],
      limitations: raw.timingLimitation ? [raw.timingLimitation] : [],
      outcomeKind: raw.kind
    });
    let observableState: ObservableState | undefined;
    if (state) {
      const visionFact = directVisionFactFromSample(stateFactId, state.sample.player_id, {
        player_id: raw.state.sample.player_id,
        tick: state.sample.tick,
        world_position: state.sample.world_position
      });
      observableState = buildObservableState({
        id: `obs-${raw.sourceRef}`,
        demo_id: demoId,
        timeline_version: timeline.timeline_version,
        observer_player_id: selectedSteamId,
        at_tick: raw.decisionTick,
        observation_version: CS2D_OBSERVATION_VERSION,
        facts: [visionFact],
        limitations: [CS2D_LIMITATIONS.observationBoundary, CS2D_LIMITATIONS.frameSampling]
      });
      observations.push(observableState);
    }
    const economyRound = winProbabilityTimeline.rounds.find((round) => round.roundNumber === raw.round.number);
    const side = state?.sample.side ?? "T";
    const economy = side === "CT" ? economyRound?.economy.ct : economyRound?.economy.t;
    const context: CanonicalPlayerContext = {
      playerSide: side,
      ...(state ? {
        health: state.source.health,
        armor: state.source.armor,
        helmet: state.source.helmet,
        activeItemClass: classifyItem(safeText(state.source.weapon, "UNKNOWN_ITEM")) as CanonicalPlayerContext["activeItemClass"],
        money: state.source.money,
        equipmentValue: state.source.equipValue,
        utilityCount: state.source.grenades?.length,
        ...(stateCallout(state) ? { callout: stateCallout(state) } : {})
      } : {}),
      economyClass: economy ?? economyTerm(state)
    };
    signals.push({
      signalId: raw.sourceRef,
      kind: raw.kind,
      roundNumber: raw.round.number,
      sourceTick: raw.sourceTick,
      decisionTick: raw.decisionTick,
      revealTick: raw.revealTick,
      sourceRefs: [raw.sourceRef],
      factRefs: state ? [stateFactId] : [],
      actionRefs: [actionFactId],
      outcomeRefs: [outcomeFactId],
      observableClaimRefs: observableState?.claims.map((claim) => claim.id) ?? [],
      evidenceRefs: [raw.sourceRef],
      playerSide: side,
      playerContext: context,
      selectedPlayerDeath: raw.kind === "DEATH",
      utilityKind: raw.utilityKind,
      bombEventType: raw.bombEventType,
      annotations: worldAnnotation(raw.state, stateCallout(raw.state)),
      missingFields: [...(state?.sample.missing_fields ?? [])],
      limitations: uniqueStrings([CS2D_LIMITATIONS.observationBoundary, ...(raw.timingLimitation ? [raw.timingLimitation] : [])])
    });
  }
  return {
    demoId,
    playerId: selectedSteamId,
    timeline,
    facts,
    signals,
    observableStates: observations,
    winProbabilityTimeline,
    generationManifest: {
      timelineVersion: timeline.timeline_version,
      sceneIndexVersion: `${CS2D_ADAPTER_VERSION}/scene-index`,
      observationVersion: CS2D_OBSERVATION_VERSION,
      signalVersion: CS2D_SIGNAL_VERSION,
      candidateGeneratorVersion: "review-planner/candidate-generator/1.0.0"
    },
    limitations: warnings
  };
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

function unavailableWinProbabilityTimeline(tickRate: number, reason: string): WinProbabilityTimelineV1 {
  return {
    version: "win-probability-timeline.v1",
    status: "UNAVAILABLE",
    model: {
      provider: "CS_NET",
      revision: "csmodelv3-win-space-only-int8-2026-08-18",
      assetUrl: "/models/cs-net/win-rate.int8.onnx",
      assetSha256: "3916d0db3df65b8ff0406769e52f8e21f19911dc753b4fc497f5c88cdf371ef8",
      assetBytes: 10302780,
      quantization: "INT8",
      temperature: 1.0613423585891724,
      sourceCommit: "e15acc3fda3de21f25fe12a5ca31722381f40162",
      featureVersion: "cs-net-space-only-features/1.0.0"
    },
    tickRate,
    rounds: [],
    swings: [],
    limitations: ["Model unavailable; deterministic Director fallback remains active."],
    unavailableReason: reason.slice(0, 240)
  };
}

function failedBundle(input: Cs2dAnalysisInput, metadata: Cs2dAnalysisMetadata, timeline: MatchTimeline): Cs2dAnalysisBundle {
  const candidateSet = assembleCandidateSet({
    id: `candidate-set-${input.demoId}-${input.selectedSteamId}`,
    version: CS2D_SIGNAL_VERSION,
    demoId: input.demoId,
    playerId: input.selectedSteamId,
    candidates: [],
    materials: [],
    status: "FAILED",
    failureReason: "No canonical round/index could be generated.",
    generationManifest: {
      timelineVersion: timeline.timeline_version,
      sceneIndexVersion: `${CS2D_ADAPTER_VERSION}/scene-index`,
      observationVersion: CS2D_OBSERVATION_VERSION,
      signalVersion: CS2D_SIGNAL_VERSION,
      candidateGeneratorVersion: "review-planner/candidate-generator/1.0.0"
    },
    limitations: metadata.limitations
  });
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
      prompt_version: "cs2d-decision-template/1.2.0",
      status: "FALLBACK",
      narration_deterministic: true,
      analysis_subject_selection: "EXPLICIT_PLAYER",
      analysis_subject_player_id: input.selectedSteamId,
      limitations: [...metadata.limitations]
    }
  };
  return {
    demo_id: input.demoId,
    selected_steam_id: input.selectedSteamId,
    match_timeline: timeline,
    review_plan: failedPlan,
    candidate_set: candidateSet,
    observation_evidence: [],
    win_probability_timeline: input.winProbabilityTimeline ?? unavailableWinProbabilityTimeline(timeline.tick_rate, "Replay 没有收到模型结果。"),
    outcome_impacts: [],
    metadata
  };
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
  const winProbabilityTimeline = input.winProbabilityTimeline ?? unavailableWinProbabilityTimeline(tickRate, "模型尚未在 cs2d Worker 中完成推理。");
  const provisionalTimeline = buildTimeline(replay, rounds, input.selectedSteamId, states, warnings);
  const timeline: MatchTimeline = { ...provisionalTimeline, demo_id: input.demoId };
  const generatorInput = buildCanonicalGeneratorInput(candidates, timeline, input.demoId, input.selectedSteamId, tickRate, winProbabilityTimeline, warnings);
  const candidateSet = generateCandidateSet(generatorInput);
  const director = deterministicDirectorFallback(candidateSet, "DIRECTOR_DISABLED_PROVIDER_NEUTRAL_BASELINE");
  const compiled = compileReviewPlan({
    timeline,
    candidateSet,
    directorDecisionSet: director,
    planId: `plan-${input.demoId}-${input.selectedSteamId}`,
    observationVersion: CS2D_OBSERVATION_VERSION,
    signalVersion: CS2D_SIGNAL_VERSION,
    plannerVersion: CS2D_PLANNER_VERSION,
    parserVersion: `${CS2D_SOURCE.repository}@${CS2D_SOURCE.commit}`,
    promptVersion: "cs2d-decision-template/1.2.0",
    limitations
  });
  if (director.manifest.limitations.some((limitation) => limitation.includes("maximum 8"))) {
    issue(warnings, director.manifest.limitations.find((limitation) => limitation.includes("maximum 8"))!);
  }
  const plan = compiled.plan;
  const observationEvidence = generatorInput.observableStates ?? [];
  const metadata: Cs2dAnalysisMetadata = {
    ...metadataBase,
    canonical_tick_range: { start_tick: timeline.start_tick, end_tick: timeline.end_tick },
    limitations: uniqueStrings([...limitations, ...warnings, ...plan.generation_manifest.limitations ?? []]),
    warnings: [...warnings]
  };
  const outcomeImpacts = plan.cues
    .map((cue) => buildOutcomeImpactForCue(cue, candidateSet, winProbabilityTimeline, timeline, input.selectedSteamId))
    .filter((impact): impact is OutcomeImpact => Boolean(impact));
  return {
    demo_id: input.demoId,
    selected_steam_id: input.selectedSteamId,
    match_timeline: timeline,
    review_plan: plan,
    candidate_set: candidateSet,
    observation_evidence: observationEvidence,
    win_probability_timeline: winProbabilityTimeline,
    outcome_impacts: outcomeImpacts,
    metadata
  };
}

const BUNDLE_KEYS = [
  "demo_id",
  "selected_steam_id",
  "match_timeline",
  "review_plan",
  "candidate_set",
  "observation_evidence",
  "win_probability_timeline",
  "outcome_impacts",
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
  const candidateSet = value.candidate_set;
  const timeline = value.match_timeline;
  const metadata = value.metadata;
  if (
    typeof value.demo_id !== "string" || !value.demo_id.trim() ||
    typeof value.selected_steam_id !== "string" || !value.selected_steam_id.trim() ||
    !isRecord(plan) || !Array.isArray(plan.segments) || !Array.isArray(plan.cues) ||
    !isRecord(candidateSet) || !Array.isArray(candidateSet.candidates) || !Array.isArray(candidateSet.materials) ||
    !isRecord(timeline) || !Array.isArray(timeline.rounds) ||
    !Array.isArray(value.observation_evidence) || !isRecord(metadata)
    || !isRecord(value.win_probability_timeline) || !Array.isArray(value.outcome_impacts)
  ) {
    throw new Error("cs2d analysis bundle has an invalid structural shape.");
  }

  const bundle = value as unknown as Cs2dAnalysisBundle;
  if (
    bundle.demo_id !== bundle.match_timeline.demo_id ||
    bundle.demo_id !== bundle.review_plan.demo_id ||
    bundle.demo_id !== bundle.candidate_set.demoId ||
    bundle.selected_steam_id !== bundle.match_timeline.selected_player_id ||
    bundle.selected_steam_id !== bundle.review_plan.player_id ||
    bundle.selected_steam_id !== bundle.candidate_set.playerId
  ) {
    throw new Error("cs2d analysis bundle identifiers do not match.");
  }
  if (bundle.candidate_set.status !== "COMPLETE" && bundle.candidate_set.status !== "FAILED") throw new Error("CandidateSet status is invalid.");
  if (bundle.candidate_set.status === "FAILED" && (bundle.candidate_set.candidates.length > 0 || bundle.candidate_set.materials.length > 0 || !bundle.candidate_set.failureReason)) throw new Error("FAILED CandidateSet cannot expose partial candidates/materials.");
  const candidateSetIssues = collectCandidateSetIssues({
    id: bundle.candidate_set.id,
    version: bundle.candidate_set.version,
    demoId: bundle.candidate_set.demoId,
    playerId: bundle.candidate_set.playerId,
    status: bundle.candidate_set.status,
    failureReason: bundle.candidate_set.failureReason,
    generationManifest: bundle.candidate_set.generationManifest,
    candidates: bundle.candidate_set.candidates,
    materials: bundle.candidate_set.materials,
    limitations: bundle.candidate_set.limitations
  });
  if (candidateSetIssues.length > 0) throw new Error(`CandidateSet validation failed: ${candidateSetIssues.join(" ")}`);
  const candidateSetFingerprint = stableFingerprint({
    id: bundle.candidate_set.id,
    version: bundle.candidate_set.version,
    demoId: bundle.candidate_set.demoId,
    playerId: bundle.candidate_set.playerId,
    status: bundle.candidate_set.status,
    failureReason: bundle.candidate_set.failureReason,
    generationManifest: bundle.candidate_set.generationManifest,
    candidates: bundle.candidate_set.candidates,
    materials: bundle.candidate_set.materials,
    limitations: bundle.candidate_set.limitations
  });
  if (candidateSetFingerprint !== bundle.candidate_set.hash) throw new Error("CandidateSet hash does not match its immutable contents.");
  if (bundle.candidate_set.status === "COMPLETE" && bundle.review_plan.candidate_set_hash !== bundle.candidate_set.hash) throw new Error("ReviewPlan and CandidateSet hashes do not match.");
  if (/raw_replay|grenadePaths|frames/i.test(JSON.stringify(bundle.candidate_set))) throw new Error("CandidateSet contains raw Replay/frame fields.");
  if (
    bundle.win_probability_timeline.version !== "win-probability-timeline.v1" ||
    (bundle.win_probability_timeline.status !== "AVAILABLE" && bundle.win_probability_timeline.status !== "UNAVAILABLE") ||
    !Array.isArray(bundle.win_probability_timeline.rounds) ||
    !Array.isArray(bundle.win_probability_timeline.swings) ||
    bundle.outcome_impacts.some((impact) => !isRecord(impact) || typeof impact.cueId !== "string")
  ) {
    throw new Error("cs2d win-probability contract is invalid.");
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

  const materialByState = new Map(
    bundle.candidate_set.materials
      .filter((material) => material.observableStateId)
      .map((material) => [material.observableStateId!, material])
  );
  const candidateById = new Map(bundle.candidate_set.candidates.map((candidate) => [candidate.candidateId, candidate]));
  const stateById = new Map<string, ObservableState>();
  const seenObservationIds = new Set<string>();
  for (const state of bundle.observation_evidence) {
    assertValidObservableState(state);
    if (seenObservationIds.has(state.id)) {
      throw new Error(`ObservationState ${state.id} is duplicated.`);
    }
    seenObservationIds.add(state.id);
    const material = materialByState.get(state.id);
    const candidate = material ? candidateById.get(material.candidateId) : undefined;
    if (
      !material || !candidate ||
      state.demo_id !== bundle.demo_id ||
      state.timeline_version !== bundle.match_timeline.timeline_version ||
      state.observer_player_id !== bundle.selected_steam_id ||
      state.at_tick > candidate.decisionTick ||
      candidate.observableClaimRefs.some((claimId) => !state.claims.some((claim) => claim.id === claimId))
    ) {
      throw new Error(`ObservationState ${state.id} is not bound to its CandidateSet material.`);
    }
    stateById.set(state.id, state);
  }
  for (const material of bundle.candidate_set.materials) {
    if (material.observableStateId && !stateById.has(material.observableStateId)) throw new Error(`Candidate material observable_state_id ${material.observableStateId} is missing from observation_evidence.`);
  }
  for (const cue of bundle.review_plan.cues) {
    if (!cue.observable_state_id) continue;
    if (!cue.candidate_id) throw new Error(`Cue ${cue.id} has an ObservableState without candidate binding.`);
    const material = bundle.candidate_set.materials.find((item) => item.candidateId === cue.candidate_id);
    if (!material || material.observableStateId !== cue.observable_state_id || !stateById.has(cue.observable_state_id)) throw new Error(`Cue ${cue.id} references an ObservableState from another candidate.`);
    if (stateById.get(cue.observable_state_id)!.at_tick > cue.decision_tick) throw new Error(`Cue ${cue.id} references a future ObservableState.`);
  }
}

/** JSON boundary for workers/storage; no Replay or binary demo is serialized here. */
export function serializeCs2dAnalysisBundle(bundle: Cs2dAnalysisBundle): string {
  const whitelisted: Cs2dAnalysisBundle = {
    demo_id: bundle.demo_id,
    selected_steam_id: bundle.selected_steam_id,
    match_timeline: bundle.match_timeline,
    review_plan: bundle.review_plan,
    candidate_set: bundle.candidate_set,
    observation_evidence: bundle.observation_evidence,
    win_probability_timeline: bundle.win_probability_timeline,
    outcome_impacts: bundle.outcome_impacts,
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

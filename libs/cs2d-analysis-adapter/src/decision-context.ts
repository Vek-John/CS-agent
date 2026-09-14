import type { DecisionSnapshot, DecisionValue, DecisionCheck, ObservableDecisionContext, ObservableState } from "@cs-coach/contracts";
import { MAX_DECISION_SNAPSHOT_BYTES, MAX_DECISION_SNAPSHOT_PLAYERS } from "@cs-coach/contracts";
import type { Cs2dRound, Cs2dPlayerState } from "./index";
import { mirageChineseCallout } from "@cs-coach/map-semantics";

const numberOrNull = (value: unknown): number | null => typeof value === "number" && Number.isFinite(value) ? value : null;
const boolOrNull = (value: unknown): boolean | null => typeof value === "boolean" ? value : null;
const textOrNull = (value: unknown): string | null => typeof value === "string" && value.trim() ? value.trim().slice(0, 96) : null;
const sideOrNull = (value: unknown) => value === "T" || value === "CT" ? value : null;

/** Runs where Replay lives. Reads only one preceding frame, emits no enemy positions. */
export function buildDecisionSnapshot(input: {
  round: Cs2dRound; selectedPlayerId: string; decisionTick: number; tickRate: number;
  snapshotId: string; rosterIds: readonly string[];
}): DecisionSnapshot {
  const { round, selectedPlayerId, decisionTick, tickRate, snapshotId } = input;
  let frame: Cs2dRound["frames"][number] | undefined;
  for (const current of round.frames ?? []) {
    if (Number.isSafeInteger(current.tick) && current.tick <= decisionTick && current.tick >= round.freezeStartTick && (!frame || current.tick > frame.tick)) frame = current;
  }
  const fresh = Boolean(frame && decisionTick - frame.tick <= Math.ceil(tickRate / 2));
  const all = frame?.players ?? [];
  const selected = all.find((player) => player.steamId === selectedPlayerId);
  const side = sideOrNull(selected?.side);
  const sourceRefs = frame ? [`state-${round.number}-${frame.tick}`] : [];
  const complete = fresh && input.rosterIds.length === 10 && new Set(input.rosterIds).size === 10 && all.length === 10 && new Set(all.map((player) => player.steamId)).size === 10 && input.rosterIds.every((id) => all.some((player) => player.steamId === id && sideOrNull(player.side) && typeof player.alive === "boolean"));
  const value = <T>(data: T | null, boundary: DecisionValue<T>["boundary"], limitations: readonly string[] = []): DecisionValue<T> => ({ value: data, boundary, evidenceRefs: sourceRefs, limitations });
  const check = (code: string, status: DecisionCheck["status"], reason: string, missingFields: readonly string[] = [], boundary: DecisionCheck["boundary"] = "APPLICABILITY_ONLY"): DecisionCheck => ({ code, status, boundary, evidenceRefs: sourceRefs, missingFields, reason });
  const allies = side ? all.filter((player) => player.side === side && player.alive === true) : [];
  const teammates = allies.filter((player) => player.steamId !== selectedPlayerId);
  const noTeammates = complete && side !== null && teammates.length === 0;
  const missingFields = ["enemy_visibility", "observer_audibility", "team_communication", "trade_window", "safe_reachable_cover", "round_timer", "bomb_timer", "damage_source", "utility_purpose"];
  if (!complete) missingFields.push("complete_current_roster");
  if (!fresh) missingFields.push("fresh_player_state");
  if (!side) missingFields.push("current_side");
  for (const [key, item] of Object.entries({ health: selected?.health, armor: selected?.armor, money: selected?.money, equipmentValue: selected?.equipValue })) if (numberOrNull(item) === null) missingFields.push(key);
  if (!Array.isArray(selected?.grenades)) missingFields.push("inventory");
  if (typeof selected?.helmet !== "boolean") missingFields.push("helmet");
  if (typeof selected?.alive !== "boolean") missingFields.push("alive");
  if (!textOrNull(selected?.weapon)) missingFields.push("weapon");

  let bombState: NonNullable<DecisionSnapshot["bomb"]["value"]>["state"] = "UNKNOWN";
  let bombBoundary: DecisionSnapshot["bomb"]["boundary"] = "APPLICABILITY_ONLY";
  let carriedBySelectedPlayer: boolean | null = null;
  // Keyframe time is media-relative/rounded, not a canonical Demo tick. Require a full
  // 0.1 s uncertainty margin and never expose its hidden carrier or coordinates.
  const seconds = (decisionTick - round.freezeStartTick) / tickRate;
  let latestBomb: NonNullable<Cs2dRound["bomb"]>[number] | undefined;
  for (const bomb of round.bomb ?? []) if (Number.isFinite(bomb.t) && bomb.t + 0.1 <= seconds && (!latestBomb || bomb.t > latestBomb.t)) latestBomb = bomb;
  if (latestBomb) {
    bombState = latestBomb.state === "carried" ? "CARRIED" : latestBomb.state === "ground" ? "DROPPED" : latestBomb.state === "planted" ? "PLANTED" : "UNKNOWN";
    carriedBySelectedPlayer = latestBomb.state === "carried" && typeof latestBomb.carrierSteamId === "string" ? latestBomb.carrierSteamId === selectedPlayerId : null;
  }
  const bombEvents = (round.events ?? []).filter((event) => Number.isSafeInteger(event.tick) && event.tick <= decisionTick && event.tick >= round.freezeStartTick && event.type.startsWith("bomb_")).sort((a, b) => a.tick - b.tick);
  const bombEvent = bombEvents.at(-1);
  if (bombEvent) {
    bombState = bombEvent.type === "bomb_planted" ? "PLANTED" : bombEvent.type === "bomb_defused" ? "DEFUSED" : bombEvent.type === "bomb_exploded" ? "EXPLODED" : "UNKNOWN";
    bombBoundary = "OBSERVABLE";
    carriedBySelectedPlayer = false;
  } else if (fresh && selected && /^(c4|bomb)$/i.test(selected.weapon)) {
    bombState = "CARRIED"; carriedBySelectedPlayer = true; bombBoundary = "OBSERVABLE";
  }
  if (bombState === "UNKNOWN") missingFields.push("bomb_state");
  const flash = fresh && Array.isArray(selected?.grenades) ? selected.grenades.some((name) => /flash/i.test(name)) : null;
  const canCompareHealth = complete && numberOrNull(selected?.health) !== null && teammates.every((player) => numberOrNull(player.health) !== null);
  const noHigherHealth = canCompareHealth && !teammates.some((player) => player.health > selected!.health);
  const supportChecks: DecisionCheck[] = [
    check("teammateAlive", noTeammates ? "INAPPLICABLE" : complete && side ? "APPLICABLE" : "UNVERIFIABLE", noTeammates ? "当时没有存活队友。" : complete && side ? "当时仍有存活队友。" : "无法确认完整的存活名单。", complete ? [] : ["complete_current_roster"], "OBSERVABLE"),
    check("higherHealthTeammate", noHigherHealth || noTeammates ? "INAPPLICABLE" : "UNVERIFIABLE", noHigherHealth || noTeammates ? "当时没有血量更高的存活队友。" : "有队友并不足以证明其能够先接触。", noHigherHealth || noTeammates ? [] : ["observable_teammate_health", "teammate_contact_timing"]),
    check("tradeWindow", noTeammates ? "INAPPLICABLE" : "UNVERIFIABLE", noTeammates ? "没有存活队友可以形成补枪。" : "尚不能验证双方的交火方向和补枪时机。", noTeammates ? [] : ["trade_window", "line_of_sight", "teammate_contact_timing"]),
    check("flashAvailable", flash === null ? "UNVERIFIABLE" : flash ? "APPLICABLE" : "INAPPLICABLE", flash === null ? "无法确认你携带的道具。" : flash ? "你当时携带闪光弹。" : "你当时没有闪光弹。", flash === null ? ["inventory"] : [], "OBSERVABLE"),
    check("flashPurpose", "UNVERIFIABLE", "尚不能验证闪光的作用位置和时机。", ["utility_purpose"])
  ];
  const snapshot: DecisionSnapshot = {
    version: "decision-snapshot.v1", snapshotId, roundNumber: round.number, selectedPlayerId, decisionTick, sampledAtTick: frame?.tick ?? null,
    selectedPlayer: value(fresh && selected ? { side, alive: boolOrNull(selected.alive), health: numberOrNull(selected.health), armor: numberOrNull(selected.armor), helmet: boolOrNull(selected.helmet), weapon: textOrNull(selected.weapon), grenades: Array.isArray(selected.grenades) ? selected.grenades.slice(0, 8).map((name) => textOrNull(name) ?? "未知道具") : null, money: numberOrNull(selected.money), equipmentValue: numberOrNull(selected.equipValue), hasDefuseKit: boolOrNull(selected.defuser), callout: mirageChineseCallout(selected.lastPlaceName) ?? null } : null, "OBSERVABLE", fresh ? [] : ["决策前缺少足够新的玩家状态。"]),
    aliveCounts: value(complete && side ? { allies: allies.length, enemies: all.filter((player) => player.side !== side && player.alive === true).length, includesSelectedPlayer: true } : null, "OBSERVABLE"),
    players: all.slice(0, MAX_DECISION_SNAPSHOT_PLAYERS).map((player: Cs2dPlayerState) => ({ playerId: player.steamId, side: sideOrNull(player.side), alive: boolOrNull(player.alive), health: numberOrNull(player.health), boundary: "APPLICABILITY_ONLY" })),
    score: value(numberOrNull(round.scoreT) !== null && numberOrNull(round.scoreCt) !== null ? { t: round.scoreT, ct: round.scoreCt } : null, "OBSERVABLE"),
    clock: value({ phase: decisionTick < round.startTick ? "FREEZE" : decisionTick >= round.decidedTick ? "POST_ROUND" : "LIVE", elapsedSeconds: Number.isSafeInteger(round.startTick) ? Math.max(0, (decisionTick - round.startTick) / tickRate) : null, remainingSeconds: null }, "OBSERVABLE", ["回放未提供可靠的剩余回合时间，不能用最终回合长度反推。"]),
    bomb: { ...value({ state: bombState, carriedBySelectedPlayer, remainingSeconds: null }, bombBoundary, ["回放未提供可靠的 C4 倒计时。"]), evidenceRefs: bombEvent ? [`cs2d-r${round.number}-event-${round.events.indexOf(bombEvent) + 1}`] : sourceRefs },
    supportChecks,
    pressureChecks: [check("objectiveAllowsDelay", "UNVERIFIABLE", "缺少可靠的剩余时间，无法确认等待是否可行。", ["round_timer", "bomb_timer"])],
    spatialChecks: [check("safeReachableCover", "UNVERIFIABLE", "尚不能验证可到达的安全掩体。", ["safe_reachable_cover"]), check("knownAlternateRoute", "UNVERIFIABLE", "尚不能验证玩家已知的可行替代路线。", ["observable_alternate_route"])],
    missingFields,
    limitations: ["存活名单来自当前阵营；队友存在不等于能够协同。", "全图状态只用于否决建议，不能当成玩家知道的敌情。", "伤害来源、视野、声音和安全空间尚不能可靠还原。"]
  };
  assertDecisionSnapshot(snapshot);
  return snapshot;
}

export function buildObservableDecisionContext(snapshot: DecisionSnapshot, state: ObservableState): ObservableDecisionContext {
  const claims = state.claims.filter((claim) => claim.evidence_tick <= snapshot.decisionTick && claim.available_from_tick <= snapshot.decisionTick && (claim.expires_at_tick === undefined || snapshot.decisionTick < claim.expires_at_tick));
  const publicFacts: string[] = [];
  const self = snapshot.selectedPlayer.value;
  if (self) publicFacts.push(`你的血量${self.health === null ? "未知" : `为 ${self.health}`}，护甲${self.armor === null ? "未知" : `为 ${self.armor}`}，手持${self.weapon ?? "未知"}。`);
  if (snapshot.aliveCounts.value) publicFacts.push(`当时己方 ${snapshot.aliveCounts.value.allies} 人存活${self?.alive ? "（包括你）" : ""}，对方 ${snapshot.aliveCounts.value.enemies} 人存活。`);
  if (snapshot.score.value) publicFacts.push(`当时比分：进攻方 ${snapshot.score.value.t}，防守方 ${snapshot.score.value.ct}。`);
  const bombNames = { NOT_CARRIED: "未携带", CARRIED: "携带中", DROPPED: "掉落", PLANTED: "已安放", DEFUSED: "已拆除", EXPLODED: "已爆炸", UNKNOWN: "未知" };
  if (snapshot.bomb.boundary === "OBSERVABLE" && snapshot.bomb.value) publicFacts.push(`C4 状态：${bombNames[snapshot.bomb.value.state]}。`);
  return { version: "observable-decision-context.v1", boundary: "OBSERVABLE", state: JSON.parse(JSON.stringify({ ...state, claims })) as ObservableState, snapshotId: snapshot.snapshotId, source: "DEMO_OBSERVER_EVIDENCE", publicFacts, freshness: { sampledAtTick: snapshot.sampledAtTick, ageTicks: snapshot.sampledAtTick === null ? null : snapshot.decisionTick - snapshot.sampledAtTick }, confidence: snapshot.selectedPlayer.value ? 0.75 : 0, missingFields: snapshot.missingFields, limitations: snapshot.limitations };
}

export function assertDecisionSnapshot(snapshot: DecisionSnapshot): void {
  assertDecisionContextShape(snapshot);
  if (new TextEncoder().encode(JSON.stringify(snapshot)).byteLength > MAX_DECISION_SNAPSHOT_BYTES) throw new Error("DecisionSnapshot exceeds 16 KiB.");
  if (snapshot.version !== "decision-snapshot.v1" || !Number.isSafeInteger(snapshot.decisionTick) || (snapshot.sampledAtTick !== null && (!Number.isSafeInteger(snapshot.sampledAtTick) || snapshot.sampledAtTick > snapshot.decisionTick))) throw new Error("DecisionSnapshot has a future or invalid sample.");
  if (!Array.isArray(snapshot.players) || snapshot.players.length > MAX_DECISION_SNAPSHOT_PLAYERS || snapshot.players.some((player) => player.boundary !== "APPLICABILITY_ONLY" || Object.keys(player).some((key) => !["playerId", "side", "alive", "health", "boundary"].includes(key)))) throw new Error("DecisionSnapshot player boundary is invalid.");
  for (const field of [snapshot.selectedPlayer, snapshot.aliveCounts, snapshot.score, snapshot.clock, snapshot.bomb]) {
    if (!field || !["OBSERVABLE", "APPLICABILITY_ONLY"].includes(field.boundary)) throw new Error("DecisionSnapshot information boundary is invalid.");
  }
  if ([snapshot.selectedPlayer, snapshot.aliveCounts, snapshot.score, snapshot.clock].some((field) => field.boundary !== "OBSERVABLE")) throw new Error("DecisionSnapshot public information boundary is invalid.");
  for (const check of [...snapshot.supportChecks, ...snapshot.pressureChecks, ...snapshot.spatialChecks]) {
    if (!["APPLICABLE", "INAPPLICABLE", "UNVERIFIABLE"].includes(check.status) || !["OBSERVABLE", "APPLICABILITY_ONLY"].includes(check.boundary) || (check.status === "APPLICABLE" && check.boundary !== "OBSERVABLE")) throw new Error("DecisionSnapshot full-world check cannot approve advice.");
  }
}

function exactKeys(value: unknown, keys: readonly string[], label: string): asserts value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).length !== keys.length || Object.keys(value).some((key) => !keys.includes(key))) throw new Error(`${label} has undocumented fields or invalid structure.`);
}

/** Validate nested information boundaries before accepting a persisted or worker packet. */
export function assertDecisionContextShape(snapshot: DecisionSnapshot): void {
  exactKeys(snapshot, ["version", "snapshotId", "roundNumber", "selectedPlayerId", "decisionTick", "sampledAtTick", "selectedPlayer", "aliveCounts", "players", "score", "clock", "bomb", "supportChecks", "pressureChecks", "spatialChecks", "missingFields", "limitations"], "DecisionSnapshot");
  if (typeof snapshot.snapshotId !== "string" || typeof snapshot.selectedPlayerId !== "string" || !Number.isSafeInteger(snapshot.roundNumber)) throw new Error("DecisionSnapshot identity is invalid.");
  const values: [DecisionValue<unknown>, readonly string[]][] = [
    [snapshot.selectedPlayer, ["side", "alive", "health", "armor", "helmet", "weapon", "grenades", "money", "equipmentValue", "hasDefuseKit", "callout"]],
    [snapshot.aliveCounts, ["allies", "enemies", "includesSelectedPlayer"]],
    [snapshot.score, ["t", "ct"]],
    [snapshot.clock, ["phase", "elapsedSeconds", "remainingSeconds"]],
    [snapshot.bomb, ["state", "carriedBySelectedPlayer", "remainingSeconds"]]
  ];
  for (const [field, keys] of values) {
    exactKeys(field, ["value", "boundary", "evidenceRefs", "limitations"], "DecisionValue");
    if (field.value !== null) exactKeys(field.value, keys, "DecisionValue payload");
    assertStrings(field.evidenceRefs); assertStrings(field.limitations);
  }
  const selected = snapshot.selectedPlayer.value;
  if (selected) {
    if (selected.side !== null && selected.side !== "T" && selected.side !== "CT") throw new Error("DecisionSnapshot side is invalid.");
    for (const value of [selected.health, selected.armor, selected.money, selected.equipmentValue]) if (value !== null && (numberOrNull(value) === null || value < 0)) throw new Error("DecisionSnapshot resource is invalid.");
    for (const value of [selected.alive, selected.helmet, selected.hasDefuseKit]) if (value !== null && typeof value !== "boolean") throw new Error("DecisionSnapshot player state is invalid.");
    for (const value of [selected.weapon, selected.callout]) if (value !== null && typeof value !== "string") throw new Error("DecisionSnapshot text is invalid.");
    if (selected.grenades !== null) assertStrings(selected.grenades);
  }
  const alive = snapshot.aliveCounts.value;
  if (alive && (alive.includesSelectedPlayer !== true || ![alive.allies, alive.enemies].every((count) => Number.isInteger(count) && count >= 0 && count <= 5))) throw new Error("DecisionSnapshot alive counts are invalid.");
  for (const player of snapshot.players) {
    exactKeys(player, ["playerId", "side", "alive", "health", "boundary"], "Decision player");
    if (typeof player.playerId !== "string" || (player.side !== null && player.side !== "T" && player.side !== "CT") || (player.alive !== null && typeof player.alive !== "boolean") || (player.health !== null && numberOrNull(player.health) === null)) throw new Error("DecisionSnapshot player summary is invalid.");
  }
  for (const list of [snapshot.supportChecks, snapshot.pressureChecks, snapshot.spatialChecks]) {
    if (!Array.isArray(list)) throw new Error("DecisionSnapshot checks are invalid.");
    for (const check of list) {
      exactKeys(check, ["code", "status", "boundary", "evidenceRefs", "missingFields", "reason"], "DecisionCheck");
      if (typeof check.code !== "string" || typeof check.reason !== "string") throw new Error("DecisionCheck text is invalid.");
      assertStrings(check.evidenceRefs); assertStrings(check.missingFields);
    }
  }
  assertStrings(snapshot.missingFields); assertStrings(snapshot.limitations);
}
function assertStrings(value: unknown): asserts value is readonly string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) throw new Error("Decision context string list is invalid.");
}

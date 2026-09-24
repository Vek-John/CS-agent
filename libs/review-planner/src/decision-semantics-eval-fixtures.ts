import type { ObservationClaim } from "../../contracts/src/observation";
import { DECISION_ASSESSMENT_VERSIONS as V, type DecisionAssessmentPacket, type DecisionAssessmentResult } from "../../contracts/src/decision-assessment";
import { buildDecisionObservationSemantics } from "./decision-observation";

export interface DecisionSemanticsEvalCase {
  id: string; group: string; split: "development" | "holdout";
  provenance: "AGENT_AUTHORED_PROXY"; timeBasis: "SYNTHETIC_RELATIVE_TIME";
  description: string; packet: DecisionAssessmentPacket; legacyPacket: DecisionAssessmentPacket;
  acceptable: {
    risk: readonly DecisionAssessmentResult["riskWarranted"]["choice"][];
    alternative: readonly DecisionAssessmentResult["alternativePreferable"]["choice"][];
    sufficiency: readonly DecisionAssessmentResult["contextSufficient"]["choice"][];
  };
}
export const DECISION_SEMANTICS_DATASET_VERSION = "decision-semantics-proxy.v1";
// Synthetic internal time units for the source builder, never canonical Demo ticks.
const decisionTick = 640, tickRate = 64, playerId = "synthetic-self";
type Check = DecisionAssessmentPacket["state"]["checks"][number]["value"];
function self(): ObservationClaim {
  return { id: "self-source", claim_type: "PLAYER_POSITION", knowledge_kind: "OBSERVED", source_type: "DIRECT_VISION", subject_ref: playerId,
    subject_resolution: "EXACT_PLAYER", evidence_tick: decisionTick, available_from_tick: decisionTick,
    spatial_estimate: { type: "EXACT_POINT", point: { x: 0, y: 0, z: 0 } }, confidence: 1,
    sharing_scope: "SELF", evidence_refs: ["synthetic-self-state"], derived_by: "AGENT_AUTHORED_PROXY", limitations: [] };
}
function visible(x = 240, y = 80): ObservationClaim {
  return { ...self(), id: "visible-source", subject_ref: "synthetic-other", confidence: 0.95,
    spatial_estimate: { type: "EXACT_POINT", point: { x, y, z: 0 } }, evidence_refs: ["synthetic-observer-vision"] };
}
function historical(): ObservationClaim {
  return { ...visible(), id: "historical-source", claim_type: "LAST_KNOWN_POSITION", knowledge_kind: "INFERRED", source_type: "LAST_KNOWN",
    evidence_tick: decisionTick - 128, available_from_tick: decisionTick - 128, confidence: 0.65,
    spatial_estimate: { type: "LAST_KNOWN_POINT", point: { x: 240, y: 80, z: 0 }, radius: 120, age_ticks: 128 } };
}
function sound(): ObservationClaim {
  return { ...self(), id: "sound-source", claim_type: "SOUND_SOURCE", knowledge_kind: "INFERRED", source_type: "GUNSHOT", subject_ref: undefined,
    subject_resolution: "UNKNOWN_ACTOR", confidence: 0.6, evidence_tick: decisionTick - 16, available_from_tick: decisionTick - 16,
    evidence_refs: ["synthetic-audibility"], audibility_assessment: { result: "POSSIBLY_AUDIBLE", assessed_by: "synthetic-gate", evidence_refs: ["synthetic-audibility"], limitations: [] },
    spatial_estimate: { type: "DIRECTION_SECTOR", origin: { x: 0, y: 0, z: 0 }, bearing_degrees: 0, width_degrees: 100, max_distance: 1200 } };
}
function userContradiction(): ObservationClaim {
  return { ...self(), id: "user-source", claim_type: "USER_CONTEXT", knowledge_kind: "USER_ASSERTED", source_type: "USER_CONTEXT", subject_ref: undefined,
    subject_resolution: "TEAM_ONLY", confidence: 0.55, sharing_scope: "USER_CONTEXT_ONLY", spatial_estimate: { type: "NONE" },
    user_tactical_context: { version: "user-tactical-context.v1", enemyArea: "A_SITE", enemyCount: 4, plan: "TRADE" } };
}

function build(checks: readonly [Check, Check, Check], claims: readonly ObservationClaim[], options: { returnFire?: boolean; allies?: number; duration?: number } = {}): DecisionAssessmentPacket {
  const codes = ["objectiveAllowsDelay", "tradeWindow", "safeReachableCover"] as const;
  const semantics = buildDecisionObservationSemantics(claims, { playerId, decisionTick, tickRate });
  const observations: DecisionAssessmentPacket["state"]["observations"] = claims.map((claim, i) => ({ alias: `e${6 + i}`, kind: claim.claim_type,
    source: claim.source_type === "USER_CONTEXT" ? "USER_PROVIDED" : "DEMO_OBSERVER", confidence: claim.confidence,
    ageSeconds: (decisionTick - claim.evidence_tick) / tickRate, shared: claim.sharing_scope === "VERIFIED_TEAM_SHARED",
    ...(claim.user_tactical_context ? { reportedContext: claim.user_tactical_context } : {}), semantic: semantics[i]! }));
  return { projectionVersion: V.projectionWithObservationSemantics, questionVersion: V.questionsWithWitnesses,
    scenario: options.returnFire ? "RETURN_AND_FIRE_AFTER_ADVANTAGE" : "RECONTACT_AFTER_ADVANTAGE", map: "de_mirage",
    state: { allies: options.allies ?? 3, enemies: 2, advantage: (options.allies ?? 3) - 2,
      checks: codes.map((code, i) => ({ code, value: checks[i]!, refs: checks[i] === "UNKNOWN" ? [] : [`e${3 + i}`] })), observations },
    action: options.returnFire ? { kind: "RETURN_AND_FIRE", durationSeconds: options.duration ?? 0.75, sincePriorShotSeconds: 2, contactStatus: "UNVERIFIED", refs: ["e2"] }
      : { kind: "RECONTACT", durationSeconds: options.duration ?? 0.75, sincePriorContactSeconds: 2, refs: ["e2"] },
    evidence: [{ alias: "e1", role: "PUBLIC_COUNTS", confidence: 1 }, { alias: "e2", role: "ACTION", confidence: 1 },
      ...codes.flatMap((code, i) => checks[i] === "UNKNOWN" ? [] : [{ alias: `e${3 + i}`, role: code, confidence: 0.95 }]),
      ...observations.map(o => ({ alias: o.alias, role: "OBSERVATION" as const, confidence: o.confidence }))] };
}

/** Deliberate information-loss comparator: only the new semantic projection is removed.
 * No label, rule answer, identity, raw time, source prose, or outcome enters either packet. */
export function legacyDecisionSemanticsPacket(packet: DecisionAssessmentPacket): DecisionAssessmentPacket {
  const observations = packet.state.observations.map(({ semantic: _removed, ...observation }) => observation);
  const returning = packet.action.kind === "RETURN_AND_FIRE";
  return { ...packet, projectionVersion: returning ? V.projectionWithReturnAndFire : observations.some(o => o.reportedContext) ? V.projectionWithUserContext : V.projection,
    questionVersion: returning ? V.questionsReturnAndFire : V.questions, state: { ...packet.state, observations } };
}

function entry(id: string, group: string, split: DecisionSemanticsEvalCase["split"], description: string, packet: DecisionAssessmentPacket, acceptable: DecisionSemanticsEvalCase["acceptable"]): DecisionSemanticsEvalCase {
  return { id, group, split, description, packet, legacyPacket: legacyDecisionSemanticsPacket(packet), acceptable,
    provenance: "AGENT_AUTHORED_PROXY", timeBasis: "SYNTHETIC_RELATIVE_TIME" };
}
const positive = { risk: ["WARRANTED"], alternative: ["NOT_ESTABLISHED"], sufficiency: ["SUFFICIENT"] } as const;
const negative = { risk: ["UNWARRANTED"], alternative: ["PREFERABLE"], sufficiency: ["SUFFICIENT"] } as const;
const uncertain = { risk: ["UNKNOWN"], alternative: ["UNKNOWN", "NOT_ESTABLISHED"], sufficiency: ["INSUFFICIENT"] } as const;

/** Frozen before first model invocation. Development cases reuse previously explored
 * tactical archetypes and MUST NOT be represented as unseen test data. The six new
 * holdout groups are a pre-call proxy test only, not a blinded coach-labeled holdout. */
export const decisionSemanticsEvalCases: readonly DecisionSemanticsEvalCase[] = [
  entry("dev-avoidable-contact", "dev-avoidable", "development", "Known delay and cover, explicitly absent trade window, current observed subject; author expects avoiding the recontact.", build(["YES", "NO", "YES"], [self(), visible()]), negative),
  entry("dev-supported-trade", "dev-trade", "development", "Verified trade window and current observation support active contact without a unique superior alternative.", build(["YES", "YES", "YES"], [self(), visible(320, -80)]), positive),
  entry("dev-unverified-return", "dev-return", "development", "Own return and fire does not establish contact or enemy visibility; stronger claims remain forbidden.", build(["UNKNOWN", "UNKNOWN", "UNKNOWN"], [self()], { returnFire: true }), { ...uncertain, alternative: ["UNKNOWN"] }),
  entry("test-urgent-objective", "test-urgency", "holdout", "Objective forbids delay despite no trade window; missing trade does not alone make the action wrong.", build(["NO", "NO", "YES"], [self(), visible(-180, 140)], { allies: 4, duration: 1.1 }), positive),
  entry("test-multiple-supported-options", "test-options", "holdout", "Delay and trade are both verified; active contact and coordination may both be reasonable, no superior option is proved.", build(["YES", "YES", "NO"], [self(), visible(420, 90)], { allies: 4, duration: 0.5 }), positive),
  entry("test-cover-unreachable", "test-cover", "holdout", "Known lack of trade and safe reachable cover does not prove an available preferable alternative or a forced choice.", build(["YES", "NO", "NO"], [self(), visible(-350, -90)], { duration: 1.25 }), uncertain),
  entry("test-user-count-conflict", "test-user-conflict", "holdout", "User claims four enemies while public counts show two; provenance and contradiction prevent confident sufficiency.", build(["UNKNOWN", "UNKNOWN", "UNKNOWN"], [self(), userContradiction()], { allies: 4, duration: 0.6 }), uncertain),
  entry("test-current-vision-avoidable", "test-current-vision", "holdout", "Independent current observation and verified delay/no-trade/cover support an avoidable-contact judgment within this unvalidated rubric.", build(["YES", "NO", "YES"], [self(), visible(680, -210)], { allies: 4, duration: 1.5 }), negative),
  entry("test-history-and-sound", "test-indirect-information", "holdout", "A historical uncertain region and inferred unknown-actor sound are not upgraded into current exact enemy visibility or trade evidence.", build(["UNKNOWN", "UNKNOWN", "UNKNOWN"], [self(), historical(), sound()], { duration: 0.9 }), uncertain),
];

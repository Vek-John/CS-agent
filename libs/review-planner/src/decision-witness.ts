import type { DecisionAssessmentPacket, DecisionAssessmentResult, DecisionAssessmentCheckCode } from "@cs-coach/contracts";

export const DECISION_WITNESS_ATOMS = ["riskWarranted", "alternativePreferable", "contextSufficient"] as const;
export type DecisionWitnessAtomName = typeof DECISION_WITNESS_ATOMS[number];
export interface DecisionWitnessOption {
  choice: string;
  refs: string[];
  description: string;
  /** Local validation only. Do not serialize this flag as a suggested answer. */
  applicable: boolean;
}
export type DecisionWitnessCatalog = Record<DecisionWitnessAtomName, Record<string, DecisionWitnessOption>>;
const CHECKS: readonly DecisionAssessmentCheckCode[] = ["objectiveAllowsDelay", "tradeWindow", "safeReachableCover"];
const unique = (refs: readonly string[]) => [...new Set(refs)];

/** Fixed argument patterns, not a baseline verdict. Every option remains in the catalog.
 * A bundle contributes premises jointly: a public count need not prove a tactical conclusion alone. */
export function buildDecisionWitnessCatalog(packet: DecisionAssessmentPacket): DecisionWitnessCatalog {
  const check = (code: DecisionAssessmentCheckCode) => packet.state.checks.find(c => c.code === code);
  const checkRefs = (...codes: DecisionAssessmentCheckCode[]) => unique(codes.flatMap(c => check(c)?.refs ?? []));
  const checkIs = (code: DecisionAssessmentCheckCode, value: "YES" | "NO") => check(code)?.value === value && !!check(code)?.refs.length;
  const roleRefs = (role: "PUBLIC_COUNTS" | "ACTION") => packet.evidence.filter(e => e.role === role).map(e => e.alias);
  const actionAndCounts = [...roleRefs("PUBLIC_COUNTS"), ...roleRefs("ACTION")];
  const contactVerified = packet.action.kind !== "RETURN_AND_FIRE";
  const delay = checkIs("objectiveAllowsDelay", "YES"), trade = checkIs("tradeWindow", "YES"), cover = checkIs("safeReachableCover", "YES");
  const option = (choice: string, refs: readonly string[], description: string, applicable: boolean): DecisionWitnessOption => ({ choice, refs: unique(refs), description, applicable });
  const stateDescription = CHECKS.map(code => `${code}=${check(code)?.value ?? "UNKNOWN"}`).join(", ");
  const relevantUnknown = CHECKS.some(code => check(code)?.value === "UNKNOWN");
  const userUncertainty = packet.state.observations.some(o => o.source === "USER_PROVIDED");
  return {
    riskWarranted: {
      TRADE_SUPPORT: option("WARRANTED", [...actionAndCounts, ...checkRefs("tradeWindow")], `The counts, actual action, and trade timing together justify this recontact as supported trading; tradeWindow must be YES. Current checked facts: ${stateDescription}.`, contactVerified && trade),
      OBJECTIVE_URGENCY: option("WARRANTED", [...actionAndCounts, ...checkRefs("objectiveAllowsDelay")], `The counts, actual action, and objective timing together justify acting without delay; objectiveAllowsDelay must be NO. Current checked facts: ${stateDescription}.`, contactVerified && checkIs("objectiveAllowsDelay", "NO")),
      AVOIDABLE_RECONTACT: option("UNWARRANTED", [...actionAndCounts, ...checkRefs(...CHECKS)], `The counts, actual action, available delay, absent trade window and safe reachable cover jointly support avoiding this recontact; require delay YES, trade NO, cover YES. Mere missing trade evidence is not trade NO. Current checked facts: ${stateDescription}.`, contactVerified && delay && checkIs("tradeWindow", "NO") && cover),
      NONE: option("UNKNOWN", [], "No offered joint argument supports either tactical judgment. Do not manufacture contact from a position return and shot, or infer a mistake from missing information.", true)
    },
    alternativePreferable: {
      COVER_WITH_DELAY: option("PREFERABLE", checkRefs("objectiveAllowsDelay", "safeReachableCover"), `Available delay and known reachable safe cover jointly support cover as preferable to the actual action, if that comparative judgment is justified; applicability alone does not prove superiority. Current checked facts: ${stateDescription}.`, contactVerified && delay && cover),
      TRADE_WITH_DELAY: option("PREFERABLE", checkRefs("objectiveAllowsDelay", "tradeWindow"), `Available delay and a verified trade window jointly support coordinating a trade as preferable to the actual action, if that comparative judgment is justified. Current checked facts: ${stateDescription}.`, contactVerified && delay && trade),
      MULTIPLE_SUPPORTED_OPTIONS: option("NOT_ESTABLISHED", checkRefs("objectiveAllowsDelay", "tradeWindow"), `Verified available delay and trade timing support multiple reasonable actions without establishing a superior alternative. This is affirmative support for alternatives, not merely missing data. Current checked facts: ${stateDescription}.`, contactVerified && delay && trade),
      NO_APPLICABLE_ALTERNATIVE: option("NOT_ESTABLISHED", checkRefs("objectiveAllowsDelay"), `Reliable objective timing does not allow delay, so the supplied delay-dependent alternatives are not established as preferable. This does not prove that the player has no other possible action. Current checked facts: ${stateDescription}.`, contactVerified && checkIs("objectiveAllowsDelay", "NO")),
      NONE: option("UNKNOWN", [], "No offered joint argument establishes either a preferable alternative or multiple supported options; information is insufficient to compare.", true)
    },
    contextSufficient: {
      COMPLETE: option("SUFFICIENT", checkRefs(...CHECKS), `All three relevant applicability checks are known and jointly provide enough context for this bounded rubric; do not require unrelated details. Still reject sufficiency when a specific unresolved conflict could change this judgment. Current checked facts: ${stateDescription}.`, contactVerified && !relevantUnknown && CHECKS.every(code => !!check(code)?.refs.length)),
      MISSING_TIMING: option("INSUFFICIENT", [], "Objective timing is UNKNOWN and this missing timing can change the judgment.", check("objectiveAllowsDelay")?.value === "UNKNOWN"),
      MISSING_TRADE: option("INSUFFICIENT", [], "Trade support is UNKNOWN and this missing support can change the judgment.", check("tradeWindow")?.value === "UNKNOWN"),
      MISSING_COVER: option("INSUFFICIENT", [], "Reachable safe cover is UNKNOWN and this missing alternative can change the judgment.", check("safeReachableCover")?.value === "UNKNOWN"),
      UNVERIFIED_CONTACT: option("INSUFFICIENT", [], "The actual action is RETURN_AND_FIRE with UNVERIFIED contact; self movement and attributed fire do not establish enemy exposure, visibility, cover or a re-peek.", !contactVerified),
      USER_UNCERTAINTY: option("INSUFFICIENT", [], "A user-provided assertion remains uncertain and could change this judgment; it is not a Demo fact.", userUncertainty),
      UNRESOLVED_CONTEXT: option("INSUFFICIENT", [], "A material tactical uncertainty or conflict remains despite the available facts; the offered premises do not justify a confident joint assessment.", true)
    }
  };
}

const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const probability = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 1;
/** Validate the model's explicit support selection. Never fill missing witnesses or change its verdict. */
export function validateDecisionWitnesses(packet: DecisionAssessmentPacket, result: DecisionAssessmentResult | unknown): string[] {
  const reasons: string[] = [];
  if (!record(result) || !record(result.witnesses) || Object.keys(result.witnesses).length !== DECISION_WITNESS_ATOMS.length || Object.keys(result.witnesses).some(k => !DECISION_WITNESS_ATOMS.includes(k as DecisionWitnessAtomName))) return ["INVALID_WITNESS_SCHEMA"];
  const catalog = buildDecisionWitnessCatalog(packet);
  for (const name of DECISION_WITNESS_ATOMS) {
    const witness = result.witnesses[name], main = result[name];
    if (!record(witness) || Object.keys(witness).length !== 3 || Object.keys(witness).some(k => !["choice", "confidence", "probabilities"].includes(k)) || typeof witness.choice !== "string" || !Object.hasOwn(catalog[name], witness.choice) || !probability(witness.confidence) || !record(witness.probabilities)) { reasons.push("INVALID_WITNESS_SCHEMA"); continue; }
    const expected = Object.keys(catalog[name]), probabilities = witness.probabilities;
    if (Object.keys(probabilities).length !== expected.length || expected.some(k => !probability(probabilities[k])) || Math.abs(Object.values(probabilities).reduce<number>((sum, p) => sum + (typeof p === "number" ? p : 0), 0) - 1) > 0.0001 || Object.values(probabilities).some(p => typeof p === "number" && p > (probabilities[witness.choice as string] as number))) reasons.push("INVALID_WITNESS_PROBABILITIES");
    const selected = catalog[name][witness.choice]!;
    if (!selected.applicable) reasons.push("INAPPLICABLE_WITNESS");
    if (!record(main) || main.choice !== selected.choice) reasons.push("WITNESS_LABEL_MISMATCH");
    if (!record(main) || JSON.stringify(main.refs) !== JSON.stringify(selected.refs)) reasons.push("WITNESS_REFS_MISMATCH");
  }
  const risk = record(result.riskWarranted) ? result.riskWarranted.choice : undefined;
  const alternative = record(result.alternativePreferable) ? result.alternativePreferable.choice : undefined;
  const context = record(result.contextSufficient) ? result.contextSufficient.choice : undefined;
  // A supported risk statement can coexist with insufficient wider context; its consumer must still abstain.
  if (context === "SUFFICIENT" && (risk === "UNKNOWN" || alternative === "UNKNOWN")) reasons.push("INCONSISTENT_ATOMIC_JUDGMENTS");
  if (packet.action.kind === "RETURN_AND_FIRE" && (risk !== "UNKNOWN" || alternative !== "UNKNOWN" || context !== "INSUFFICIENT" || (result.witnesses.contextSufficient as Record<string, unknown> | undefined)?.choice !== "UNVERIFIED_CONTACT")) reasons.push("CONTACT_UNVERIFIED");
  return unique(reasons);
}

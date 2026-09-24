import { DECISION_ASSESSMENT_VERSIONS, type DecisionAssessmentPacket, type DecisionAssessmentResult } from "../../contracts/src/decision-assessment";

/** Author-created engineering regressions, never expert tactical ground truth. */
export interface DecisionAssessmentEvalCase {
  id: string;
  demoGroup: string;
  split: "CALIBRATION" | "HOLDOUT";
  provenance: "SYNTHETIC_AUTHOR_EXPECTATION";
  timeBasis: "SYNTHETIC_RELATIVE_SECONDS";
  description: string;
  packet: DecisionAssessmentPacket;
  /** Kept outside the packet. The provider must never receive these fields. */
  outcome: "WIN_SURVIVE" | "LOSS_DEATH" | "UNSPECIFIED";
  acceptableLabels: readonly DecisionAssessmentResult["riskWarranted"]["choice"][];
  acceptableAlternatives: readonly DecisionAssessmentResult["alternativePreferable"]["choice"][];
  acceptableSufficiency: readonly DecisionAssessmentResult["contextSufficient"]["choice"][];
  counterfactualPair?: string;
}

type CheckValue = DecisionAssessmentPacket["state"]["checks"][number]["value"];
function packet(delay: CheckValue, trade: CheckValue, cover: CheckValue): DecisionAssessmentPacket {
  return {
    projectionVersion: DECISION_ASSESSMENT_VERSIONS.projection,
    questionVersion: DECISION_ASSESSMENT_VERSIONS.questions,
    scenario: "RECONTACT_AFTER_ADVANTAGE", map: "de_mirage",
    state: { allies: 3, enemies: 2, advantage: 1, observations: [], checks: [
      { code: "objectiveAllowsDelay", value: delay, refs: delay === "UNKNOWN" ? [] : ["e3"] },
      { code: "tradeWindow", value: trade, refs: trade === "UNKNOWN" ? [] : ["e4"] },
      { code: "safeReachableCover", value: cover, refs: cover === "UNKNOWN" ? [] : ["e5"] },
    ] },
    action: { kind: "REPEEK", durationSeconds: 0.75, sincePriorContactSeconds: 2, refs: ["e2"] },
    evidence: [
      { alias: "e1", role: "PUBLIC_COUNTS", confidence: 1 },
      { alias: "e2", role: "ACTION", confidence: 1 },
      ...(delay === "UNKNOWN" ? [] : [{ alias: "e3", role: "objectiveAllowsDelay" as const, confidence: 0.95 }]),
      ...(trade === "UNKNOWN" ? [] : [{ alias: "e4", role: "tradeWindow" as const, confidence: 0.95 }]),
      ...(cover === "UNKNOWN" ? [] : [{ alias: "e5", role: "safeReachableCover" as const, confidence: 0.95 }]),
    ],
  };
}

function entry(input: Omit<DecisionAssessmentEvalCase, "provenance" | "timeBasis">): DecisionAssessmentEvalCase {
  return { ...input, provenance: "SYNTHETIC_AUTHOR_EXPECTATION", timeBasis: "SYNTHETIC_RELATIVE_SECONDS" };
}

const warranted = packet("NO", "YES", "YES");
const unwarranted = packet("YES", "NO", "YES");
const multiple = packet("YES", "YES", "YES");
const activeContest: DecisionAssessmentPacket = { ...multiple, action: { ...multiple.action, kind: "RECONTACT", durationSeconds: 1.25, sincePriorContactSeconds: 4 } };
const missing = packet("UNKNOWN", "UNKNOWN", "UNKNOWN");
const newInformation: DecisionAssessmentPacket = {
  ...multiple,
  state: { ...multiple.state, observations: [{ alias: "e6", kind: "PLAYER_PRESENCE", source: "DEMO_OBSERVER", confidence: 0.95, ageSeconds: 0.5, shared: false }] },
  evidence: [...multiple.evidence, { alias: "e6", role: "OBSERVATION", confidence: 0.95 }],
};
const userInformation: DecisionAssessmentPacket = {
  ...missing,
  state: { ...missing.state, observations: [{ alias: "e6", kind: "USER_CONTEXT", source: "USER_PROVIDED", confidence: 0.55, ageSeconds: 0.5, shared: false }] },
  evidence: [...missing.evidence, { alias: "e6", role: "OBSERVATION", confidence: 0.55 }],
};

function structuredUserReport(enemyArea: "A_SITE" | "B_SITE"): DecisionAssessmentPacket {
  return { ...userInformation, projectionVersion: DECISION_ASSESSMENT_VERSIONS.projectionWithUserContext,
    state: { ...userInformation.state, observations: userInformation.state.observations.map(o => ({ ...o, reportedContext: { version: "user-tactical-context.v1", enemyArea, enemyCount: 2, plan: "TRADE" } })) } };
}

export const decisionAssessmentEvalCases: readonly DecisionAssessmentEvalCase[] = [
  entry({ id: "good-choice-bad-result", demoGroup: "synthetic-objective-a", split: "CALIBRATION", description: "Objective does not allow delay; immediate supported contact still loses.", packet: warranted, outcome: "LOSS_DEATH", acceptableLabels: ["WARRANTED"], acceptableAlternatives: ["NOT_ESTABLISHED"], acceptableSufficiency: ["SUFFICIENT"], counterfactualPair: "objective-outcome" }),
  entry({ id: "good-choice-good-result", demoGroup: "synthetic-objective-a", split: "CALIBRATION", description: "Same legal state and action, favorable outcome.", packet: structuredClone(warranted), outcome: "WIN_SURVIVE", acceptableLabels: ["WARRANTED"], acceptableAlternatives: ["NOT_ESTABLISHED"], acceptableSufficiency: ["SUFFICIENT"], counterfactualPair: "objective-outcome" }),
  entry({ id: "bad-choice-good-result", demoGroup: "synthetic-unnecessary-b", split: "HOLDOUT", description: "Untraded repeat peek with available delay and cover happens to win.", packet: unwarranted, outcome: "WIN_SURVIVE", acceptableLabels: ["UNWARRANTED"], acceptableAlternatives: ["PREFERABLE"], acceptableSufficiency: ["SUFFICIENT"], counterfactualPair: "unnecessary-outcome" }),
  entry({ id: "unnecessary-risk-bad-result", demoGroup: "synthetic-unnecessary-b", split: "HOLDOUT", description: "Same legal state and action, unfavorable outcome.", packet: structuredClone(unwarranted), outcome: "LOSS_DEATH", acceptableLabels: ["UNWARRANTED"], acceptableAlternatives: ["PREFERABLE"], acceptableSufficiency: ["SUFFICIENT"], counterfactualPair: "unnecessary-outcome" }),
  entry({ id: "reasonable-active-contest", demoGroup: "synthetic-trade-c", split: "CALIBRATION", description: "Verified trade window permits proactive contest; retreat is not the only reasonable action.", packet: activeContest, outcome: "UNSPECIFIED", acceptableLabels: ["WARRANTED", "UNKNOWN"], acceptableAlternatives: ["NOT_ESTABLISHED", "UNKNOWN"], acceptableSufficiency: ["SUFFICIENT", "INSUFFICIENT"] }),
  entry({ id: "missing-context", demoGroup: "synthetic-missing-d", split: "HOLDOUT", description: "Counts and action alone do not establish a tactical mistake or a forced choice.", packet: missing, outcome: "UNSPECIFIED", acceptableLabels: ["UNKNOWN"], acceptableAlternatives: ["UNKNOWN", "NOT_ESTABLISHED"], acceptableSufficiency: ["INSUFFICIENT"] }),
  entry({ id: "reliable-new-information", demoGroup: "synthetic-information-e", split: "HOLDOUT", description: "Fresh observer information changes the legal packet; tactical response quality remains unvalidated.", packet: newInformation, outcome: "UNSPECIFIED", acceptableLabels: ["WARRANTED", "UNKNOWN"], acceptableAlternatives: ["NOT_ESTABLISHED", "UNKNOWN"], acceptableSufficiency: ["SUFFICIENT", "INSUFFICIENT"] }),
  entry({ id: "multiple-reasonable-actions", demoGroup: "synthetic-multiple-f", split: "HOLDOUT", description: "Delay, cover, and a trade window coexist; no unique optimal action is established.", packet: structuredClone(multiple), outcome: "UNSPECIFIED", acceptableLabels: ["WARRANTED", "UNKNOWN"], acceptableAlternatives: ["NOT_ESTABLISHED", "UNKNOWN"], acceptableSufficiency: ["SUFFICIENT", "INSUFFICIENT"] }),
  entry({ id: "user-context-not-demo-fact", demoGroup: "synthetic-information-e", split: "HOLDOUT", description: "User-provided report retains source and uncertainty rather than being promoted to Demo fact.", packet: userInformation, outcome: "UNSPECIFIED", acceptableLabels: ["UNKNOWN"], acceptableAlternatives: ["UNKNOWN", "NOT_ESTABLISHED"], acceptableSufficiency: ["INSUFFICIENT"] }),
  ...(["A_SITE", "B_SITE"] as const).map((area) => entry({ id: `structured-report-${area === "A_SITE" ? "a" : "b"}`, demoGroup: "synthetic-information-e", split: "HOLDOUT", description: "Same source, age and confidence; only the substantive user-reported site changes. Other tactical conditions remain unknown.", packet: structuredUserReport(area), outcome: "UNSPECIFIED", acceptableLabels: ["UNKNOWN"], acceptableAlternatives: ["UNKNOWN", "NOT_ESTABLISHED"], acceptableSufficiency: ["INSUFFICIENT"] })),
];

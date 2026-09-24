import { describe, expect, it } from "vitest";
import { DECISION_ASSESSMENT_VERSIONS as V, type DecisionAssessmentPacket, type DecisionAssessmentResult } from "@cs-coach/contracts";
import { buildDecisionWitnessCatalog, validateDecisionWitnesses, DECISION_WITNESS_ATOMS, type DecisionWitnessAtomName } from "./decision-witness";
import { decisionAssessmentEvalCases } from "./decision-assessment-fixtures";

const labels = { riskWarranted: ["WARRANTED", "UNWARRANTED", "UNKNOWN"], alternativePreferable: ["PREFERABLE", "NOT_ESTABLISHED", "UNKNOWN"], contextSufficient: ["SUFFICIENT", "INSUFFICIENT"] };
function packet(id = "bad-choice-good-result"): DecisionAssessmentPacket {
  return { ...structuredClone(decisionAssessmentEvalCases.find(c => c.id === id)!.packet), projectionVersion: V.projectionWithObservationSemantics, questionVersion: V.questionsWithWitnesses };
}
function resultFor(p: DecisionAssessmentPacket, selections: Record<DecisionWitnessAtomName, string>): DecisionAssessmentResult {
  const catalog = buildDecisionWitnessCatalog(p), result: Record<string, unknown> = { model: V.model, questionVersion: p.questionVersion, limitationCodes: ["PRINCIPLE_UNVALIDATED"] }, witnesses: Record<string, unknown> = {};
  for (const name of DECISION_WITNESS_ATOMS) {
    const selected = catalog[name][selections[name]]!;
    result[name] = { choice: selected.choice, confidence: 0.8, probabilities: Object.fromEntries(labels[name].map(c => [c, c === selected.choice ? 1 : 0])), refs: [...selected.refs] };
    witnesses[name] = { choice: selections[name], confidence: 0.7, probabilities: Object.fromEntries(Object.keys(catalog[name]).map(c => [c, c === selections[name] ? 1 : 0])) };
  }
  return { ...result, witnesses } as unknown as DecisionAssessmentResult;
}
const avoid = { riskWarranted: "AVOIDABLE_RECONTACT", alternativePreferable: "COVER_WITH_DELAY", contextSufficient: "COMPLETE" };

describe("explicit joint evidence witnesses", () => {
  it("uses distinct minimal premise bundles for avoidance, alternative and sufficiency", () => {
    const p = packet(), r = resultFor(p, avoid);
    expect(r.riskWarranted.refs).toEqual(["e1", "e2", "e3", "e4", "e5"]);
    expect(r.alternativePreferable.refs).toEqual(["e3", "e5"]);
    expect(r.contextSufficient.refs).toEqual(["e3", "e4", "e5"]);
    expect(validateDecisionWitnesses(p, r)).toEqual([]);
  });
  it("keeps a fixed catalog instead of revealing a preselected baseline answer", () => {
    const bad = buildDecisionWitnessCatalog(packet()), trade = buildDecisionWitnessCatalog(packet("reasonable-active-contest"));
    for (const name of DECISION_WITNESS_ATOMS) expect(Object.keys(bad[name])).toEqual(Object.keys(trade[name]));
    expect(bad.riskWarranted.TRADE_SUPPORT.applicable).toBe(false);
    expect(trade.riskWarranted.TRADE_SUPPORT.applicable).toBe(true);
  });
  it("supports trading with multiple reasonable actions and urgency without forced-choice inference", () => {
    const trade = packet("reasonable-active-contest"), urgent = packet("good-choice-bad-result");
    expect(validateDecisionWitnesses(trade, resultFor(trade, { riskWarranted: "TRADE_SUPPORT", alternativePreferable: "MULTIPLE_SUPPORTED_OPTIONS", contextSufficient: "COMPLETE" }))).toEqual([]);
    expect(validateDecisionWitnesses(urgent, resultFor(urgent, { riskWarranted: "OBJECTIVE_URGENCY", alternativePreferable: "NO_APPLICABLE_ALTERNATIVE", contextSufficient: "COMPLETE" }))).toEqual([]);
  });
  it("accepts honest missing context and refuses to invent a witness", () => {
    const p = packet("missing-context"), r = resultFor(p, { riskWarranted: "NONE", alternativePreferable: "NONE", contextSufficient: "MISSING_TIMING" });
    expect(validateDecisionWitnesses(p, r)).toEqual([]);
    delete r.witnesses;
    expect(validateDecisionWitnesses(p, r)).toContain("INVALID_WITNESS_SCHEMA");
  });
  it("rejects labels confused with a witness, false checks and extra citations", () => {
    const p = packet(), r = resultFor(p, avoid);
    r.riskWarranted.choice = "WARRANTED";
    expect(validateDecisionWitnesses(p, r)).toContain("WITNESS_LABEL_MISMATCH");
    expect(validateDecisionWitnesses(p, resultFor(p, { ...avoid, riskWarranted: "TRADE_SUPPORT" }))).toContain("INAPPLICABLE_WITNESS");
    const stuffed = resultFor(p, avoid); stuffed.alternativePreferable.refs = [...stuffed.alternativePreferable.refs, "e1"];
    expect(validateDecisionWitnesses(p, stuffed)).toContain("WITNESS_REFS_MISMATCH");
    stuffed.alternativePreferable.refs = ["e999"];
    expect(validateDecisionWitnesses(p, stuffed)).toContain("WITNESS_REFS_MISMATCH");
  });
  it("never adds unrelated observations to the selected support sets", () => {
    const p = packet(), initial = resultFor(p, avoid);
    p.evidence = [...p.evidence, { alias: "e6", role: "OBSERVATION", confidence: 1 }];
    p.state.observations = [...p.state.observations, { alias: "e6", kind: "PLAYER_POSITION", source: "DEMO_OBSERVER", confidence: 1, ageSeconds: 0, shared: false }];
    expect(resultFor(p, avoid)).toEqual(initial);
    expect(validateDecisionWitnesses(p, initial)).toEqual([]);
  });
  it("checks witness probabilities independently of model confidence", () => {
    const p = packet(), r = resultFor(p, avoid);
    r.witnesses!.riskWarranted.confidence = NaN;
    expect(validateDecisionWitnesses(p, r)).toContain("INVALID_WITNESS_SCHEMA");
    r.witnesses!.riskWarranted.confidence = 0.05;
    expect(validateDecisionWitnesses(p, r)).toEqual([]);
    r.witnesses!.riskWarranted.probabilities = { ...r.witnesses!.riskWarranted.probabilities, NONE: 0.9 };
    expect(validateDecisionWitnesses(p, r)).toContain("INVALID_WITNESS_PROBABILITIES");
    r.witnesses!.riskWarranted.probabilities = Object.fromEntries(Object.keys(r.witnesses!.riskWarranted.probabilities).map(k => [k, k === "NONE" ? 0.6 : k === "AVOIDABLE_RECONTACT" ? 0.4 : 0]));
    expect(validateDecisionWitnesses(p, r)).toContain("INVALID_WITNESS_PROBABILITIES");
  });
  it("allows supported risk plus insufficient wider context but rejects sufficient plus unknown", () => {
    const p = packet(), supported = resultFor(p, { ...avoid, contextSufficient: "UNRESOLVED_CONTEXT" });
    expect(validateDecisionWitnesses(p, supported)).toEqual([]);
    expect(validateDecisionWitnesses(p, resultFor(p, { ...avoid, riskWarranted: "NONE" }))).toContain("INCONSISTENT_ATOMIC_JUDGMENTS");
  });
  it("keeps RETURN_AND_FIRE limited to the explicit unverified-contact witness", () => {
    const p = packet(); p.scenario = "RETURN_AND_FIRE_AFTER_ADVANTAGE"; p.action = { kind: "RETURN_AND_FIRE", durationSeconds: 0.5, sincePriorShotSeconds: 1, contactStatus: "UNVERIFIED", refs: ["e2"] };
    expect(validateDecisionWitnesses(p, resultFor(p, { riskWarranted: "NONE", alternativePreferable: "NONE", contextSufficient: "UNVERIFIED_CONTACT" }))).toEqual([]);
    expect(validateDecisionWitnesses(p, resultFor(p, avoid))).toContain("CONTACT_UNVERIFIED");
    expect(validateDecisionWitnesses(p, resultFor(p, { riskWarranted: "NONE", alternativePreferable: "NONE", contextSufficient: "UNRESOLVED_CONTEXT" }))).toContain("CONTACT_UNVERIFIED");
  });
});

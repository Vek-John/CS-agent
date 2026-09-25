import { resolveDecisionAssessment } from "./decision-assessment";
import type {
  AdviceOption, AdviceApplicabilityResult, BehaviorHypothesis, CandidateMaterial,
  DecisionCheck, TeachingAssessment, TeachingCandidate, TrustedDecisionSemantics
} from "@cs-coach/contracts";
import { UNCERTAIN_ADVICE_TEXT } from "./coaching-language";

const unique = (items: readonly string[]): string[] => [...new Set(items)];
export const ADVICE_GATE_VERSION = "advice-applicability/1.0.0";

const RULES = [
  { code: "HIGH_HEALTH_TEAMMATE_FIRST", text: "让已能参与这次接触的高血量队友先接触，你随后跟进。", conditions: ["teammateAlive", "higherHealthTeammate", "tradeWindow", "objectiveAllowsDelay"] },
  { code: "TRADE_TEAMMATE", text: "在已确认的补枪窗口内跟进队友。", conditions: ["teammateAlive", "tradeWindow", "objectiveAllowsDelay"] },
  { code: "FLASH_BEFORE_ADVANCE", text: "使用手中闪光配合已确认的推进时机。", conditions: ["flashAvailable", "flashPurpose", "objectiveAllowsDelay"] },
  { code: "WAIT_FOR_TEAMMATE", text: "利用当前允许的等待时间，与能到位的队友集合。", conditions: ["teammateAlive", "tradeWindow", "objectiveAllowsDelay"] },
  { code: "REACHABLE_COVER", text: "退回已确认能够安全到达的掩体。", conditions: ["safeReachableCover", "objectiveAllowsDelay"] },
  { code: "KNOWN_ALTERNATE_ROUTE", text: "改走当时已知且可通行的替代路线。", conditions: ["knownAlternateRoute", "objectiveAllowsDelay"] }
] as const;

export function observableDecisionRefs(material: CandidateMaterial, decisionTick: number): string[] {
  return unique([
    ...material.decisionFacts.filter((fact) => fact.observed_by_player && fact.availability === "DECISION" && fact.available_at_tick <= decisionTick).map((fact) => fact.id),
    ...(material.observableContext && material.observableContext.state.at_tick <= decisionTick && material.observableContext.state.observer_player_id === material.decisionSnapshot?.selectedPlayerId && material.observableContext.snapshotId === material.decisionSnapshot?.snapshotId ? material.observableContext.state.claims : []).filter((claim) => claim.available_from_tick <= decisionTick && claim.evidence_tick <= decisionTick && (claim.expires_at_tick === undefined || claim.expires_at_tick > decisionTick) && claim.confidence >= 0.8).map((claim) => claim.id)
  ]);
}

/** Ground truth is a one-way veto. A true world-state check never grants player knowledge. */
export function evaluateAdviceApplicability(
  option: AdviceOption,
  semantics: TrustedDecisionSemantics,
  decisionTick: number,
  observableRefs: readonly string[] = []
): AdviceApplicabilityResult {
  const snapshot = semantics.decisionSnapshot;
  const checks = [...(snapshot?.supportChecks ?? []), ...(snapshot?.pressureChecks ?? []), ...(snapshot?.spatialChecks ?? [])];
  const allowed = new Set(observableRefs);
  const resultChecks: DecisionCheck[] = option.requiredPreconditions.map((condition) => {
    const matches = checks.filter((check) => check.code === condition.code && check.boundary !== "OUTCOME");
    const veto = matches.find((check) => check.status === "INAPPLICABLE");
    if (veto) return veto;
    const approved = matches.find((check) => check.status === "APPLICABLE" && check.boundary === "OBSERVABLE" && check.evidenceRefs.length > 0 && check.evidenceRefs.every((ref) => allowed.has(ref)) && condition.requiredEvidence.every((ref) => check.evidenceRefs.includes(ref)) && check.missingFields.length === 0);
    return approved ?? { code: condition.code, status: "UNVERIFIABLE", boundary: "OBSERVABLE", evidenceRefs: [], missingFields: unique([condition.code, ...matches.flatMap((check) => check.missingFields)]), reason: "缺少能确认该行动条件的现场信息。" };
  });
  // Derive physical disqualifiers without ever publishing their hidden-state evidence as advice reasons.
  if (option.requiredPreconditions.some((condition) => condition.code === "teammateAlive") && snapshot?.aliveCounts.value && snapshot.aliveCounts.value.allies <= 1) {
    resultChecks.push({ code: "noAliveTeammates", status: "INAPPLICABLE", boundary: "APPLICABILITY_ONLY", evidenceRefs: snapshot.aliveCounts.evidenceRefs, missingFields: [], reason: "没有存活队友，无法执行协同方案。" });
  }
  for (const condition of option.disqualifiers) {
    const check = checks.find((item) => item.code === condition.code && item.boundary !== "OUTCOME" && item.status === "APPLICABLE");
    if (check) resultChecks.push({ ...check, status: "INAPPLICABLE" });
  }
  if (decisionTick < option.timingWindow.startTick || decisionTick > option.timingWindow.endTick || (snapshot && (snapshot.decisionTick !== decisionTick || (snapshot.sampledAtTick !== null && snapshot.sampledAtTick > decisionTick)))) {
    resultChecks.push({ code: "timingWindow", status: "INAPPLICABLE", boundary: "APPLICABILITY_ONLY", evidenceRefs: [], missingFields: [], reason: "建议不属于当前决策窗口。" });
  }
  const missingEvidence = option.requiredEvidence.filter((ref) => !allowed.has(ref));
  const status = resultChecks.some((check) => check.status === "INAPPLICABLE") ? "INAPPLICABLE"
    : resultChecks.length === 0 || resultChecks.some((check) => check.status === "UNVERIFIABLE") || missingEvidence.length > 0 || !Number.isFinite(option.confidence) || option.confidence < 0.8 ? "UNVERIFIABLE" : "APPLICABLE";
  return {
    adviceCode: option.code, status, preconditions: resultChecks,
    evidenceRefs: unique(resultChecks.flatMap((check) => check.evidenceRefs)),
    rejectionReasons: resultChecks.filter((check) => check.status !== "APPLICABLE").map((check) => check.reason),
    missingFields: unique([...resultChecks.flatMap((check) => check.missingFields), ...missingEvidence]),
    allowedIntoNarrator: status === "APPLICABLE", fallbackWording: UNCERTAIN_ADVICE_TEXT
  };
}

/** Rebuild the fixed rule catalog; neither provider nor stored prose can define its own preconditions. */
export function buildGatedAdviceOptions(candidate: TeachingCandidate, material: CandidateMaterial): AdviceOption[] {
  const semantics = { ...candidate, ...material };
  const refs = observableDecisionRefs(material, candidate.decisionTick);
  return RULES.map((rule) => {
    const option: AdviceOption = {
      id: `advice-${candidate.candidateId}-${rule.code}`, code: rule.code, text: rule.text,
      trigger: "当前决策窗口的全部行动条件已确认时", fact_refs: [], rule_id: `${ADVICE_GATE_VERSION}/${rule.code}`,
      requiredPreconditions: rule.conditions.map((code) => ({ code, description: code, requiredEvidence: [] })),
      disqualifiers: ["futureInformationRequired", "objectiveWindowExpired"].map((code) => ({ code, description: code, requiredEvidence: [] })),
      requiredEvidence: [], timingWindow: { startTick: candidate.decisionTick, endTick: candidate.decisionTick }, confidence: 0.9,
      fallbackWording: UNCERTAIN_ADVICE_TEXT
    };
    const applicability = evaluateAdviceApplicability(option, semantics, candidate.decisionTick, refs);
    return { ...option, applicability, fact_refs: applicability.status === "APPLICABLE" ? applicability.evidenceRefs.filter((ref) => material.decisionFacts.some((fact) => fact.id === ref)) : [] };
  });
}

function verifiedHypotheses(candidate: TeachingCandidate, material: CandidateMaterial): BehaviorHypothesis[] {
  const decisionRefs = new Set(observableDecisionRefs(material, candidate.decisionTick));
  const actionRefs = new Set(material.playerActionFacts.filter((fact) => !fact.presentationOnly && fact.availableAtTick <= candidate.revealTick).map((fact) => fact.id));
  const snapshot = material.decisionSnapshot ?? candidate.decisionSnapshot;
  const checks = [...(snapshot?.supportChecks ?? []), ...(snapshot?.pressureChecks ?? []), ...(snapshot?.spatialChecks ?? [])];
  return (material.behaviorHypotheses ?? candidate.behaviorHypotheses ?? []).filter((hypothesis) =>
    checks.some((check) => check.code === `behavior:${hypothesis.kind}` && check.status === "APPLICABLE" && check.boundary === "OBSERVABLE" && check.missingFields.length === 0 && check.evidenceRefs.length > 0 && check.evidenceRefs.every((ref) => hypothesis.supportingEvidenceRefs.includes(ref))) &&
    hypothesis.allowedAsTeachingJudgment && !hypothesis.reflectionOnly && hypothesis.confidence >= 0.8 && hypothesis.missingFields.length === 0 &&
    hypothesis.supportingEvidenceRefs.some((ref) => decisionRefs.has(ref)) &&
    hypothesis.supportingEvidenceRefs.some((ref) => actionRefs.has(ref)) &&
    hypothesis.supportingEvidenceRefs.every((ref) => decisionRefs.has(ref) || actionRefs.has(ref))
  );
}

const PROCESS_ASSESSMENTS: Readonly<Record<string, TeachingAssessment["kind"]>> = {
  ISOLATED_CONTACT: "DECISION_ERROR", DELAYED_OBJECTIVE_ACTION: "DECISION_ERROR",
  AIM_EXECUTION_FAILURE: "EXECUTION_ISSUE", VERIFIED_TEAM_TRADE: "POSITIVE_PROCESS",
  PURPOSEFUL_UTILITY: "POSITIVE_PROCESS", OBJECTIVE_FORCED_ACTION: "FORCED_CHOICE"
};

export function assessCandidateTeaching(candidate: TeachingCandidate, material: CandidateMaterial): TeachingAssessment {
  const decisionAssessment = resolveDecisionAssessment(candidate, material);
  if (decisionAssessment) {
    if (decisionAssessment.kind === "DECISION_ERROR" && !buildGatedAdviceOptions(candidate, material).some((option) => option.applicability?.allowedIntoNarrator)) {
      return { ...decisionAssessment, kind: "INSUFFICIENT_EVIDENCE", confidence: 0.35, hasEvaluableDecision: false, missingFields: ["executable_alternative"], explanation: "现有信息不足以确认可执行的替代行动，暂不判断这次选择有错。" };
    }
    return decisionAssessment;
  }
  const hypotheses = verifiedHypotheses(candidate, material);
  const positiveResult = (candidate.resultSummary.winProbabilityDelta ?? 0) > 0 || (candidate.resultSummary.winProbabilityPercentagePoints ?? 0) > 0;
  const counterEvidenceRefs = unique([...(positiveResult ? candidate.winRateSignalRefs : []), ...hypotheses.flatMap((hypothesis) => hypothesis.counterEvidenceRefs)]);
  const supportedHypothesis = hypotheses.find((hypothesis) => PROCESS_ASSESSMENTS[hypothesis.kind]);
  const kind = supportedHypothesis ? PROCESS_ASSESSMENTS[supportedHypothesis.kind] : undefined;
  const options = buildGatedAdviceOptions(candidate, material);
  const approved = options.some((option) => option.applicability?.allowedIntoNarrator);
  const verified = kind && (kind !== "DECISION_ERROR" || approved && !positiveResult && counterEvidenceRefs.length === 0);
  const hasDecision = observableDecisionRefs(material, candidate.decisionTick).length > 0;
  const snapshot = material.decisionSnapshot ?? candidate.decisionSnapshot;
  const meaningfulContext = snapshot && (
    (snapshot.selectedPlayer.value?.health !== null && (snapshot.selectedPlayer.value?.health ?? 100) <= 45) ||
    snapshot.aliveCounts.value?.allies === 1 || snapshot.bomb.value?.state === "PLANTED" ||
    (snapshot.clock.value?.remainingSeconds !== null && (snapshot.clock.value?.remainingSeconds ?? 120) < 20)
  );
  const meaningfulReflection = hasDecision && (positiveResult && candidate.source.kind === "DEATH" ||
    Boolean(meaningfulContext) && ["DEATH", "HP_CHANGE", "BOMB"].includes(candidate.source.kind) ||
    candidate.source.kind === "WIN_RATE_DROP" && (candidate.resultSummary.winProbabilityDelta ?? 0) <= -0.12);
  const assessmentKind = verified ? kind : meaningfulReflection ? "INSUFFICIENT_EVIDENCE" : "NO_TEACHING_VALUE";
  const explanation = assessmentKind === "POSITIVE_PROCESS" ? "可观察的处理过程支持这次选择，不应仅凭最终结果否定它。"
    : assessmentKind === "FORCED_CHOICE" ? "当时的时间或目标条件限制了选择，需要结合这些限制看待处理。"
      : assessmentKind === "EXECUTION_ISSUE" ? "现有过程证据更支持执行上的问题，不能直接归为决策失误。"
        : assessmentKind === "DECISION_ERROR" ? "当时的可观察证据支持一项可改进的选择，且替代行动的条件已确认。"
          : positiveResult ? "不能只看个人结果评价这次选择；目前没有足够的独立过程证据证明决策错误。"
            : "当前证据不足以判断这次选择是否有问题；结果本身不能说明决策对错。";
  return { kind: assessmentKind, confidence: verified ? Math.min(...hypotheses.map((hypothesis) => hypothesis.confidence)) : 0.35,
    supportingEvidenceRefs: verified ? unique(hypotheses.flatMap((hypothesis) => hypothesis.supportingEvidenceRefs)) : observableDecisionRefs(material, candidate.decisionTick),
    counterEvidenceRefs, missingFields: verified ? [] : unique([...candidate.missingFields, "verified_decision_process", ...(!approved ? ["executable_alternative"] : [])]),
    limitations: verified ? [] : ["无法确认完整行动意图、现场信息和可执行替代方案。"], explanation, hasEvaluableDecision: Boolean(verified) };
}

export function allowedTeachingFocusCodes(assessment: TeachingAssessment): string[] {
  switch (assessment.kind) {
    case "DECISION_ERROR": return ["VERIFIED_DECISION_REVIEW"];
    case "EXECUTION_ISSUE": return ["EXECUTION_REVIEW"];
    case "POSITIVE_PROCESS": return ["POSITIVE_PROCESS"];
    case "FORCED_CHOICE": return ["FORCED_CHOICE"];
    case "INSUFFICIENT_EVIDENCE": return ["REVIEW_UNCERTAINTY"];
    case "NO_TEACHING_VALUE": return [];
  }
}

export function verifiedHabitKey(candidate: TeachingCandidate, material: CandidateMaterial): string | undefined {
  // Uncalibrated pilot judgments must not create new habit counts or promotion evidence.
  if (material.decisionAssessment || candidate.decisionAssessment) return undefined;
  const assessment = assessCandidateTeaching(candidate, material);
  if (!assessment.hasEvaluableDecision || assessment.kind !== "DECISION_ERROR") return undefined;
  const hypotheses = verifiedHypotheses(candidate, material);
  const conditions = buildGatedAdviceOptions(candidate, material).filter((option) => option.applicability?.allowedIntoNarrator).flatMap((option) => option.requiredPreconditions.map((condition) => condition.code));
  return `${hypotheses.map((hypothesis) => hypothesis.kind).sort().join("+")}:${unique(conditions).sort().join("+")}`;
}

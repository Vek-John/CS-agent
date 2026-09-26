import type {
  PresentableSessionWrapUpCue,
  SessionSummaryInput,
  SessionWrapUpBuildInput,
} from "@cs-coach/coach-agent/client";
import { assessCandidateTeaching, buildGatedAdviceOptions, verifiedHabitKey } from "@cs-coach/review-planner";
import { CueCaseSchema, REVISED_DIAGNOSIS_SUMMARY_LIMITATION } from "@cs-coach/coach-agent/client";
import type { CandidateSet, CueCase, NarrationBundle, ReviewPlan } from "@cs-coach/contracts";

/**
 * Projects only completed, presentable cue material into the wrap-up seam.
 * Unlisted cues are intentionally ignored; no route/tick/replay data crosses.
 */
export function buildStage3WrapUpInput(
  plan: ReviewPlan,
  summary: SessionSummaryInput,
  narrationByCue: Readonly<Record<string, NarrationBundle>>,
  candidateSet?: CandidateSet,
  diagnoses: readonly CueCase[] = [],
): SessionWrapUpBuildInput {
  const presentableCues: Record<string, PresentableSessionWrapUpCue> = {};
  const habitKeys = new Map<string, string>();
  const revisedCues = new Set<string>();
  for (const raw of diagnoses) {
    const parsed = CueCaseSchema.safeParse(raw);
    if (!parsed.success) continue;
    const diagnosis = parsed.data;
    const cue = plan.cues.find(item => item.id === diagnosis.cueId);
    if (!cue || (diagnosis.candidateId && diagnosis.candidateId !== cue.candidate_id)) continue;
    if ((diagnosis.verdict?.revision ?? 0) > 0 || diagnosis.attemptBudget.disagreement > 0) revisedCues.add(cue.id);
  }
  let omittedRevisedSupport = false;
  // Graph themes list completed support cues; completedCues lists only one
  // representative per theme. Never discover support from the plan/narration map.
  const support = summary.themes.flatMap(theme => theme.cueRefs.map(cueId => ({ cueId, focus: theme.focus })));
  for (const completed of support) {
    const cue = plan.cues.find((candidate) => candidate.id === completed.cueId);
    const narration = narrationByCue[completed.cueId];
    if (!cue || !narration || narration.cueId !== cue.id || narration.candidateId !== cue.candidate_id || narration.primaryFocusCode !== completed.focus) continue;
    if (revisedCues.has(cue.id)) { omittedRevisedSupport = true; continue; }
    if (cue.primary_focus_code && cue.primary_focus_code !== completed.focus) continue;
    const candidate = candidateSet?.candidates.find((item) => item.candidateId === cue.candidate_id);
    const material = candidateSet?.materials.find((item) => item.candidateId === cue.candidate_id);
    if (!candidate || !material || candidate.decisionTick !== cue.decision_tick || candidate.revealTick !== cue.reveal_tick || candidate.outcomeEnd !== cue.outcome_end_tick) continue;
    const assessment = assessCandidateTeaching(candidate, material);
    const habitKey = verifiedHabitKey(candidate, material);
    if (!assessment.hasEvaluableDecision || assessment.kind !== "DECISION_ERROR" || !habitKey) continue;
    const representative = summary.completedCues.find(item => item.cueId === cue.id && item.focus === completed.focus);
    const adviceRefs = representative ? new Set(representative.adviceRefs) : undefined;
    const advice = buildGatedAdviceOptions(candidate, material)
      .filter((item) => item.applicability?.allowedIntoNarrator && (!adviceRefs || adviceRefs.has(item.id)))
      .map((item) => ({ id: item.id, text: item.text, refs: [...item.fact_refs] }));
    if (advice.length === 0) continue;
    habitKeys.set(cue.id, habitKey);
    presentableCues[cue.id] = {
      cueId: cue.id,
      focus: completed.focus,
      coreIssue: {
        text: assessment.explanation,
        refs: [...assessment.supportingEvidenceRefs],
        limitations: [...assessment.limitations],
      },
      betterPlay: {
        text: advice[0].text,
        refs: [advice[0].id, ...advice[0].refs],
        limitations: [],
      },
      advice,
    };
  }
  const themes = summary.themes.flatMap((theme) => {
    const cueRefs = [...new Set(theme.cueRefs)].filter((id) => presentableCues[id]?.focus === theme.focus);
    if (cueRefs.length < 2 || theme.conflictEvidence || new Set(cueRefs.map((id) => habitKeys.get(id))).size !== 1) return [];
    const representatives = summary.completedCues.filter(cue => cue.focus === theme.focus && cueRefs.includes(cue.cueId));
    if (!representatives.length) return [];
    const adviceRefs = [...new Set(representatives.flatMap(cue => presentableCues[cue.cueId].advice.map(advice => advice.id)))];
    const evidenceRefs = [...new Set(cueRefs.flatMap(id => presentableCues[id].coreIssue.refs))].filter(ref => theme.evidenceRefs.includes(ref));
    const roundRefs = [...new Set(cueRefs.flatMap(id => {
      const cue = plan.cues.find(cue => cue.id === id)!;
      const round = plan.segments.find(segment => segment.id === cue.segment_id)?.round_number;
      return round === undefined ? [] : [`round-${round}`];
    }))];
    return [{ ...theme, cueRefs, adviceRefs, evidenceRefs, roundRefs, occurrence: cueRefs.length }];
  });
  const included = new Set(summary.completedCues.filter(cue => themes.some(theme => theme.focus === cue.focus && theme.cueRefs.includes(cue.cueId))).map(cue => cue.cueId));
  const limitations = [...new Set([...summary.limitations, ...(omittedRevisedSupport ? [REVISED_DIAGNOSIS_SUMMARY_LIMITATION] : [])])];
  if (limitations.length > 8) throw new Error("SOURCE_LIMITATIONS_EXCEED_OUTPUT_LIMIT");
  return {
    summary: { ...summary, themes, limitations, completedCues: summary.completedCues.filter((cue) => included.has(cue.cueId)).map((cue) => ({ ...cue, evidenceRefs: cue.evidenceRefs.filter(ref => themes.find(theme => theme.focus === cue.focus)!.evidenceRefs.includes(ref)), adviceRefs: presentableCues[cue.cueId].advice.map((advice) => advice.id) })) },
    presentableCues: Object.fromEntries(Object.entries(presentableCues).filter(([id]) => included.has(id))),
  };
}

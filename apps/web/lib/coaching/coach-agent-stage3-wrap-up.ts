import type {
  PresentableSessionWrapUpCue,
  SessionSummaryInput,
  SessionWrapUpBuildInput,
} from "@cs-coach/coach-agent/client";
import { assessCandidateTeaching, buildGatedAdviceOptions, verifiedHabitKey } from "@cs-coach/review-planner";
import type { CandidateSet, NarrationBundle, ReviewPlan } from "@cs-coach/contracts";

/**
 * Projects only completed, presentable cue material into the wrap-up seam.
 * Unlisted cues are intentionally ignored; no route/tick/replay data crosses.
 */
export function buildStage3WrapUpInput(
  plan: ReviewPlan,
  summary: SessionSummaryInput,
  narrationByCue: Readonly<Record<string, NarrationBundle>>,
  candidateSet?: CandidateSet,
): SessionWrapUpBuildInput {
  const presentableCues: Record<string, PresentableSessionWrapUpCue> = {};
  const habitKeys = new Map<string, string>();
  for (const completed of summary.completedCues) {
    const cue = plan.cues.find((candidate) => candidate.id === completed.cueId);
    const narration = narrationByCue[completed.cueId];
    if (!cue || !narration) continue;
    const candidate = candidateSet?.candidates.find((item) => item.candidateId === cue.candidate_id);
    const material = candidateSet?.materials.find((item) => item.candidateId === cue.candidate_id);
    if (!candidate || !material) continue;
    const assessment = assessCandidateTeaching(candidate, material);
    const habitKey = verifiedHabitKey(candidate, material);
    if (!assessment.hasEvaluableDecision || assessment.kind !== "DECISION_ERROR" || !habitKey) continue;
    const adviceRefs = new Set(completed.adviceRefs);
    const advice = buildGatedAdviceOptions(candidate, material)
      .filter((item) => item.applicability?.allowedIntoNarrator && adviceRefs.has(item.id))
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
    const cueRefs = [...new Set(theme.cueRefs)].filter((id) => presentableCues[id]);
    if (cueRefs.length < 2 || theme.conflictEvidence || new Set(cueRefs.map((id) => habitKeys.get(id))).size !== 1) return [];
    const adviceRefs = [...new Set(cueRefs.flatMap((id) => presentableCues[id].advice.map((advice) => advice.id)))];
    return [{ ...theme, cueRefs, adviceRefs, occurrence: cueRefs.length }];
  });
  const included = new Set(themes.flatMap((theme) => theme.cueRefs));
  return {
    summary: { ...summary, themes, completedCues: summary.completedCues.filter((cue) => included.has(cue.cueId)).map((cue) => ({ ...cue, adviceRefs: presentableCues[cue.cueId].advice.map((advice) => advice.id) })) },
    presentableCues: Object.fromEntries(Object.entries(presentableCues).filter(([id]) => included.has(id))),
  };
}

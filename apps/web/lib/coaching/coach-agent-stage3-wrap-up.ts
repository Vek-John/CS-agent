import type {
  PresentableSessionWrapUpCue,
  SessionSummaryInput,
  SessionWrapUpBuildInput,
} from "@cs-coach/coach-agent/client";
import type { NarrationBundle, ReviewPlan } from "@cs-coach/contracts";

/**
 * Projects only completed, presentable cue material into the wrap-up seam.
 * Unlisted cues are intentionally ignored; no route/tick/replay data crosses.
 */
export function buildStage3WrapUpInput(
  plan: ReviewPlan,
  summary: SessionSummaryInput,
  narrationByCue: Readonly<Record<string, NarrationBundle>>,
): SessionWrapUpBuildInput {
  const presentableCues: Record<string, PresentableSessionWrapUpCue> = {};
  for (const completed of summary.completedCues) {
    const cue = plan.cues.find((candidate) => candidate.id === completed.cueId);
    const narration = narrationByCue[completed.cueId];
    if (!cue || !narration) continue;
    const adviceRefs = new Set(completed.adviceRefs);
    const advice = cue.advice
      .filter((item) => adviceRefs.has(item.id))
      .map((item) => ({ id: item.id, text: item.text, refs: [...item.fact_refs] }));
    presentableCues[cue.id] = {
      cueId: cue.id,
      focus: completed.focus,
      coreIssue: {
        text: narration.coreIssue.text,
        refs: [...narration.coreIssue.refs],
        limitations: [...(narration.coreIssue.limitations ?? [])],
      },
      betterPlay: {
        text: narration.betterPlay.text,
        refs: [...narration.betterPlay.refs],
        limitations: [...(narration.betterPlay.limitations ?? [])],
      },
      advice,
    };
  }
  return { summary, presentableCues };
}

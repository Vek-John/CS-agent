/** Judgment categories are not tactical tool purposes. Exact Compiler vocabulary only. */
export const CURRENT_TEACHING_FOCUS_CODES = ["VERIFIED_DECISION_REVIEW", "EXECUTION_REVIEW", "POSITIVE_PROCESS", "FORCED_CHOICE", "REVIEW_UNCERTAINTY"] as const;
export const TEACHING_PRESENTATION_PURPOSES = ["ACTION_FACT_REPLAY"] as const;
export type TeachingPresentationPurpose = typeof TEACHING_PRESENTATION_PURPOSES[number];
export function presentationPurposeForTool(tool: string): TeachingPresentationPurpose | undefined {
  return tool === "REPLAY_CUE_SLOW" ? "ACTION_FACT_REPLAY" : undefined;
}
export function isCurrentTeachingFocus(focus: string): boolean {
  return (CURRENT_TEACHING_FOCUS_CODES as readonly string[]).includes(focus);
}

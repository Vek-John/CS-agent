type PickerSurface = Pick<HTMLElement, "scrollIntoView" | "focus">;

/** Navigation is not file selection: the Viewer owns the trusted picker click and import events. */
export function focusRecoveryDemoPicker(surface: PickerSurface | null): void {
  surface?.scrollIntoView({ block: "center", behavior: "auto" });
  surface?.focus();
}

export function isRecoveryDemoImportActive(
  progress: { requestId: string } | undefined,
  expected: { requestId: string } | undefined,
): boolean {
  return Boolean(progress && expected && progress.requestId === expected.requestId);
}

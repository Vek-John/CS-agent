type TauriInternals = {
  readonly invoke?: (command: string, args?: Record<string, never>) => Promise<unknown>;
};

/** The main remote WebView receives exactly this one native command. */
export async function openDesktopSettings(
  internals = (globalThis as typeof globalThis & { __TAURI_INTERNALS__?: TauriInternals }).__TAURI_INTERNALS__,
): Promise<boolean> {
  if (typeof internals?.invoke !== "function") return false;
  await internals.invoke("open_settings", {});
  return true;
}

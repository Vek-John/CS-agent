import { describe, expect, it, vi } from "vitest";
import { openDesktopSettings } from "./open-settings";

describe("desktop Settings entry", () => {
  it("invokes only the native open_settings command and degrades outside Tauri", async () => {
    const invoke = vi.fn().mockResolvedValue(undefined);
    await expect(openDesktopSettings({ invoke })).resolves.toBe(true);
    expect(invoke).toHaveBeenCalledWith("open_settings", {});
    expect(invoke).toHaveBeenCalledTimes(1);
    await expect(openDesktopSettings(undefined)).resolves.toBe(false);
  });
});

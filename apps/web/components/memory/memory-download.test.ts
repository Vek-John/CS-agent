import { describe, expect, it, vi } from "vitest";
import {
  downloadMemoryExport,
  type MemoryDownloadEnvironment,
} from "./memory-download";

describe("memory export download", () => {
  it("uses an attached download anchor and immediately revokes its object URL", async () => {
    const steps: string[] = [];
    const anchor = {
      href: "",
      download: "",
      click: vi.fn(() => steps.push("click")),
      remove: vi.fn(() => steps.push("remove")),
    };
    const environment: MemoryDownloadEnvironment = {
      fetch: vi.fn(async () =>
        new Response('{"schemaVersion":"memory-export.v1"}', {
          headers: {
            "content-disposition":
              'attachment; filename="cs-agent-memory-export-2026-08-30.json"',
            "content-type": "application/json",
          },
        }),
      ),
      createObjectUrl: vi.fn(() => "blob:memory-export"),
      revokeObjectUrl: vi.fn(() => steps.push("revoke")),
      appendAnchor: vi.fn(() => steps.push("append")),
      createAnchor: () => anchor,
    };

    await expect(downloadMemoryExport(environment)).resolves.toBe(
      "cs-agent-memory-export-2026-08-30.json",
    );
    expect(anchor.href).toBe("blob:memory-export");
    expect(anchor.download).toBe("cs-agent-memory-export-2026-08-30.json");
    expect(steps).toEqual(["append", "click", "remove", "revoke"]);
    expect(environment.fetch).toHaveBeenCalledWith("/api/memory/export", {
      method: "GET",
      credentials: "same-origin",
      headers: { accept: "application/json" },
    });
  });

  it("does not create an object URL when the API rejects the export", async () => {
    const createObjectUrl = vi.fn(() => "blob:unused");
    const environment: MemoryDownloadEnvironment = {
      fetch: async () =>
        Response.json({ error: "EXPORT_NOT_SUPPORTED" }, { status: 501 }),
      createObjectUrl,
      revokeObjectUrl: vi.fn(),
      appendAnchor: vi.fn(),
      createAnchor: () => ({
        href: "",
        download: "",
        click: vi.fn(),
        remove: vi.fn(),
      }),
    };

    await expect(downloadMemoryExport(environment)).rejects.toThrow(
      "EXPORT_NOT_SUPPORTED",
    );
    expect(createObjectUrl).not.toHaveBeenCalled();
  });
});

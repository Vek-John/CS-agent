import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  CS2D_PIN,
  CS2D_REUSE_DECISIONS,
  classifyPatchedCheckout,
  isControlledDirtyPath,
} from "./apply-cs2d-host-patch.mjs";

const cleanBase = {
  head: CS2D_PIN,
  dirtyPaths: [],
  diffCheckPassed: true,
  patchesExactlyApplied: false,
  markerErrors: [],
};

describe("cs2d patched checkout seam", () => {
  it("makes localhost reuse the validated dirty-checkout path explicitly", () => {
    const source = readFileSync(new URL("./run-localhost.mjs", import.meta.url), "utf8");
    expect(source).toMatch(/spawnSync\(process\.execPath, \[patcher, ['"]--reuse-patched-checkout['"]\]/);
  });

  it("keeps a clean pinned checkout on the clone/apply path", () => {
    expect(classifyPatchedCheckout(cleanBase)).toBe(CS2D_REUSE_DECISIONS.APPLY_PATCHES);
  });

  it("recognizes an exact applied checkout", () => {
    expect(
      classifyPatchedCheckout({
        ...cleanBase,
        dirtyPaths: ["apps/app/src/viewer/player/hostBridge.ts"],
        patchesExactlyApplied: true,
      }),
    ).toBe(CS2D_REUSE_DECISIONS.EXACT_APPLIED);
  });

  it("reuses only a controlled dirty superset with the required markers", () => {
    expect(
      classifyPatchedCheckout({
        ...cleanBase,
        dirtyPaths: [
          "apps/app/src/viewer/player/hostBridge.ts",
          "apps/app/public/models/cs-net/win-rate.fp16.onnx",
        ],
        patchesExactlyApplied: false,
      }),
    ).toBe(CS2D_REUSE_DECISIONS.CONTROLLED_SUPERSET);
    expect(isControlledDirtyPath("apps/app/public/models/cs-net/win-rate.fp16.onnx")).toBe(true);
    expect(isControlledDirtyPath("apps/app/src/unrelated.ts")).toBe(false);
  });

  it("rejects wrong pins, failed diff checks, missing markers, and arbitrary dirty paths", () => {
    expect(() => classifyPatchedCheckout({ ...cleanBase, head: "wrong-pin" })).toThrow(/commit mismatch/);
    expect(() => classifyPatchedCheckout({ ...cleanBase, diffCheckPassed: false })).toThrow(/diff --check/);
    expect(() =>
      classifyPatchedCheckout({
        ...cleanBase,
        dirtyPaths: ["apps/app/src/viewer/player/hostBridge.ts"],
        markerErrors: ["host bridge channel: missing marker"],
      }),
    ).toThrow(/markers failed/);
    expect(() =>
      classifyPatchedCheckout({
        ...cleanBase,
        dirtyPaths: ["apps/app/src/unrelated.ts"],
      }),
    ).toThrow(/unapproved paths/);
  });
});

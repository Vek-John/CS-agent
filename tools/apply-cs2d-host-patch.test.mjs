import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  CS2D_PIN,
  CS2D_PATCH_FILES,
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
  it("keeps managed Demo support in the controlled patch stack", () => {
    expect(CS2D_PATCH_FILES.at(-1)).toMatch(/0006-managed-demo-load-races\.patch$/);
    const patch = CS2D_PATCH_FILES.map((file) => readFileSync(file, "utf8")).join("\n");
    expect(patch).toMatch(/DEMO_IMPORT_REQUESTED/);
    expect(patch).toMatch(/await uploadManagedDemo[\s\S]*await parser\.parse\(pending\.file\)/);
    expect(patch).toMatch(/await parseManagedFile\(pending\.file[\s\S]*await finalizeManagedDemo\(result, 'READY'\)[\s\S]*DEMO_IMPORT_SUCCEEDED[\s\S]*emitPlaybackEvent\(replayReady\)/);
    expect(patch).toMatch(/finalizeManagedDemo\(result, 'CORRUPT'\)/);
    expect(patch).toMatch(/INVALID_DEMO_EXTENSION[\s\S]*EMPTY_DEMO/);
    expect(patch).toMatch(/managedSource\.value\?\.mode === 'RESTORE'/);
    expect(patch).toMatch(/while \(!hostStageReady\.value[\s\S]*?emitSelected\(\)/);
    expect(patch).toMatch(/stopHostBridge = listenForPlaybackCommands[\s\S]*?emit\('host-ready'\)/);
    expect(patch).toMatch(/Authorization.*Bearer \$\{command\.capabilityToken\}/);
    expect(patch).toMatch(/result\.originalFilename\.length[\s\S]*?result\.byteSize === file\.size/);
    expect(patch).not.toMatch(/result\.originalFilename === file\.name/);
    expect(patch).toMatch(/pause: \(\) => \{[\s\S]*?emitHostPlaybackState\(\)/);
    expect(patch).toMatch(/seekCanonicalTick: \(tick\) => \{[\s\S]*?emitHostPlaybackState\(\)/);
    expect(patch).toMatch(/stopHostBridge = listenForPlaybackCommands[\s\S]*?void nextTick\(emitHostPlaybackState\)/);
    expect(patch).not.toMatch(/^\+\s*(?:const|let|await|return).*file\.arrayBuffer\(\)/m);
    expect(patch).toMatch(/managedLoadAbort\?\.abort\(\)/);
    expect(patch).toMatch(/managedParseTail[\s\S]*assertManagedLoadCurrent\(generation\)/);
    expect(patch).toMatch(/if \(managedLibraryMode\.value\) return/);
    expect(patch).toMatch(/requestId: replay\.managedSource\.requestId/);
  });
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

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
    expect(CS2D_PATCH_FILES[5]).toMatch(/0006-managed-demo-load-races\.patch$/);
    expect(CS2D_PATCH_FILES[6]).toMatch(/0007-cs2d-shot-actor\.patch$/);
    expect(CS2D_PATCH_FILES[7]).toMatch(/0008-teaching-playback\.patch$/);
    expect(CS2D_PATCH_FILES[8]).toMatch(/0009-public-round-clock\.patch$/);
    expect(CS2D_PATCH_FILES[9]).toMatch(/0010-self-hurt-events\.patch$/);
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
  it("adds current shot identity without replacing the previous hurt patch", () => {
    expect(CS2D_PATCH_FILES[10]).toMatch(/0011-current-shot-identity\.patch$/);
    const patch = readFileSync(CS2D_PATCH_FILES[10], "utf8");
    expect(patch).toContain('verified_event_pawn(ctx, ev_i32(ge, "userid_pawn"))');
    expect(patch).toContain('cs-coach.hurt-events.v1.shot-identity.v2');
  });
  it("preserves only event-resolved optional shot actors in the parser patch", () => {
    const patch = readFileSync(CS2D_PATCH_FILES.find((path) => path.endsWith("0007-cs2d-shot-actor.patch")), "utf8");
    expect(patch).toContain("steam_from_pawn_handle(self, ctx, ph)");
    expect(patch).toContain("shooter_steam_id: shooter.clone()");
    expect(patch).toContain("shooter_steam_id: Option<String>");
    expect(patch).toContain("shooterSteamId?: string | null");
    expect(patch).toContain("shot_actor_serializes_known_and_explicit_unknown_without_other_fields");
    expect(patch).not.toMatch(/spotted|REPEEK|RECONTACT|nearest/);
    for (const path of ["packages/parser/src/collector.rs", "packages/parser/src/schema.rs", "packages/parser/src/assemble.rs", "packages/replay-core/src/schema.ts", "apps/app/src/viewer/parser/demo_parser_bg.wasm"]) {
      expect(isControlledDirtyPath(path)).toBe(true);
    }
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

it("registers raw-wire clip consumption without a signed inverse", () => {
  const patch = readFileSync(CS2D_PATCH_FILES[11], "utf8");
  expect(patch).toContain("sample_weapon_ammo");
  expect(patch).toContain("checked_sub(1)");
  expect(patch).not.toContain("decoded >> 31");
});

it("registers bounded prior-tick sampling after the raw-wire decoder patch", () => {
  expect(CS2D_PATCH_FILES[12]).toMatch(/0013-prior-tick-ammo-cache\.patch$/);
  const patch = readFileSync(CS2D_PATCH_FILES[12], "utf8");
  expect(patch).toContain("ammo_cache.begin_tick");
  expect(patch).toContain("ammo_cache.capture_end");
  expect(patch).toContain("ammo_sampling_version: 2");
});

it("registers bomb owner and plant geometry from one verified event pawn without removing public events", () => {
  expect(CS2D_PATCH_FILES[13]).toMatch(/0014-bomb-identity\.patch$/);
  const patch = readFileSync(CS2D_PATCH_FILES[13], "utf8");
  const additions = patch.split("\n").filter(line => line.startsWith("+") && !line.startsWith("+++")).join("\n");
  expect(additions.match(/verified_event_pawn\(ctx, ev_i32\(ge, "userid_pawn"\)\)/g)).toHaveLength(1);
  expect(additions).toContain("resolved.as_ref().and_then(|(_, owner)| owner.clone())");
  expect(additions).toContain("if let Some((p, _)) = resolved");
  expect(additions).toContain("ammo-clip.v2.bomb-identity.v1");
  expect(additions).not.toMatch(/steam_from_pawn_handle|get_by_handle|m_hThrower|return;/);
  expect(patch).toContain("self.defuse_ends.push((tick, true))");
  expect(patch).toContain("self.events.push(RawEvent::Bomb");
});

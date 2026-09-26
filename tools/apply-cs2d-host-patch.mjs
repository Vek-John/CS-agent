import { buildParserWasm, preflightParserToolchain, testParserNative } from './cs2d-parser-toolchain.mjs'
import { existsSync, readFileSync } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { spawnSync } from 'node:child_process'

export const CS2D_PIN = 'dbbe698c9b9c91f9a14cecea92374b4114bf60ec'
const REPOSITORY = 'https://github.com/zenojunior/cs2d.git'
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
export const CS2D_PATCH_FILES = Object.freeze([
  resolve(root, 'tools/cs2d-host/patches/0001-cs2d-playback-host.patch'),
  resolve(root, 'tools/cs2d-host/patches/0002-cs2d-cloudflare-base.patch'),
  resolve(root, 'tools/cs2d-host/patches/0003-cs2d-stage2-map-focus.patch'),
  resolve(root, 'tools/cs2d-host/patches/0004-cs2d-session-recovery-player-select.patch'),
  resolve(root, 'tools/cs2d-host/patches/0005-managed-demo-library.patch'),
  resolve(root, 'tools/cs2d-host/patches/0006-managed-demo-load-races.patch'),
  resolve(root, 'tools/cs2d-host/patches/0007-cs2d-shot-actor.patch'),
  resolve(root, 'tools/cs2d-host/patches/0008-teaching-playback.patch'),
  resolve(root, 'tools/cs2d-host/patches/0009-public-round-clock.patch'),
  resolve(root, 'tools/cs2d-host/patches/0010-self-hurt-events.patch'),
  resolve(root, 'tools/cs2d-host/patches/0011-current-shot-identity.patch'),
  resolve(root, 'tools/cs2d-host/patches/0012-active-weapon-ammo.patch'),
  resolve(root, 'tools/cs2d-host/patches/0013-prior-tick-ammo-cache.patch'),
  resolve(root, 'tools/cs2d-host/patches/0014-bomb-identity.patch'),
  resolve(root, 'tools/cs2d-host/patches/0015-death-identity.patch'),
  resolve(root, 'tools/cs2d-host/patches/0016-frame-pawn-identity.patch'),
  resolve(root, 'tools/cs2d-host/patches/0017-active-weapon-identity.patch'),
  resolve(root, 'tools/cs2d-host/patches/0018-grenade-inventory-certainty.patch'),
  resolve(root, 'tools/cs2d-host/patches/0019-primary-inventory-identity.patch'),
  resolve(root, 'tools/cs2d-host/patches/0020-demo-picker-reselection.patch'),
  resolve(root, 'tools/cs2d-host/patches/0021-managed-replay-reuse.patch'),
  resolve(root, 'tools/cs2d-host/patches/0022-release-parser-worker.patch'),
  resolve(root, 'tools/cs2d-host/patches/0023-demo-read-failure.patch'),
  resolve(root, 'tools/cs2d-host/patches/0024-validation-failure-feedback.patch'),
  resolve(root, 'tools/cs2d-host/patches/0025-validation-deadline.patch'),
  resolve(root, 'tools/cs2d-host/patches/0026-parser-cancellation.patch'),
  resolve(root, 'tools/cs2d-host/patches/0027-parser-start-failure.patch'),
  resolve(root, 'tools/cs2d-host/patches/0028-win-rate-worker-owner.patch'),
])

export const CS2D_REUSE_DECISIONS = Object.freeze({
  APPLY_PATCHES: 'APPLY_PATCHES',
  EXACT_APPLIED: 'EXACT_APPLIED',
  CONTROLLED_SUPERSET: 'CONTROLLED_SUPERSET',
})

// This is the only dirty-tree set accepted by --reuse-patched-checkout. It
// covers the pinned patch stack plus the explicitly generated model assets that
// sync-cs-net-assets.mjs owns. A different dirty path is never guessed safe.
const CONTROLLED_EXACT_PATHS = new Set([
  'apps/app/package.json',
  'apps/app/src/app/router.ts',
  'apps/app/src/shell/PublicShell.vue',
  'apps/app/src/style.css',
  'apps/app/src/viewer/DemoAnalyzerView.vue',
  'apps/app/src/viewer/ingest/demoParser.worker.ts',
  'apps/app/src/viewer/ingest/useDemoParser.ts',
  'apps/app/src/viewer/parser/demo_parser_bg.wasm',
  'apps/app/src/viewer/player/ViewerMap.vue',
  'apps/app/src/viewer/player/ViewerRoster.vue',
  'apps/app/src/viewer/player/ViewerStage.vue',
  'apps/app/src/viewer/player/useMapCamera.ts',
  'apps/app/src/viewer/player/useReplay.ts',
  'apps/app/src/viewer/domain/rounds.ts',
  'apps/app/src/viewer/vite.config.ts',
  'apps/app/vite.config.ts',
  'packages/parser/Cargo.toml',
  'packages/parser/Cargo.lock',
  'packages/parser/src/weapons.rs',
  'packages/parser/src/weapon_ammo.rs',
  'packages/parser/src/assemble.rs',
  'packages/parser/src/collector.rs',
  'packages/parser/src/props.rs',
  'packages/parser/src/lib.rs',
  'packages/parser/src/schema.rs',
  'packages/replay-core/src/schema.ts',
  'pnpm-lock.yaml',
  'apps/app/src/viewer/analysis/csNetWinRate.worker.ts',
  'apps/app/src/viewer/player/hostBridge.ts',
  'apps/app/src/viewer/player/teachingPlayback.ts',
])

const CONTROLLED_PATH_PREFIXES = [
  'apps/app/public/models/cs-net/',
  'apps/app/public/models/cs-net-smoke/',
]

const CONTROLLED_ORT_ASSETS = new Set([
  'apps/app/public/ort-wasm-simd-threaded.mjs',
  'apps/app/public/ort-wasm-simd-threaded.wasm',
  'apps/app/public/ort-wasm-simd-threaded.asyncify.mjs',
  'apps/app/public/ort-wasm-simd-threaded.asyncify.wasm',
])

const REQUIRED_MARKERS = [
  { name: 'primary weapon identity version', primaryInventory: true, path: 'packages/parser/src/lib.rs', pattern: /grenade-inventory\.v1\.primary-weapon\.v1/ },
  { name: 'primary validated inventory prefix', primaryInventory: true, path: 'packages/parser/src/weapons.rs', pattern: /let labels = match current_inventory_labels\(ctx, pawn\)/ },
  { name: 'grenade inventory version', grenadeInventory: true, path: 'packages/parser/src/lib.rs', pattern: /active-weapon-identity\.v1\.grenade-inventory\.v1/ },
  { name: 'optional verified inventory', grenadeInventory: true, path: 'packages/parser/src/schema.rs', pattern: /grenades: Option<Vec<String>>/ },
  { name: 'sample inventory version', grenadeInventory: true, path: 'packages/parser/src/collector.rs', pattern: /grenade_inventory_version: 1/ },
  { name: 'active weapon identity version', activeWeaponIdentity: true, path: 'packages/parser/src/lib.rs', pattern: /frame-identity\.v1\.active-weapon-identity\.v1/ },
  { name: 'viewer knife round known weapons', activeWeaponIdentity: true, path: 'apps/app/src/viewer/domain/rounds.ts', pattern: /f\.players\.length > 0 && f\.players\.every\(\(p\) => p\.weapon === 'Faca'\)/ },
  { name: 'active weapon current serial', activeWeaponIdentity: true, path: 'packages/parser/src/weapons.rs', pattern: /weapon\.serial\(\) & 0x3ff/ },
  { name: 'frame identity version', frameIdentity: true, path: 'packages/parser/src/lib.rs', pattern: /death-identity\.v1\.frame-identity\.v1/ },
  { name: 'verified sampled player pawn', frameIdentity: true, path: 'packages/parser/src/collector.rs', pattern: /let pawn = match verified_controller_pawn\(ctx, ctrl\)/ },
  { name: 'complete identity respawn guard', frameIdentity: true, path: 'packages/parser/src/assemble.rs', pattern: /&& f\.identity_complete/ },
  { name: 'death identity version', deathIdentity: true, path: 'packages/parser/src/lib.rs', pattern: /bomb-identity\.v1\.death-identity\.v1/ },
  { name: 'current victim identity and geometry', deathIdentity: true, path: 'packages/parser/src/collector.rs', pattern: /let \(p, victim\) = match verified_event_pawn\(ctx, ev_i32\(ge, "userid_pawn"\)\)/ },
  { name: 'bomb identity version', bombIdentity: true, path: 'packages/parser/src/lib.rs', pattern: /ammo-clip\.v2\.bomb-identity\.v1/ },
  { name: 'current bomb identity', bombIdentity: true, path: 'packages/parser/src/collector.rs', pattern: /let resolved = verified_event_pawn\(ctx, ev_i32\(ge, "userid_pawn"\)\);[\s\S]*?let player = resolved\.as_ref\(\)\.and_then/ },
  { name: 'current shot identity', shotIdentity: true, path: 'packages/parser/src/collector.rs', pattern: /if let Some\(\(p, shooter\)\) = verified_event_pawn\(ctx, ev_i32\(ge, "userid_pawn"\)\)/ },
  { name: 'shot identity version', shotIdentity: true, path: 'packages/parser/src/lib.rs', pattern: /hurt-events\.v1\.shot-identity\.v2/ },
  { name: 'separate player hurt source', hurtEvents: true, path: 'packages/parser/src/collector.rs', pattern: /hurt_victim_steam\(ctx, ev_i32\(ge, "userid_pawn"\)\)/ },
  { name: 'hurt contract version', hurtEvents: true, path: 'packages/parser/src/lib.rs', pattern: /cs-coach\.hurt-events\.v1/ },
  { name: 'end-of-tick public round clock source', roundClock: true, path: 'packages/parser/src/collector.rs', pattern: /fn on_clock_tick_end/ },
  { name: 'optional frame clock contract', roundClock: true, path: 'packages/replay-core/src/schema.ts', pattern: /clock\?: RoundClockSample/ },
  {
    name: 'identity-bound teaching playback control',
    teachingPlayback: true,
    path: 'apps/app/src/viewer/player/teachingPlayback.ts',
    pattern: /export function controlTeachingPlayback/,
  },
  {
    name: 'teaching playback viewer bridge handler',
    teachingPlayback: true,
    path: 'apps/app/src/viewer/player/ViewerStage.vue',
    pattern: /teachingPlayback: \(command\) =>/,
  },
  {
    name: 'event-resolved shot actor',
    shotActor: true,
    path: 'packages/parser/src/collector.rs',
    pattern: /self\.shots\.push\(\(tick, x, y, round1\(pawn_yaw\(p\)\), shooter\)\)/,
  },
  {
    name: 'shot actor assembly',
    shotActor: true,
    path: 'packages/parser/src/assemble.rs',
    pattern: /shooter_steam_id: shooter\.clone\(\)/,
  },
  {
    name: 'shot actor schema',
    shotActor: true,
    path: 'packages/parser/src/schema.rs',
    pattern: /Shot \{[^}]*shooter_steam_id: Option<String>/,
  },
  {
    name: 'shot actor replay contract',
    shotActor: true,
    path: 'packages/replay-core/src/schema.ts',
    pattern: /shooterSteamId\?: string \| null/,
  },
  {
    name: 'cs2d host bridge channel',
    path: 'apps/app/src/viewer/player/hostBridge.ts',
    pattern: /PLAYBACK_BRIDGE_CHANNEL\s*=\s*['"]cs2d-playback-bridge\.v1/,
  },
  {
    name: 'cs2d host bridge event emitter',
    path: 'apps/app/src/viewer/player/hostBridge.ts',
    pattern: /export function emitPlaybackEvent\s*\(/,
  },
  {
    name: 'cs2d replay-ready bridge event',
    path: 'apps/app/src/viewer/player/hostBridge.ts',
    pattern: /export function replayReadyMessage\s*\(/,
  },
  {
    name: 'stage2 teaching bridge command',
    path: 'apps/app/src/viewer/player/hostBridge.ts',
    pattern: /focusMapEvidence/,
  },
  {
    name: 'strict recovery player selection command',
    path: 'apps/app/src/viewer/player/hostBridge.ts',
    pattern: /type:\s*['"]selectPlayer['"]/,
  },
  {
    name: 'managed Demo bridge command',
    managedLibrary: true,
    path: 'apps/app/src/viewer/player/hostBridge.ts',
    pattern: /type:\s*['"]loadManagedDemo['"]/,
  },
  {
    name: 'header-only managed Demo import',
    managedLibrary: true,
    path: 'apps/app/src/viewer/DemoAnalyzerView.vue',
    pattern: /setRequestHeader\(['"]Authorization['"],\s*`Bearer \$\{capabilityToken\}`\)/,
  },
  {
    name: 'managed Demo import-before-parse gate',
    managedLibrary: true,
    path: 'apps/app/src/viewer/DemoAnalyzerView.vue',
    pattern: /await uploadManagedDemo\([\s\S]*?await parseManagedFile\(pending\.file/,
  },
  {
    name: 'managed Demo playback-only restore',
    managedLibrary: true,
    path: 'apps/app/src/viewer/DemoAnalyzerView.vue',
    pattern: /managedSource\.value\?\.mode === ['"]RESTORE['"][\s\S]*?return/,
  },
  {
    name: 'managed Demo restore bridge mount acknowledgement',
    managedLibrary: true,
    path: 'apps/app/src/viewer/DemoAnalyzerView.vue',
    pattern: /while \(!hostStageReady\.value[\s\S]*?emitSelected\(\)[\s\S]*?return/,
  },
  {
    name: 'managed Demo serialized latest-wins parse',
    managedLibrary: true,
    path: 'apps/app/src/viewer/DemoAnalyzerView.vue',
    pattern: /managedLoadAbort\?\.abort\(\)[\s\S]*?managedParseTail[\s\S]*?assertManagedLoadCurrent\(generation\)/,
  },
  {
    name: 'managed Demo parser validation before replay exposure',
    managedLibrary: true,
    path: 'apps/app/src/viewer/DemoAnalyzerView.vue',
    pattern: /await finalizeManagedDemo\(result, ['"]READY['"]\)[\s\S]*?DEMO_IMPORT_SUCCEEDED[\s\S]*?emitPlaybackEvent\(replayReady\)/,
  },
  {
    name: 'managed Demo watcher intermediate-result suppression',
    managedLibrary: true,
    path: 'apps/app/src/viewer/DemoAnalyzerView.vue',
    pattern: /watch\([\s\S]*?parser\.replay\.value[\s\S]*?if \(managedLibraryMode\.value\) return/,
  },
  {
    name: 'managed Replay exact request identity',
    managedLibrary: true,
    path: 'apps/app/src/viewer/player/hostBridge.ts',
    pattern: /requestId: replay\.managedSource\.requestId[\s\S]*?sourceKind: ['"]MANAGED_LIBRARY['"]/,
  },
  {
    name: 'ViewerStage host bridge ready event',
    managedLibrary: true,
    path: 'apps/app/src/viewer/player/ViewerStage.vue',
    pattern: /stopHostBridge = listenForPlaybackCommands[\s\S]*?emit\(['"]host-ready['"]\)/,
  },
  {
    name: 'managed Demo IndexedDB bypass',
    managedLibrary: true,
    path: 'apps/app/src/viewer/DemoAnalyzerView.vue',
    pattern: /(?:await parser\.parse\(file\)|if \(await parser\.parse\(file\) === false\) return)\s*\n\s*if \(managedLibraryMode\.value\) return\s*\n\s*\/\/ New parse done:\s*save to local history/,
  },
  {
    name: 'content-addressed local analysis identity',
    path: 'apps/app/src/viewer/DemoAnalyzerView.vue',
    pattern: /demoId:\s*parser\.demoContentHash\.value[\s\S]*?`cs2d-\$\{parser\.demoContentHash\.value\}`/,
  },
  {
    name: 'stage2 parser content hash',
    path: 'apps/app/src/viewer/ingest/demoParser.worker.ts',
    pattern: /demoContentHash|sha256Hex/,
  },
  {
    name: 'stage2 parser hash state',
    path: 'apps/app/src/viewer/ingest/useDemoParser.ts',
    pattern: /demoContentHash/,
  },
  {
    name: 'stage2 map evidence marker',
    path: 'apps/app/src/viewer/player/ViewerMap.vue',
    pattern: /focusWorldLabel/,
  },
  {
    name: 'host-mode shell seam',
    path: 'apps/app/src/shell/PublicShell.vue',
    pattern: /const hostMode\s*=\s*computed\(\(\)\s*=>\s*route\.query\.host\s*===\s*['"]1['"]\)/,
  },
  {
    name: 'host-mode analyzer seam',
    path: 'apps/app/src/viewer/DemoAnalyzerView.vue',
    pattern: /const hostMode\s*=\s*computed\(\(\)\s*=>\s*route\.query\.host\s*===\s*['"]1['"]\)/,
  },
  {
    name: 'host-mode viewer stage seam',
    path: 'apps/app/src/viewer/player/ViewerStage.vue',
    pattern: /hostMode\??:\s*boolean/,
  },
  {
    name: 'host-mode roster seam',
    path: 'apps/app/src/viewer/player/ViewerRoster.vue',
    pattern: /hostMode\??:\s*boolean/,
  },
  {
    name: 'host-mode map seam',
    path: 'apps/app/src/viewer/player/ViewerMap.vue',
    pattern: /hostTargetSteamId\??:\s*string\s*\|\s*null/,
  },
  {
    name: 'canonical tick playback seam',
    path: 'apps/app/src/viewer/player/useReplay.ts',
    pattern: /function seekCanonicalTick\s*\(/,
  },
  {
    name: 'cloudflare router base',
    path: 'apps/app/src/app/router.ts',
    pattern: /createWebHistory\(import\.meta\.env\.BASE_URL\)/,
  },
  {
    name: 'cloudflare public base',
    path: 'apps/app/vite.config.ts',
    pattern: /const publicBase\s*=\s*process\.env\.CS2D_BASE_PATH\s*\|\|\s*['"]\/['"]$/m,
  },
  {
    name: 'cloudflare base config',
    path: 'apps/app/vite.config.ts',
    pattern: /base:\s*publicBase/,
  },
  {
    name: 'cross-origin isolation plugin',
    path: 'apps/app/vite.config.ts',
    pattern: /cs-coach-cross-origin-isolation/,
  },
  {
    name: 'parser place token',
    path: 'packages/parser/src/schema.rs',
    pattern: /last_place_name\s*:/,
  },
  {
    name: 'replay place token',
    path: 'packages/replay-core/src/schema.ts',
    pattern: /lastPlaceName\??:/,
  },
]

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? root,
    encoding: 'utf8',
    env: options.env ?? process.env,
    stdio: options.capture ? 'pipe' : 'inherit',
  })
  if (result.status !== 0 && !options.allowFailure) {
    const detail = [result.stdout, result.stderr].filter(Boolean).join('\n').trim()
    throw new Error(`${command} ${args.join(' ')} failed${detail ? `:\n${detail}` : ''}`)
  }
  return result
}

function patchName(patch) {
  return patch.split('/').at(-1)
}

function patchReverseApplies(patch, upstream) {
  return run('git', ['apply', '--reverse', '--check', patch], {
    cwd: upstream,
    capture: true,
    allowFailure: true,
  }).status === 0
}

function dirtyPaths(upstream) {
  const status = run('git', ['status', '--porcelain=v1', '--untracked-files=all'], {
    cwd: upstream,
    capture: true,
  }).stdout
  return status
    .split('\n')
    .map((line) => line.trimEnd())
    .filter(Boolean)
    .map((line) => {
      if (line.length < 4 || line.slice(2, 3) !== ' ') {
        throw new Error(`Unable to parse cs2d git status line: ${line}`)
      }
      const path = line.slice(3)
      if (path.includes(' -> ')) {
        throw new Error(`Renamed cs2d paths are not reusable: ${path}`)
      }
      return path
    })
}

function diffCheck(upstream) {
  const result = run('git', ['diff', '--check'], {
    cwd: upstream,
    capture: true,
    allowFailure: true,
  })
  return {
    passed: result.status === 0,
    detail: [result.stdout, result.stderr].filter(Boolean).join('\n').trim(),
  }
}

function markerErrors(upstream, includeManagedLibrary = true, includeShotActor = true, includeTeachingPlayback = true, includeRoundClock = true, includeHurtEvents = true, includeShotIdentity = true, includeBombIdentity = true, includeDeathIdentity = true, includeFrameIdentity = true, includeActiveWeaponIdentity = true, includeGrenadeInventory = true, includePrimaryInventory = true) {
  const errors = []
  for (const marker of REQUIRED_MARKERS) {
    if (!includeManagedLibrary && marker.managedLibrary) continue
    if (!includeShotActor && marker.shotActor) continue
    if (!includeTeachingPlayback && marker.teachingPlayback) continue
    if (!includeRoundClock && marker.roundClock) continue
    if (!includeHurtEvents && marker.hurtEvents) continue
    if (!includeShotIdentity && marker.shotIdentity) continue
    if (!includeBombIdentity && marker.bombIdentity) continue
    if (!includeDeathIdentity && marker.deathIdentity) continue
    if (!includeFrameIdentity && marker.frameIdentity) continue
    if (!includeActiveWeaponIdentity && marker.activeWeaponIdentity) continue
    if (!includeGrenadeInventory && marker.grenadeInventory) continue
    if (!includePrimaryInventory && marker.primaryInventory) continue
    const file = resolve(upstream, marker.path)
    if (!existsSync(file)) {
      errors.push(`${marker.name}: missing ${marker.path}`)
      continue
    }
    const source = readFileSync(file, 'utf8')
    if (!marker.pattern.test(source)) {
      errors.push(`${marker.name}: missing marker in ${marker.path}`)
    }
  }
  return errors
}

export function isControlledDirtyPath(path) {
  return (
    CONTROLLED_EXACT_PATHS.has(path) ||
    CONTROLLED_ORT_ASSETS.has(path) ||
    CONTROLLED_PATH_PREFIXES.some((prefix) => path.startsWith(prefix))
  )
}

export function classifyPatchedCheckout({
  head,
  dirtyPaths: paths,
  diffCheckPassed,
  patchesExactlyApplied,
  markerErrors: errors = [],
}) {
  if (head !== CS2D_PIN) {
    throw new Error(`cs2d commit mismatch: expected ${CS2D_PIN}, received ${head || '<empty>'}`)
  }
  if (!diffCheckPassed) {
    throw new Error('cs2d dirty diff failed git diff --check; refusing reuse')
  }
  const unexpectedPaths = paths.filter((path) => !isControlledDirtyPath(path))
  if (unexpectedPaths.length > 0) {
    throw new Error(`cs2d dirty checkout has unapproved paths: ${unexpectedPaths.join(', ')}`)
  }
  if (paths.length === 0) {
    return patchesExactlyApplied
      ? CS2D_REUSE_DECISIONS.EXACT_APPLIED
      : CS2D_REUSE_DECISIONS.APPLY_PATCHES
  }
  if (errors.length > 0) {
    throw new Error(`cs2d patched checkout markers failed:\n${errors.join('\n')}`)
  }
  return patchesExactlyApplied
    ? CS2D_REUSE_DECISIONS.EXACT_APPLIED
    : CS2D_REUSE_DECISIONS.CONTROLLED_SUPERSET
}

function inspectPatchedCheckout(upstream) {
  const head = run('git', ['rev-parse', 'HEAD'], { cwd: upstream, capture: true }).stdout.trim()
  const paths = dirtyPaths(upstream)
  const check = diffCheck(upstream)
  const reverseStates = CS2D_PATCH_FILES.map((patch) => patchReverseApplies(patch, upstream))
  const patchesExactlyApplied = reverseStates.every(Boolean)
  // A reusable checkout may be a validated controlled superset (for example,
  // generated model assets make older reverse checks intentionally inexact).
  // Only the explicitly supported tail upgrades can advance that checkout,
  // and only when each applies cleanly on top of all other validated markers.
  // Fixed positions correspond to 0006 through 0028; appending a patch must not retarget an older upgrade.
  const managedLibraryPatch = CS2D_PATCH_FILES[5]
  const pendingManagedLibraryPatch = !reverseStates[5] && Boolean(managedLibraryPatch) &&
    run('git', ['apply', '--check', managedLibraryPatch], {
      cwd: upstream,
      capture: true,
      allowFailure: true,
    }).status === 0
  const shotActorPatch = CS2D_PATCH_FILES[6]
  const pendingShotActorPatch = !reverseStates[6] && Boolean(shotActorPatch) &&
    run('git', ['apply', '--check', shotActorPatch], {
      cwd: upstream,
      capture: true,
      allowFailure: true,
    }).status === 0
  const teachingPlaybackPatch = CS2D_PATCH_FILES[7]
  const pendingTeachingPlaybackPatch = !reverseStates[7] && Boolean(teachingPlaybackPatch) &&
    run('git', ['apply', '--check', teachingPlaybackPatch], {
      cwd: upstream,
      capture: true,
      allowFailure: true,
    }).status === 0
  const roundClockPatch = CS2D_PATCH_FILES[8]
  const pendingRoundClockPatch = !reverseStates[8] && Boolean(roundClockPatch) &&
    run('git', ['apply', '--check', roundClockPatch], { cwd: upstream, capture: true, allowFailure: true }).status === 0
  const hurtEventsPatch = CS2D_PATCH_FILES[9]
  const pendingHurtEventsPatch = !reverseStates[9] && Boolean(hurtEventsPatch) &&
    run('git', ['apply', '--check', hurtEventsPatch], { cwd: upstream, capture: true, allowFailure: true }).status === 0
  const shotIdentityPatch = CS2D_PATCH_FILES[10]
  const pendingShotIdentityPatch = !reverseStates[10] && Boolean(shotIdentityPatch) &&
    run('git', ['apply', '--check', shotIdentityPatch], { cwd: upstream, capture: true, allowFailure: true }).status === 0
  const ammoPatch = CS2D_PATCH_FILES[11]
  const pendingAmmoPatch = !reverseStates[11] && Boolean(ammoPatch) &&
    run('git', ['apply', '--check', ammoPatch], { cwd: upstream, capture: true, allowFailure: true }).status === 0
  const cachePatch = CS2D_PATCH_FILES[12]
  const pendingAmmoCachePatch = !reverseStates[12] &&
    run('git', ['apply', '--check', cachePatch], { cwd: upstream, capture: true, allowFailure: true }).status === 0
  const bombIdentityPatch = CS2D_PATCH_FILES[13]
  const pendingBombIdentityPatch = !reverseStates[13] && (pendingAmmoCachePatch ||
    run('git', ['apply', '--check', bombIdentityPatch], { cwd: upstream, capture: true, allowFailure: true }).status === 0)
  const deathIdentityPatch = CS2D_PATCH_FILES[14]
  const pendingDeathIdentityPatch = !reverseStates[14] && (pendingBombIdentityPatch ||
    run('git', ['apply', '--check', deathIdentityPatch], { cwd: upstream, capture: true, allowFailure: true }).status === 0)
  const frameIdentityPatch = CS2D_PATCH_FILES[15]
  const pendingFrameIdentityPatch = !reverseStates[15] && (pendingDeathIdentityPatch ||
    run('git', ['apply', '--check', frameIdentityPatch], { cwd: upstream, capture: true, allowFailure: true }).status === 0)
  const activeWeaponIdentityPatch = CS2D_PATCH_FILES[16]
  const pendingActiveWeaponIdentityPatch = !reverseStates[16] && (pendingFrameIdentityPatch ||
    run('git', ['apply', '--check', activeWeaponIdentityPatch], { cwd: upstream, capture: true, allowFailure: true }).status === 0)
  const grenadeInventoryPatch = CS2D_PATCH_FILES[17]
  const pendingGrenadeInventoryPatch = !reverseStates[17] && (pendingActiveWeaponIdentityPatch ||
    run('git', ['apply', '--check', grenadeInventoryPatch], { cwd: upstream, capture: true, allowFailure: true }).status === 0)
  const primaryInventoryPatch = CS2D_PATCH_FILES[18]
  const pendingPrimaryInventoryPatch = !reverseStates[18] && (pendingGrenadeInventoryPatch ||
    run('git', ['apply', '--check', primaryInventoryPatch], { cwd: upstream, capture: true, allowFailure: true }).status === 0)
  const demoPickerPatch = CS2D_PATCH_FILES[19]
  const pendingDemoPickerPatch = !reverseStates[19] &&
    run('git', ['apply', '--check', demoPickerPatch], { cwd: upstream, capture: true, allowFailure: true }).status === 0
  if (paths.length > 0 && !reverseStates[19] && !pendingDemoPickerPatch) throw new Error('Demo picker patch is neither exactly applied nor cleanly applicable')
  const replayReusePatch = CS2D_PATCH_FILES[20]
  const pendingReplayReusePatch = !reverseStates[20] &&
    run('git', ['apply', '--check', replayReusePatch], { cwd: upstream, capture: true, allowFailure: true }).status === 0
  if (paths.length > 0 && !reverseStates[20] && !pendingReplayReusePatch) throw new Error('Managed replay reuse patch is neither exactly applied nor cleanly applicable')
  const parserReleasePatch = CS2D_PATCH_FILES[21]
  const pendingParserReleasePatch = !reverseStates[21] &&
    run('git', ['apply', '--check', parserReleasePatch], { cwd: upstream, capture: true, allowFailure: true }).status === 0
  if (paths.length > 0 && !reverseStates[21] && !pendingParserReleasePatch && !reverseStates[25] && !reverseStates[26]) throw new Error('Parser worker release patch is neither exactly applied nor cleanly applicable')
  const readFailurePatch = CS2D_PATCH_FILES[22]
  const pendingReadFailurePatch = !reverseStates[22] &&
    run('git', ['apply', '--check', readFailurePatch], { cwd: upstream, capture: true, allowFailure: true }).status === 0
  if (paths.length > 0 && !reverseStates[22] && !pendingReadFailurePatch && !reverseStates[25] && !reverseStates[26]) throw new Error('Demo read failure patch is neither exactly applied nor cleanly applicable')
  const validationFeedbackPatch = CS2D_PATCH_FILES[23]
  const pendingValidationFeedbackPatch = !reverseStates[23] &&
    run('git', ['apply', '--check', validationFeedbackPatch], { cwd: upstream, capture: true, allowFailure: true }).status === 0
  if (paths.length > 0 && !reverseStates[23] && !pendingValidationFeedbackPatch && !reverseStates[24]) throw new Error('Validation feedback patch is neither exactly applied nor cleanly applicable')
  const validationDeadlinePatch = CS2D_PATCH_FILES[24]
  const pendingValidationDeadlinePatch = !reverseStates[24] &&
    run('git', ['apply', '--check', validationDeadlinePatch], { cwd: upstream, capture: true, allowFailure: true }).status === 0
  if (paths.length > 0 && !reverseStates[24] && !pendingValidationDeadlinePatch) throw new Error('Validation deadline patch is neither exactly applied nor cleanly applicable')
  const parserCancellationPatch = CS2D_PATCH_FILES[25]
  const pendingParserCancellationPatch = !reverseStates[25] &&
    run('git', ['apply', '--check', parserCancellationPatch], { cwd: upstream, capture: true, allowFailure: true }).status === 0
  if (paths.length > 0 && !reverseStates[25] && !pendingParserCancellationPatch && !reverseStates[26]) throw new Error('Parser cancellation patch is neither exactly applied nor cleanly applicable')
  const parserStartFailurePatch = CS2D_PATCH_FILES[26]
  const pendingParserStartFailurePatch = !reverseStates[26] &&
    run('git', ['apply', '--check', parserStartFailurePatch], { cwd: upstream, capture: true, allowFailure: true }).status === 0
  if (paths.length > 0 && !reverseStates[26] && !pendingParserStartFailurePatch) throw new Error('Parser startup failure patch is neither exactly applied nor cleanly applicable')
  const winRateOwnerPatch = CS2D_PATCH_FILES[27]
  const pendingWinRateOwnerPatch = !reverseStates[27] &&
    run('git', ['apply', '--check', winRateOwnerPatch], { cwd: upstream, capture: true, allowFailure: true }).status === 0
  if (paths.length > 0 && !reverseStates[27] && !pendingWinRateOwnerPatch) throw new Error('Win-rate worker owner patch is neither exactly applied nor cleanly applicable')
  // Later identity markers intentionally supersede earlier generatedBy lines.
  if (paths.length > 0 && !reverseStates[18] && !pendingPrimaryInventoryPatch) throw new Error('Primary inventory patch is neither exactly applied nor cleanly applicable')
  if (paths.length > 0 && !reverseStates[17] && !pendingGrenadeInventoryPatch && !reverseStates[18]) throw new Error('Grenade inventory patch is neither exactly applied nor cleanly applicable')
  if (paths.length > 0 && !reverseStates[16] && !pendingActiveWeaponIdentityPatch && !reverseStates[17] && !reverseStates[18]) throw new Error('Active weapon identity patch is neither exactly applied nor cleanly applicable')
  if (paths.length > 0 && !reverseStates[15] && !pendingFrameIdentityPatch && !reverseStates[16] && !reverseStates[17] && !reverseStates[18]) throw new Error('Frame pawn identity patch is neither exactly applied nor cleanly applicable')
  if (paths.length > 0 && !reverseStates[14] && !pendingDeathIdentityPatch && !reverseStates[15] && !reverseStates[16] && !reverseStates[17] && !reverseStates[18]) throw new Error('Death identity patch is neither exactly applied nor cleanly applicable')
  if (paths.length > 0 && !reverseStates[13] && !pendingBombIdentityPatch && !reverseStates[14] && !reverseStates[15] && !reverseStates[16] && !reverseStates[17] && !reverseStates[18]) throw new Error('Bomb identity patch is neither exactly applied nor cleanly applicable')
  if (paths.length > 0 && !reverseStates[12] && !pendingAmmoCachePatch && !reverseStates[13] && !reverseStates[14] && !reverseStates[15] && !reverseStates[16] && !reverseStates[17] && !reverseStates[18]) throw new Error('Prior-tick ammo cache patch is neither exactly applied nor cleanly applicable')
  if (paths.length > 0 && !reverseStates[11] && !pendingAmmoPatch && !reverseStates[12] && !reverseStates[13] && !reverseStates[14] && !reverseStates[15] && !reverseStates[16] && !reverseStates[17] && !reverseStates[18]) throw new Error('Active weapon ammo patch is neither exactly applied nor cleanly applicable')
  const errors = paths.length > 0 || patchesExactlyApplied
    ? markerErrors(upstream, !pendingManagedLibraryPatch, !pendingShotActorPatch, !pendingTeachingPlaybackPatch, !pendingRoundClockPatch, !pendingHurtEventsPatch, !pendingShotIdentityPatch, !pendingBombIdentityPatch, !pendingDeathIdentityPatch, !pendingFrameIdentityPatch, !pendingActiveWeaponIdentityPatch, !pendingGrenadeInventoryPatch, !pendingPrimaryInventoryPatch)
    : []
  const decision = classifyPatchedCheckout({
    head,
    dirtyPaths: paths,
    diffCheckPassed: check.passed,
    patchesExactlyApplied,
    markerErrors: errors,
  })
  return { decision, head, paths, diffCheck: check, patchesExactlyApplied, markerErrors: errors, pendingManagedLibraryPatch, pendingShotActorPatch, pendingTeachingPlaybackPatch, pendingRoundClockPatch, pendingHurtEventsPatch, pendingShotIdentityPatch, pendingAmmoPatch, pendingAmmoCachePatch, pendingBombIdentityPatch, pendingDeathIdentityPatch, pendingFrameIdentityPatch, pendingActiveWeaponIdentityPatch, pendingGrenadeInventoryPatch, pendingPrimaryInventoryPatch, pendingDemoPickerPatch, pendingReplayReusePatch, pendingParserReleasePatch, pendingReadFailurePatch, pendingValidationFeedbackPatch, pendingValidationDeadlinePatch, pendingParserCancellationPatch, pendingParserStartFailurePatch, pendingWinRateOwnerPatch }
}

function applyPatches(upstream) {
  for (const patch of CS2D_PATCH_FILES) {
    const reverse = patchReverseApplies(patch, upstream)
    if (reverse) {
      process.stdout.write(`[cs2d-host] ${patchName(patch)} already applied at ${CS2D_PIN.slice(0, 7)}\n`)
      continue
    }
    const forward = run('git', ['apply', '--check', patch], {
      cwd: upstream,
      capture: true,
      allowFailure: true,
    })
    if (forward.status !== 0) {
      const detail = [forward.stdout, forward.stderr].filter(Boolean).join('\n').trim()
      throw new Error(`Cannot apply ${patchName(patch)} to cs2d checkout${detail ? `:\n${detail}` : ''}`)
    }
    run('git', ['apply', patch], { cwd: upstream })
    process.stdout.write(`[cs2d-host] applied ${patchName(patch)} at ${CS2D_PIN.slice(0, 7)}\n`)
  }
}

async function main(argv = process.argv.slice(2)) {
  const flags = new Set(argv)
  const upstream = resolve(process.env.CS2D_UPSTREAM_DIR || resolve(root, '.local-data/upstream/cs2d'))
  const reuse = flags.has('--reuse-patched-checkout')

  if (!existsSync(resolve(upstream, '.git'))) {
    if (!flags.has('--clone')) {
      throw new Error(`cs2d checkout is missing at ${upstream}. Run: pnpm cs2d:setup`)
    }
    await mkdir(dirname(upstream), { recursive: true })
    run('git', ['clone', '--filter=blob:none', REPOSITORY, upstream])
    run('git', ['checkout', '--detach', CS2D_PIN], { cwd: upstream })
  }

  const parserToolchain = flags.has('--build-parser') || flags.has('--check-parser') || flags.has('--test-parser')
    ? preflightParserToolchain(resolve(upstream, 'packages/parser')) : undefined
  if (flags.has('--check-parser')) {
    // Check prerequisites before patching; build/test verify the patched dependency lock.
    process.stdout.write(`[parser toolchain] ready: ${parserToolchain.toolchain}; wasm-bindgen ${parserToolchain.bindgenVersion}\n`)
    return
  }

  const inspection = reuse ? inspectPatchedCheckout(upstream) : null
  if (inspection?.decision === CS2D_REUSE_DECISIONS.EXACT_APPLIED) {
    process.stdout.write(`[cs2d-host] reused exact patched checkout at ${CS2D_PIN.slice(0, 7)}\n`)
  } else if (inspection?.decision === CS2D_REUSE_DECISIONS.CONTROLLED_SUPERSET) {
    const pendingPatches = [
      ...(inspection.pendingManagedLibraryPatch ? [CS2D_PATCH_FILES[5]] : []),
      ...(inspection.pendingShotActorPatch ? [CS2D_PATCH_FILES[6]] : []),
      ...(inspection.pendingTeachingPlaybackPatch ? [CS2D_PATCH_FILES[7]] : []),
      ...(inspection.pendingRoundClockPatch ? [CS2D_PATCH_FILES[8]] : []),
      ...(inspection.pendingHurtEventsPatch ? [CS2D_PATCH_FILES[9]] : []),
      ...(inspection.pendingShotIdentityPatch ? [CS2D_PATCH_FILES[10]] : []),
      ...(inspection.pendingAmmoPatch ? [CS2D_PATCH_FILES[11]] : []),
      ...(inspection.pendingAmmoCachePatch ? [CS2D_PATCH_FILES[12]] : []),
      ...(inspection.pendingBombIdentityPatch ? [CS2D_PATCH_FILES[13]] : []),
      ...(inspection.pendingDeathIdentityPatch ? [CS2D_PATCH_FILES[14]] : []),
      ...(inspection.pendingFrameIdentityPatch ? [CS2D_PATCH_FILES[15]] : []),
      ...(inspection.pendingActiveWeaponIdentityPatch ? [CS2D_PATCH_FILES[16]] : []),
      ...(inspection.pendingGrenadeInventoryPatch ? [CS2D_PATCH_FILES[17]] : []),
      ...(inspection.pendingPrimaryInventoryPatch ? [CS2D_PATCH_FILES[18]] : []),
      ...(inspection.pendingDemoPickerPatch ? [CS2D_PATCH_FILES[19]] : []),
      ...(inspection.pendingReplayReusePatch ? [CS2D_PATCH_FILES[20]] : []),
      ...(inspection.pendingParserReleasePatch ? [CS2D_PATCH_FILES[21]] : []),
      ...(inspection.pendingReadFailurePatch ? [CS2D_PATCH_FILES[22]] : []),
      ...(inspection.pendingValidationFeedbackPatch ? [CS2D_PATCH_FILES[23]] : []),
      ...(inspection.pendingValidationDeadlinePatch ? [CS2D_PATCH_FILES[24]] : []),
      ...(inspection.pendingParserCancellationPatch ? [CS2D_PATCH_FILES[25]] : []),
      ...(inspection.pendingParserStartFailurePatch ? [CS2D_PATCH_FILES[26]] : []),
      ...(inspection.pendingWinRateOwnerPatch ? [CS2D_PATCH_FILES[27]] : []),
    ]
    for (const patch of pendingPatches) {
      if (!patch) throw new Error('pending patch missing from controlled stack')
      run('git', ['apply', patch], { cwd: upstream })
      process.stdout.write(`[cs2d-host] applied ${patchName(patch)} at ${CS2D_PIN.slice(0, 7)}\n`)
    }
    if (pendingPatches.length > 0) {
      const errors = markerErrors(upstream)
      if (errors.length > 0) throw new Error(`cs2d patched checkout markers failed:\n${errors.join('\n')}`)
    }
    process.stdout.write(`[cs2d-host] reused verified controlled patched checkout at ${CS2D_PIN.slice(0, 7)}\n`)
  } else {
    const head = run('git', ['rev-parse', 'HEAD'], { cwd: upstream, capture: true }).stdout.trim()
    if (head !== CS2D_PIN) {
      throw new Error(`cs2d commit mismatch: expected ${CS2D_PIN}, received ${head || '<empty>'}`)
    }
    const paths = dirtyPaths(upstream)
    const exact = CS2D_PATCH_FILES.every((patch) => patchReverseApplies(patch, upstream))
    if (paths.length > 0 && !exact) {
      throw new Error(
        'cs2d checkout is dirty and not exactly patched; pass --reuse-patched-checkout only after marker validation',
      )
    }
    applyPatches(upstream)
  }

  if (flags.has('--install')) {
    run('pnpm', ['install', '--frozen-lockfile'], { cwd: upstream })
  }

  if (flags.has('--test-parser')) testParserNative(resolve(upstream, 'packages/parser'), { checked: parserToolchain })
  if (flags.has('--build-parser')) buildParserWasm(resolve(upstream, 'packages/parser'), { checked: parserToolchain })
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.stack || error.message : String(error)}\n`)
    process.exitCode = 1
  })
}

import { existsSync, readFileSync } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { delimiter, dirname, resolve } from 'node:path'
import { homedir } from 'node:os'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { spawnSync } from 'node:child_process'

export const CS2D_PIN = 'dbbe698c9b9c91f9a14cecea92374b4114bf60ec'
const REPOSITORY = 'https://github.com/zenojunior/cs2d.git'
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const patchFiles = [
  resolve(root, 'tools/cs2d-host/patches/0001-cs2d-playback-host.patch'),
  resolve(root, 'tools/cs2d-host/patches/0002-cs2d-cloudflare-base.patch'),
  resolve(root, 'tools/cs2d-host/patches/0003-cs2d-stage2-map-focus.patch'),
]

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
  'apps/app/src/viewer/vite.config.ts',
  'apps/app/vite.config.ts',
  'packages/parser/src/assemble.rs',
  'packages/parser/src/collector.rs',
  'packages/parser/src/props.rs',
  'packages/parser/src/schema.rs',
  'packages/replay-core/src/schema.ts',
  'pnpm-lock.yaml',
  'apps/app/src/viewer/analysis/csNetWinRate.worker.ts',
  'apps/app/src/viewer/player/hostBridge.ts',
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

function markerErrors(upstream) {
  const errors = []
  for (const marker of REQUIRED_MARKERS) {
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
  const patchesExactlyApplied = patchFiles.every((patch) => patchReverseApplies(patch, upstream))
  const errors = paths.length > 0 || patchesExactlyApplied ? markerErrors(upstream) : []
  const decision = classifyPatchedCheckout({
    head,
    dirtyPaths: paths,
    diffCheckPassed: check.passed,
    patchesExactlyApplied,
    markerErrors: errors,
  })
  return { decision, head, paths, diffCheck: check, patchesExactlyApplied, markerErrors: errors }
}

function applyPatches(upstream) {
  for (const patch of patchFiles) {
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

  const inspection = reuse ? inspectPatchedCheckout(upstream) : null
  if (inspection?.decision === CS2D_REUSE_DECISIONS.EXACT_APPLIED) {
    process.stdout.write(`[cs2d-host] reused exact patched checkout at ${CS2D_PIN.slice(0, 7)}\n`)
  } else if (inspection?.decision === CS2D_REUSE_DECISIONS.CONTROLLED_SUPERSET) {
    process.stdout.write(`[cs2d-host] reused verified controlled patched checkout at ${CS2D_PIN.slice(0, 7)}\n`)
  } else {
    const head = run('git', ['rev-parse', 'HEAD'], { cwd: upstream, capture: true }).stdout.trim()
    if (head !== CS2D_PIN) {
      throw new Error(`cs2d commit mismatch: expected ${CS2D_PIN}, received ${head || '<empty>'}`)
    }
    const paths = dirtyPaths(upstream)
    const exact = patchFiles.every((patch) => patchReverseApplies(patch, upstream))
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

  if (flags.has('--build-parser')) {
    const cargoBin = resolve(homedir(), '.cargo/bin')
    run('bash', [resolve(upstream, 'packages/parser/build.sh')], {
      cwd: resolve(upstream, 'packages/parser'),
      env: {
        ...process.env,
        PATH: [cargoBin, process.env.PATH].filter(Boolean).join(delimiter),
      },
    })
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.stack || error.message : String(error)}\n`)
    process.exitCode = 1
  })
}

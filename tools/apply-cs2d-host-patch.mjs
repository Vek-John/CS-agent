import { existsSync } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { delimiter, dirname, resolve } from 'node:path'
import { homedir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const PIN = 'dbbe698c9b9c91f9a14cecea92374b4114bf60ec'
const REPOSITORY = 'https://github.com/zenojunior/cs2d.git'
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const upstream = resolve(process.env.CS2D_UPSTREAM_DIR || resolve(root, '.local-data/upstream/cs2d'))
const patch = resolve(root, 'tools/cs2d-host/patches/0001-cs2d-playback-host.patch')
const flags = new Set(process.argv.slice(2))

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

if (!existsSync(resolve(upstream, '.git'))) {
  if (!flags.has('--clone')) {
    throw new Error(`cs2d checkout is missing at ${upstream}. Run: pnpm cs2d:setup`)
  }
  await mkdir(dirname(upstream), { recursive: true })
  run('git', ['clone', '--filter=blob:none', REPOSITORY, upstream])
  run('git', ['checkout', '--detach', PIN], { cwd: upstream })
}

const head = run('git', ['rev-parse', 'HEAD'], { cwd: upstream, capture: true }).stdout.trim()
if (head !== PIN) {
  throw new Error(`cs2d commit mismatch: expected ${PIN}, received ${head || '<empty>'}`)
}
if (!existsSync(patch)) throw new Error(`Missing patch: ${patch}`)

const reverse = run('git', ['apply', '--reverse', '--check', patch], {
  cwd: upstream,
  capture: true,
  allowFailure: true,
})
if (reverse.status === 0) {
  process.stdout.write(`[cs2d-host] patch already applied at ${PIN.slice(0, 7)}\n`)
} else {
  run('git', ['apply', '--check', patch], { cwd: upstream })
  run('git', ['apply', patch], { cwd: upstream })
  process.stdout.write(`[cs2d-host] applied patch at ${PIN.slice(0, 7)}\n`)
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

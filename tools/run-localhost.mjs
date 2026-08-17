import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import { parseEnv } from 'node:util'

const root = process.cwd()
const upstream = resolve(process.env.CS2D_UPSTREAM_DIR || resolve(root, '.local-data/upstream/cs2d'))
const patcher = resolve(root, 'tools/apply-cs2d-host-patch.mjs')
const localCoachEnvPath = resolve(root, '.local-data/deepseek.env')

let localCoachEnv = {}
if (existsSync(localCoachEnvPath)) {
  localCoachEnv = parseEnv(readFileSync(localCoachEnvPath, 'utf8'))
  const unexpected = Object.keys(localCoachEnv).filter((key) => !['DEEPSEEK_API_KEY', 'DEEPSEEK_MODEL'].includes(key))
  if (unexpected.length) {
    throw new Error(`[coach] unsupported keys in .local-data/deepseek.env: ${unexpected.join(', ')}`)
  }
}

const patchResult = spawnSync(process.execPath, [patcher], { cwd: root, stdio: 'inherit' })
if (patchResult.status !== 0) process.exit(patchResult.status ?? 1)
if (!existsSync(resolve(upstream, 'node_modules'))) {
  process.stderr.write('[cs2d-host] dependencies missing. Run: pnpm cs2d:setup\n')
  process.exit(1)
}

const children = []
function launch(label, args, options = {}) {
  const child = spawn('pnpm', args, {
    cwd: options.cwd ?? root,
    env: { ...process.env, ...options.env },
    stdio: 'inherit',
  })
  child.on('exit', (code, signal) => {
    if (signal || (code !== null && code !== 0)) {
      process.stderr.write(`[${label}] exited ${signal ?? code}\n`)
      shutdown(code ?? 1)
    }
  })
  children.push(child)
}

let stopping = false
function shutdown(code = 0) {
  if (stopping) return
  stopping = true
  for (const child of children) {
    if (!child.killed) child.kill('SIGTERM')
  }
  setTimeout(() => process.exit(code), 250)
}
process.on('SIGINT', () => shutdown(0))
process.on('SIGTERM', () => shutdown(0))

launch('cs2d', ['--filter', 'cs2-demo-viewer', 'dev', '--host', 'localhost', '--port', '5174'], { cwd: upstream })
launch('coach', ['--filter', '@cs-coach/web', 'dev', '--hostname', 'localhost', '--port', '3000'], {
  env: {
    ...localCoachEnv,
    NEXT_PUBLIC_CS2D_HOST_URL: 'http://localhost:5174/?host=1',
  },
})

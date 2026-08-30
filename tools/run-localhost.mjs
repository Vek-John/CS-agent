import { spawn, spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { dirname, resolve } from 'node:path'
import { parseEnv } from 'node:util'
import { fileURLToPath } from 'node:url'

const LOCAL_ENV_FILE = '.local-data/deepseek.env'
const TRUE_VALUES = new Set(['true', '1', 'on'])
const FALSE_VALUES = new Set(['false', '0', 'off', ''])

export const LOCAL_COACH_ENV_KEYS = Object.freeze([
  'DEEPSEEK_API_KEY',
  'DEEPSEEK_MODEL',
  'MEMORY_ENABLED',
  'MEMORY_DATABASE_URL',
  'DATABASE_URL',
  'MEMORY_PRINCIPAL_SECRET',
  'MEMORY_EMBEDDING_URL',
  'MEMORY_EMBEDDING_TOKEN',
  'MEMORY_EMBEDDING_API_KEY',
  'MEMORY_EMBEDDING_MODEL',
])

class LocalhostStartupError extends Error {}

function nonEmpty(value) {
  return typeof value === 'string' && value.trim().length > 0
}

function safeErrorCode(error) {
  return error && typeof error === 'object' && typeof error.code === 'string'
    ? error.code
    : 'UNKNOWN'
}

export function parseLocalCoachEnv(source, sourceLabel = LOCAL_ENV_FILE) {
  let parsed
  try {
    parsed = parseEnv(source)
  } catch {
    throw new LocalhostStartupError(`[coach] cannot parse ${sourceLabel}; check KEY=value syntax (values were not logged)`)
  }
  const supported = new Set(LOCAL_COACH_ENV_KEYS)
  const unexpected = Object.keys(parsed).filter((key) => !supported.has(key)).sort()
  if (unexpected.length > 0) {
    const shown = unexpected.slice(0, 10).join(', ')
    const remainder = unexpected.length > 10 ? ` (+${unexpected.length - 10} more)` : ''
    throw new LocalhostStartupError(`[coach] unsupported keys in ${sourceLabel}: ${shown}${remainder}`)
  }
  return parsed
}

export function resolveLocalCoachEnvironment(fileEnv = {}, inheritedEnv = process.env, options = {}) {
  const memoryEnabled = Object.prototype.hasOwnProperty.call(inheritedEnv, 'MEMORY_ENABLED')
    ? inheritedEnv.MEMORY_ENABLED
    : Object.prototype.hasOwnProperty.call(fileEnv, 'MEMORY_ENABLED')
      ? fileEnv.MEMORY_ENABLED
      : options.enableMemoryByDefault
        ? 'true'
        : 'false'
  return {
    ...fileEnv,
    ...inheritedEnv,
    MEMORY_ENABLED: memoryEnabled ?? 'false',
    NEXT_PUBLIC_DEPLOY_TARGET: 'localhost',
    NEXT_PUBLIC_CS2D_HOST_URL: 'http://localhost:5174/?host=1',
  }
}

export function parseLocalhostArgs(args) {
  const unsupported = args.filter((arg) => arg !== '--memory')
  if (unsupported.length > 0) {
    throw new LocalhostStartupError(`[localhost] unsupported option: ${unsupported[0]}`)
  }
  return { enableMemoryByDefault: args.includes('--memory') }
}

export function inspectLocalMemoryEnvironment(env) {
  const rawFlag = typeof env.MEMORY_ENABLED === 'string' ? env.MEMORY_ENABLED.trim().toLowerCase() : ''
  const featureEnabled = TRUE_VALUES.has(rawFlag)
  const recognizedFlag = TRUE_VALUES.has(rawFlag) || FALSE_VALUES.has(rawFlag)
  const databaseConfigured = nonEmpty(env.MEMORY_DATABASE_URL) || nonEmpty(env.DATABASE_URL)
  const embeddingConfigured = nonEmpty(env.MEMORY_EMBEDDING_URL)
  const stablePrincipal = nonEmpty(env.MEMORY_PRINCIPAL_SECRET)
  return {
    featureEnabled,
    recognizedFlag,
    storage: databaseConfigured ? 'POSTGRES' : 'IN_MEMORY',
    embeddingConfigured,
    stablePrincipal,
  }
}

export function formatLocalMemoryDiagnostic(env) {
  const status = inspectLocalMemoryEnvironment(env)
  if (!status.featureEnabled) {
    const flag = status.recognizedFlag ? 'MEMORY_ENABLED=false' : 'unrecognized MEMORY_ENABLED value; treated as false'
    return `[localhost] memory: disabled (${flag}); recall, writes, and embedding are off`
  }
  if (status.storage === 'IN_MEMORY') {
    const embedding = status.embeddingConfigured ? 'configured' : 'off'
    return `[localhost] memory: enabled; storage=IN_MEMORY fallback (process-local; restart clears it); embedding=${embedding}; set MEMORY_DATABASE_URL for durable memory`
  }
  const embedding = status.embeddingConfigured ? 'configured' : 'off (structured recall remains available)'
  const principal = status.stablePrincipal ? 'stable' : 'ephemeral (browser identity resets on restart)'
  return `[localhost] memory: enabled; storage=POSTGRES; embedding=${embedding}; principal=${principal}`
}

export async function assertLocalPortAvailable(label, port, host = 'localhost') {
  await new Promise((resolvePromise, rejectPromise) => {
    const server = createServer()
    server.unref()
    server.once('error', (error) => {
      const code = safeErrorCode(error)
      const detail = code === 'EADDRINUSE'
        ? 'already in use'
        : `unavailable (${code})`
      rejectPromise(new LocalhostStartupError(`[${label}] ${host}:${port} is ${detail}; no localhost service was started`))
    })
    server.listen({ host, port, exclusive: true }, () => {
      server.close((error) => {
        if (error) {
          rejectPromise(new LocalhostStartupError(`[${label}] could not release ${host}:${port} preflight (${safeErrorCode(error)})`))
          return
        }
        resolvePromise()
      })
    })
  })
}

export function signalOwnedChild(child, signal, options = {}) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return
  const platform = options.platform ?? process.platform
  const killProcess = options.killProcess ?? process.kill
  if (platform !== 'win32' && Number.isInteger(child.pid)) {
    try {
      killProcess(-child.pid, signal)
      return
    } catch (error) {
      if (safeErrorCode(error) === 'ESRCH') return
    }
  }
  try {
    child.kill(signal)
  } catch {
    // The child may have exited between the state check and the signal.
  }
}

function createProcessSupervisor({ root, inheritedEnv, spawnProcess = spawn }) {
  const records = []
  let stopping = false
  let exitCode = 0
  let forceTimer
  let hardExitTimer

  const allClosed = () => records.every((record) => record.closed)
  const removeSignalHandlers = () => {
    process.off('SIGINT', onSigint)
    process.off('SIGTERM', onSigterm)
  }
  const finish = () => {
    if (!allClosed()) return
    if (forceTimer) clearTimeout(forceTimer)
    if (hardExitTimer) clearTimeout(hardExitTimer)
    removeSignalHandlers()
    process.exitCode = exitCode
  }
  const shutdown = (code = 0) => {
    if (code !== 0 && exitCode === 0) exitCode = code
    if (stopping) return
    stopping = true
    for (const record of records) signalOwnedChild(record.child, 'SIGTERM')
    if (allClosed()) {
      finish()
      return
    }
    forceTimer = setTimeout(() => {
      for (const record of records) signalOwnedChild(record.child, 'SIGKILL')
      hardExitTimer = setTimeout(() => process.exit(exitCode), 250)
    }, 4_000)
  }
  const onSigint = () => shutdown(0)
  const onSigterm = () => shutdown(0)
  process.on('SIGINT', onSigint)
  process.on('SIGTERM', onSigterm)

  const launch = (label, args, options = {}) => {
    let child
    try {
      child = spawnProcess('pnpm', args, {
        cwd: options.cwd ?? root,
        env: options.env ?? inheritedEnv,
        stdio: 'inherit',
        detached: process.platform !== 'win32',
      })
    } catch {
      process.stderr.write(`[${label}] failed to start (SPAWN_THROW)\n`)
      shutdown(1)
      return undefined
    }
    const record = { child, closed: false, label }
    records.push(record)
    child.once('error', (error) => {
      process.stderr.write(`[${label}] failed to start (${safeErrorCode(error)})\n`)
      shutdown(1)
    })
    child.once('close', (code, signal) => {
      record.closed = true
      if (!stopping) {
        process.stderr.write(`[${label}] exited unexpectedly (${signal ?? code ?? 'UNKNOWN'})\n`)
        shutdown(code && code > 0 ? code : 1)
      }
      finish()
    })
    return child
  }

  return { launch, shutdown }
}

function assertPreparationStage(label, result) {
  if (result.error) {
    throw new LocalhostStartupError(`[${label}] could not start (${safeErrorCode(result.error)})`)
  }
  if (result.signal || result.status !== 0) {
    throw new LocalhostStartupError(`[${label}] failed (${result.signal ?? result.status ?? 'UNKNOWN'})`)
  }
}

function loadLocalCoachEnv(localCoachEnvPath) {
  if (!existsSync(localCoachEnvPath)) return {}
  return parseLocalCoachEnv(readFileSync(localCoachEnvPath, 'utf8'))
}

export async function runLocalhost(options = {}) {
  const root = options.root ?? resolve(dirname(fileURLToPath(import.meta.url)), '..')
  const inheritedEnv = options.env ?? process.env
  const upstream = resolve(inheritedEnv.CS2D_UPSTREAM_DIR || resolve(root, '.local-data/upstream/cs2d'))
  const patcher = resolve(root, 'tools/apply-cs2d-host-patch.mjs')
  const modelSync = resolve(root, 'tools/sync-cs-net-assets.mjs')
  const localCoachEnvPath = resolve(root, LOCAL_ENV_FILE)
  const localCoachEnv = loadLocalCoachEnv(localCoachEnvPath)
  const coachEnv = resolveLocalCoachEnvironment(localCoachEnv, inheritedEnv, {
    enableMemoryByDefault: options.enableMemoryByDefault,
  })

  process.stdout.write(existsSync(localCoachEnvPath)
    ? `[localhost] local env: loaded ${LOCAL_ENV_FILE} (values hidden; shell variables take precedence)\n`
    : `[localhost] local env: ${LOCAL_ENV_FILE} absent; using safe defaults and shell variables\n`)
  process.stdout.write(`${formatLocalMemoryDiagnostic(coachEnv)}\n`)

  await Promise.all([
    assertLocalPortAvailable('coach', 3000),
    assertLocalPortAvailable('cs2d-host', 5174),
  ])

  const modelResult = spawnSync(process.execPath, [modelSync], {
    cwd: root,
    stdio: 'inherit',
    env: { ...inheritedEnv, CS2D_DEV_ASSETS: '1' },
  })
  assertPreparationStage('cs-net-assets', modelResult)
  const patchResult = spawnSync(process.execPath, [patcher, '--reuse-patched-checkout'], {
    cwd: root,
    stdio: 'inherit',
    env: inheritedEnv,
  })
  assertPreparationStage('cs2d-host-patch', patchResult)
  if (!existsSync(resolve(upstream, 'node_modules'))) {
    throw new LocalhostStartupError('[cs2d-host] dependencies missing. Run: pnpm cs2d:setup')
  }

  const supervisor = createProcessSupervisor({ root, inheritedEnv })
  const cs2d = supervisor.launch(
    'cs2d-host',
    ['--filter', 'cs2-demo-viewer', 'dev', '--host', 'localhost', '--port', '5174'],
    { cwd: upstream, env: inheritedEnv },
  )
  if (!cs2d) return supervisor
  supervisor.launch(
    'coach',
    ['--filter', '@cs-coach/web', 'dev', '--hostname', 'localhost', '--port', '3000'],
    { env: coachEnv },
  )
  return supervisor
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])
if (isMain) {
  let cliOptions
  try {
    cliOptions = parseLocalhostArgs(process.argv.slice(2))
  } catch (error) {
    const message = error instanceof LocalhostStartupError
      ? error.message
      : '[localhost] invalid command-line options'
    process.stderr.write(`${message}\n`)
    process.exitCode = 1
  }
  const start = cliOptions ? runLocalhost(cliOptions) : Promise.resolve()
  start.catch((error) => {
    const message = error instanceof LocalhostStartupError
      ? error.message
      : '[localhost] startup failed with an unexpected error (details withheld)'
    process.stderr.write(`${message}\n`)
    process.exitCode = 1
  })
}

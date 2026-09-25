import { accessSync, constants, existsSync, readFileSync } from 'node:fs'
import { delimiter, isAbsolute, resolve } from 'node:path'
import { homedir } from 'node:os'
import { spawnSync } from 'node:child_process'

export const PARSER_RUST_VERSION = '1.89.0'
export const PARSER_WASM_TARGET = 'wasm32-unknown-unknown'

export function parserBuildEnvironment(env = process.env) {
  return { ...env, RUSTUP_AUTO_INSTALL: '0',
    PATH: [resolve(env.CARGO_HOME || resolve(homedir(), '.cargo'), 'bin'), env.PATH].filter(Boolean).join(delimiter) }
}

function executable(name, env) {
  for (const directory of (env.PATH || '').split(delimiter).filter(Boolean)) {
    const path = resolve(directory, process.platform === 'win32' ? `${name}.exe` : name)
    try { accessSync(path, constants.X_OK); return path } catch { /* continue on this PATH */ }
  }
  return undefined
}

function probe(command, args, cwd, env, instruction) {
  const result = spawnSync(command, args, { cwd, env, encoding: 'utf8', timeout: 10_000, maxBuffer: 256 * 1024 })
  if (result.status !== 0) throw new Error(`[parser toolchain] ${instruction}\n${result.error?.message ?? result.stderr?.trim().slice(0, 500) ?? ''}`)
  return result.stdout.trim()
}

export function lockedBindgenVersion(parserDir) {
  const path = resolve(parserDir, 'Cargo.lock')
  if (!existsSync(path)) throw new Error('[parser toolchain] Parser Cargo.lock is missing; prepare the pinned checkout with pnpm cs2d:setup.')
  const versions = readFileSync(path, 'utf8').split('[[package]]')
    .filter(block => /^name = "wasm-bindgen"$/m.test(block))
    .map(block => block.match(/^version = "(\d+\.\d+\.\d+)"$/m)?.[1]).filter(Boolean)
  if (versions.length !== 1) throw new Error('[parser toolchain] Expected one locked wasm-bindgen version; review the parser lock before building.')
  return versions[0]
}

function versionAtLeast(output, name) {
  const actual = output.match(new RegExp(`^${name} (\\d+)\\.(\\d+)\\.(\\d+)`))?.slice(1).map(Number)
  const wanted = PARSER_RUST_VERSION.split('.').map(Number)
  return actual && (actual[0] > wanted[0] || actual[0] === wanted[0] && (actual[1] > wanted[1] || actual[1] === wanted[1] && actual[2] >= wanted[2]))
}

/** Read-only local probes, in the parser cwd; never install or select a new global default. */
export function preflightParserToolchain(parserDir, { env: inputEnv = process.env } = {}) {
  const env = parserBuildEnvironment(inputEnv)
  const expectedBindgen = lockedBindgenVersion(parserDir)
  const rustup = executable('rustup', env)
  if (!rustup) throw new Error('[parser toolchain] rustup is missing from the build PATH. Install rustup from https://rustup.rs and expose its Cargo bin directory; see README developer prerequisites.')
  const active = probe(rustup, ['show', 'active-toolchain'], parserDir, env,
    `No installed active toolchain. Install explicitly with: rustup toolchain install ${PARSER_RUST_VERSION} --profile minimal; then choose it with RUSTUP_TOOLCHAIN=${PARSER_RUST_VERSION}.`).split(/\s/)[0]
  const selected = { ...env, RUSTUP_TOOLCHAIN: active }
  const tool = name => {
    const path = probe(rustup, ['which', '--toolchain', active, name], parserDir, selected,
      `${name} is missing from ${active}. Repair that toolchain explicitly with rustup toolchain install ${PARSER_RUST_VERSION} --profile minimal.`)
    if (!isAbsolute(path) || !existsSync(path)) throw new Error(`[parser toolchain] ${name} is missing from selected toolchain ${active}. Repair that installed toolchain.`)
    return path
  }
  const cargo = tool('cargo')
  const rustc = tool('rustc')
  if (inputEnv.RUSTC && resolve(inputEnv.RUSTC) !== rustc) throw new Error('[parser toolchain] RUSTC overrides the selected rustup compiler. Unset RUSTC or point it to the selected toolchain compiler before building.')
  for (const [name, path] of [['cargo', cargo], ['rustc', rustc]]) {
    const output = probe(path, ['--version'], parserDir, selected, `${name} in ${active} cannot run; repair that toolchain.`)
    if (!versionAtLeast(output, name)) throw new Error(`[parser toolchain] ${output}; this build supports Rust ${PARSER_RUST_VERSION} or newer. Select an installed compatible toolchain with RUSTUP_TOOLCHAIN.`)
  }
  const targets = probe(rustup, ['target', 'list', '--installed', '--toolchain', active], parserDir, selected,
    `Cannot inspect targets for ${active}. Run: rustup target add ${PARSER_WASM_TARGET} --toolchain ${active}`)
  if (!targets.split(/\s+/).includes(PARSER_WASM_TARGET)) throw new Error(`[parser toolchain] ${PARSER_WASM_TARGET} is missing from ${active}. Run: rustup target add ${PARSER_WASM_TARGET} --toolchain ${active}`)
  const bindgen = executable('wasm-bindgen', selected)
  const install = `cargo +${active} install wasm-bindgen-cli --version ${expectedBindgen} --locked`
  if (!bindgen) throw new Error(`[parser toolchain] wasm-bindgen is missing from the build PATH. Run: ${install}`)
  const actualBindgen = probe(bindgen, ['--version'], parserDir, selected, `wasm-bindgen cannot run. Run: ${install}`).match(/^wasm-bindgen (\S+)/)?.[1]
  if (actualBindgen !== expectedBindgen) throw new Error(`[parser toolchain] wasm-bindgen CLI ${actualBindgen ?? 'unknown'} does not match Cargo.lock ${expectedBindgen}. Run: ${install} --force`)
  return { cargo, rustc, bindgen, toolchain: active, bindgenVersion: expectedBindgen, env: { ...selected, RUSTC: rustc } }
}

export function buildParserWasm(parserDir, options = {}) {
  const checked = options.checked ?? preflightParserToolchain(parserDir, options)
  const targetDir = resolve(parserDir, 'target')
  // The pinned third-party parser still calls deprecated source2-demo APIs.
  // Narrowly keep those visible as warnings; preserve -D warnings for all other
  // lints and do not change the parent/desktop toolchain environment.
  const compilerEnv = checked.env.CARGO_ENCODED_RUSTFLAGS !== undefined
    ? { ...checked.env, CARGO_ENCODED_RUSTFLAGS: [checked.env.CARGO_ENCODED_RUSTFLAGS, '--force-warn', 'deprecated'].filter(Boolean).join('\x1f') }
    : { ...checked.env, RUSTFLAGS: `${checked.env.RUSTFLAGS || ''} --force-warn deprecated`.trim() }
  const build = (command, args, env = checked.env) => {
    const result = spawnSync(command, args, { cwd: parserDir, env, stdio: 'inherit', timeout: 600_000 })
    if (result.status !== 0) throw new Error(`[parser build] ${command} failed: ${result.error?.message ?? `exit ${result.status}`}`)
  }
  process.stdout.write(`[parser toolchain] ${checked.toolchain}; wasm-bindgen ${checked.bindgenVersion}\n`)
  build(checked.cargo, ['build', '--locked', '--release', '--target', PARSER_WASM_TARGET, '--target-dir', targetDir, '--manifest-path', resolve(parserDir, 'Cargo.toml')], compilerEnv)
  build(checked.bindgen, [resolve(targetDir, PARSER_WASM_TARGET, 'release/cs2_demo_parser_wasm.wasm'), '--target', 'web', '--out-name', 'demo_parser', '--out-dir', resolve(parserDir, '../../apps/app/src/viewer/parser')])
  return checked
}

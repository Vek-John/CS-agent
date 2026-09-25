import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'
import { buildParserWasm, preflightParserToolchain } from './cs2d-parser-toolchain.mjs'

const roots = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })
function fixture(config = {}) {
  const root = mkdtempSync(join(tmpdir(), 'cs2d-toolchain-')); roots.push(root)
  const bin = join(root, 'bin'); const parser = join(root, 'parser'); const log = join(root, 'calls.jsonl')
  mkdirSync(bin); mkdirSync(parser)
  writeFileSync(join(parser, 'Cargo.lock'), 'version = 4\n[[package]]\nname = "wasm-bindgen"\nversion = "0.2.125"\n')
  writeFileSync(join(root, 'config.json'), JSON.stringify(config))
  for (const tool of ['rustup', 'cargo', 'rustc', 'wasm-bindgen']) {
    if (config.missing === tool) continue
    writeFileSync(join(bin, tool), `#!${process.execPath}
const fs = require('node:fs'); const path = require('node:path');
const root = ${JSON.stringify(root)}; const tool = ${JSON.stringify(tool)};
const config = JSON.parse(fs.readFileSync(path.join(root, 'config.json'), 'utf8'));
const args = process.argv.slice(2); const active = process.env.RUSTUP_TOOLCHAIN || '1.89.0-test-host';
fs.appendFileSync(path.join(root, 'calls.jsonl'), JSON.stringify({tool,args,cwd:process.cwd(),auto:process.env.RUSTUP_AUTO_INSTALL,rustc:process.env.RUSTC,flags:process.env.RUSTFLAGS,encoded:process.env.CARGO_ENCODED_RUSTFLAGS})+'\\n');
if (tool === 'rustup') {
  if (args[0] === 'show') console.log(active+' (directory override)');
  else if (args[0] === 'which') console.log(path.join(root,'bin',args.at(-1)));
  else if (args[0] === 'target') {
    if (!args.includes('--toolchain') || args.at(-1) !== active) throw Error('target queried for wrong toolchain');
    console.log(config.noTarget ? 'aarch64-apple-darwin' : 'aarch64-apple-darwin\\nwasm32-unknown-unknown');
  } else throw Error('unexpected rustup command');
} else if (args[0] === '--version') console.log(tool+' '+(tool === 'wasm-bindgen' ? config.bindgen || '0.2.125' : config.rust || '1.89.0'));
`, { mode: 0o755 })
  }
  const env = { PATH: bin, CARGO_HOME: join(root, 'empty-cargo-home') }
  return { parser, bin, env, calls: () => readFileSync(log, 'utf8').trim().split('\n').map(line => JSON.parse(line)) }
}

describe('parser toolchain preflight with executable command probes', () => {
  it('uses the parser cwd override, selected targets and exact binaries for one build', () => {
    const f = fixture(); const env = { ...f.env, RUSTUP_TOOLCHAIN: 'custom-selected-toolchain', RUSTFLAGS: '-D warnings' }
    const checked = preflightParserToolchain(f.parser, { env })
    expect(checked.toolchain).toBe('custom-selected-toolchain')
    buildParserWasm(f.parser, { checked })
    const calls = f.calls()
    expect(calls.every(call => call.cwd === realpathSync(f.parser) && call.auto === '0')).toBe(true)
    expect(calls.find(call => call.args[0] === 'target').args).toEqual(['target', 'list', '--installed', '--toolchain', 'custom-selected-toolchain'])
    const builds = calls.filter(call => call.tool === 'cargo' && call.args[0] === 'build')
    expect(builds).toHaveLength(1)
    expect(builds[0].args).toEqual(expect.arrayContaining(['--locked', '--target', 'wasm32-unknown-unknown']))
    expect(builds[0].rustc).toBe(join(f.bin, 'rustc'))
    expect(builds[0].flags).toBe('-D warnings --force-warn deprecated')
    expect(checked.env.RUSTFLAGS).toBe('-D warnings')
    expect(calls.find(call => call.tool === 'wasm-bindgen' && call.args[0] !== '--version').flags).toBe('-D warnings')
    expect(calls.filter(call => call.tool === 'wasm-bindgen' && call.args[0] !== '--version')).toHaveLength(1)
    expect(calls.some(call => call.args.includes('install') || call.args.includes('add'))).toBe(false)
  }, 20_000)

  it.each([
    [{ missing: 'rustup' }, /rustup is missing.*build PATH/],
    [{ missing: 'cargo' }, /cargo is missing from selected toolchain/],
    [{ missing: 'rustc' }, /rustc is missing from selected toolchain/],
    [{ missing: 'wasm-bindgen' }, /cargo \+1\.89\.0-test-host install wasm-bindgen-cli --version 0\.2\.125 --locked/],
    [{ noTarget: true }, /rustup target add wasm32-unknown-unknown --toolchain 1\.89\.0-test-host/],
    [{ bindgen: '0.2.124' }, /does not match Cargo.lock 0\.2\.125/],
    [{ rust: '1.84.0' }, /supports Rust 1\.89\.0 or newer/],
  ])('stops before compilation and gives a remedy for %j', (config, error) => {
    const f = fixture(config)
    expect(() => buildParserWasm(f.parser, { env: f.env })).toThrow(error)
    if (config.missing !== 'rustup') expect(f.calls().some(call => call.args[0] === 'build')).toBe(false)
  })

  it('does not validate one compiler and then let RUSTC invoke another', () => {
    const f = fixture()
    expect(() => preflightParserToolchain(f.parser, { env: { ...f.env, RUSTC: '/another/rustc' } })).toThrow(/Unset RUSTC/)
  })

  it('preserves encoded warning policy and narrows only the parser deprecation lint', () => {
    const f = fixture()
    const env = { ...f.env, CARGO_ENCODED_RUSTFLAGS: '-D\x1fwarnings', RUSTFLAGS: '-D warnings' }
    buildParserWasm(f.parser, { env })
    const cargo = f.calls().find(call => call.tool === 'cargo' && call.args[0] === 'build')
    expect(cargo.encoded).toBe('-D\x1fwarnings\x1f--force-warn\x1fdeprecated')
    expect(env.CARGO_ENCODED_RUSTFLAGS).toBe('-D\x1fwarnings')
  }, 20_000)

  it('reads the expected CLI version from this parser lock', () => {
    const f = fixture()
    writeFileSync(join(f.parser, 'Cargo.lock'), '[[package]]\nname = "wasm-bindgen"\nversion = "0.2.126"\n')
    expect(() => preflightParserToolchain(f.parser, { env: f.env })).toThrow(/does not match Cargo.lock 0\.2\.126/)
  })
})


describe('CI parser CLI installation step', () => {
  // Execute the workflow's actual shell body against isolated tools; no install or network.
  const workflow = readFileSync(new URL('../.github/workflows/desktop-release.yml', import.meta.url), 'utf8')
  const body = workflow.split('      - name: Install parser-matched wasm-bindgen CLI\n        run: |\n')[1]?.split('\n      - name:')[0]
  const script = body?.split('\n').map(line => line.replace(/^          /, '')).join('\n')
  it.each([{ missing: 'wasm-bindgen' }, { bindgen: '0.2.124' }, { bindgen: '0.2.125' }])('installs only when needed for %j', config => {
    const f = fixture(config)
    expect(script).toBeTruthy()
    const run = spawnSync('/bin/bash', ['-c', script], { cwd: f.parser, env: f.env, encoding: 'utf8' })
    expect(run.status, run.stderr).toBe(0)
    const installs = f.calls().filter(call => call.tool === 'cargo' && call.args[0] === 'install')
    expect(installs).toHaveLength(config.bindgen === '0.2.125' ? 0 : 1)
    if (installs.length) expect(installs[0].args).toEqual(['install', 'wasm-bindgen-cli', '--version', '0.2.125', '--locked', '--force'])
  })
})

import assert from 'node:assert/strict';
import { readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { stripTypeScriptTypes } from 'node:module';
import { runInNewContext } from 'node:vm';
import { webcrypto } from 'node:crypto';
import { spawn } from 'node:child_process';

// One controller owns the child and its deadline. A JS timer inside synchronous
// WASM cannot stop it. Raw bytes/Replay never cross the child stdout boundary.
if (!process.argv.includes('--child')) {
  const args = process.argv.slice(2);
  assert(args.length === 1, 'Usage: node tools/benchmark-managed-replay-reuse.mjs --smoke | <existing.dem>');
  const child = spawn(process.execPath, ['--max-old-space-size=3072', fileURLToPath(import.meta.url), '--child', ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.pipe(process.stdout); child.stderr.pipe(process.stderr);
  const stop = () => child.kill('SIGKILL');
  const timer = setTimeout(() => { process.stderr.write('Benchmark exceeded 120 seconds\n'); stop(); }, 120_000);
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
  child.once('error', error => { clearTimeout(timer); process.stderr.write(error.message + '\n'); process.exitCode = 1; });
  child.once('exit', code => { clearTimeout(timer); process.off('SIGINT', stop); process.off('SIGTERM', stop); process.exitCode = code ?? 1; });
} else {
  await benchmark(process.argv.at(-1));
}

async function benchmark(input) {
  const smoke = input === '--smoke';
  const upstream = resolve(process.env.CS2D_UPSTREAM_DIR || '.local-data/upstream/cs2d');
  const viewer = readFileSync(resolve(upstream, 'apps/app/src/viewer/DemoAnalyzerView.vue'), 'utf8');
  const names = ['beginManagedLoad', 'isManagedLoadCurrent', 'assertManagedLoadCurrent', 'parseManagedFile', 'managedReplayReady', 'loadManagedDemo'];
  const functions = names.map(name => {
    const fn = viewer.match(new RegExp(`(?:async )?function ${name}\\([\\s\\S]*?\\n}(?=\\n)`))?.[0];
    assert(fn, `Missing Viewer function: ${name}`); return fn;
  }).join('\n');
  const file = smoke ? null : resolve(input);
  const byteSize = file ? statSync(file).size : 9;
  assert(byteSize > 0 && byteSize <= 128 * 1024 * 1024, 'Bounded benchmark accepts files up to 128 MiB');
  const readBytes = () => file ? readFileSync(file) : Buffer.from([80,66,68,69,77,83,50,0,1]);
  const hash = async bytes => Array.from(new Uint8Array(await webcrypto.subtle.digest('SHA-256', bytes)), byte => byte.toString(16).padStart(2,'0')).join('');
  const report = { kind: smoke ? 'SMOKE_ONLY' : 'NODE_WASM_COST_PROBE', byteSize, node: process.version, stages: [], limits: 'Local file transport replaces HTTP; no browser Worker transfer, rendering, stage ACK or OS cold-cache measurement.' };
  // Prepare the expected library identity without logging its hash. This read
  // warms the OS cache and is explicitly excluded from both load measurements.
  let started = performance.now(); const expectedHash = await hash(readBytes());
  report.identityPreparationMs = Math.round(performance.now()-started);
  let wasm; let wasmExports;
  if (!smoke) {
    wasm = await import(pathToFileURL(resolve(upstream, 'apps/app/src/viewer/parser/demo_parser.js')).href);
    started = performance.now();
    wasmExports = wasm.initSync({ module: readFileSync(resolve(upstream, 'apps/app/src/viewer/parser/demo_parser_bg.wasm')) });
    report.wasmInitMs = Math.round(performance.now()-started);
    report.wasmLinearBytesAfterInit = wasmExports.memory.buffer.byteLength;
  }
  const counters = { read: 0, parse: 0, digest: 0, flush: 0 };
  let parseTimings;
  const parser = { status: { value: 'idle' }, replay: { value: null }, voice: { value: null }, demoContentHash: { value: null }, hashLatencyMs: { value: null }, fileName: { value: 'benchmark.dem' },
    async parse(selectedFile) {
      counters.parse++;
      parser.replay.value = null; parser.status.value = 'parsing';
      const t = performance.now(); const bytes = new Uint8Array(await selectedFile.arrayBuffer());
      const readDone = performance.now(); const digest = await hash(bytes);
      const hashDone = performance.now();
      let parseDone = hashDone;
      if (smoke) parser.replay.value = { players: [], rounds: [] };
      else {
        const out = wasm.parse_demo(bytes, 8, undefined);
        parseDone = performance.now();
        try { parser.replay.value = JSON.parse(out.replay); } finally { out.free(); }
      }
      parseTimings = { fileArrayBufferMs: readDone-t, parserHashMs: hashDone-readDone, wasmParseMs: parseDone-hashDone, replayJsonMs: performance.now()-parseDone };
      parser.demoContentHash.value = digest; parser.hashLatencyMs.value = hashDone-readDone; parser.status.value='done';
    } };
  const events = [];
  const ctx = { managedLibraryMode: { value: true }, managedSource: { value: null }, pendingManagedImport: { value: null }, managedLoadGeneration: 0, managedReadyGeneration: -1, managedLoadAbort: null, managedParseTail: Promise.resolve(), winRateWorker: null, hostSelectedPlayerId: { value: null }, hostStageReady: { value: false }, routeLoading: { value: false }, parser, File, performance, AbortController,
    crypto: { subtle: { digest: (...args) => { counters.digest++; return webcrypto.subtle.digest(...args); } } },
    emitPlaybackEvent: event => events.push(event), replayReadyMessage: value => ({ type: 'REPLAY_READY', requestId: value.managedSource.requestId }),
    async nextTick() { counters.flush++; },
    async fetch(_url, options) {
      assert.equal(options.headers.Authorization, `Bearer benchmark-read-${counters.read+1}`);
      counters.read++;
      return new Response(new Blob([readBytes()]), { headers: { 'content-type': 'application/octet-stream', 'content-length': String(byteSize) } });
    } };
  runInNewContext(stripTypeScriptTypes(functions), ctx);
  let firstReplay;
  for (const stage of ['INITIAL_PARSE', 'REPEATED_PARSE_BASELINE', 'WARM_RESTORE']) {
    // Disable only eligibility for the baseline: same RESTORE command/read/parser,
    // now with the initialized WASM. Do not keep a previous Replay just for measurement.
    if (stage === 'REPEATED_PARSE_BASELINE') { ctx.managedReadyGeneration = -1; firstReplay = undefined; }
    const before = { ...counters }; const memoryBefore = process.memoryUsage();
    const t = performance.now();
    await ctx.loadManagedDemo({ requestId: stage, demoId: 'benchmark-demo', contentHash: expectedHash, originalFilename: 'benchmark.dem', byteSize, capabilityToken: `benchmark-read-${counters.read+1}`, mode: 'RESTORE' });
    const elapsedMs = performance.now()-t;
    assert.equal(events.at(-1)?.type, 'REPLAY_READY'); assert.equal(events.at(-1).requestId, stage);
    const calls = Object.fromEntries(Object.keys(counters).map(key => [key, counters[key]-before[key]]));
    assert.equal(calls.read, 1); assert.equal(calls.parse, stage==='WARM_RESTORE'?0:1);
    if (stage!=='WARM_RESTORE') firstReplay=parser.replay.value;
    else { assert(parser.replay.value === firstReplay, 'WARM_REPLAY_REFERENCE_CHANGED'); assert.equal(calls.digest,1); assert.equal(calls.flush,1); }
    report.stages.push({ stage, elapsedMs: Math.round(elapsedMs), calls, ...(stage!=='WARM_RESTORE' ? { parseTimings } : {}), memoryBefore, memoryAfter: process.memoryUsage(), wasmLinearBytes: wasmExports?.memory.buffer.byteLength ?? null, cumulativeMaxRssKiB: process.resourceUsage().maxRSS });
    process.stdout.write(JSON.stringify({ stage, elapsedMs: Math.round(elapsedMs), calls })+'\n');
  }
  report.roundCount=parser.replay.value.rounds.length; report.playerCount=parser.replay.value.players.length;
  report.omittedCosts='Cold wrapper omits voice decoding and cross-Worker cloning; warm nextTick is a scheduling stub. Hash and WASM Replay JSON work are real in non-smoke mode.';
  process.stdout.write(JSON.stringify(report)+'\n');
}

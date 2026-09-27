import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
const root = fileURLToPath(new URL('../', import.meta.url));
const mode = process.argv[2];
if (!['smoke', 'bounded'].includes(mode)) throw Error('Use smoke (88 frames) or bounded (10000 frames).');
const directory = resolve(root, '.local-data/ground-detail-cost-smoke'); mkdirSync(directory, { recursive: true });
const ownedTemporaryRoot = mkdtempSync(resolve(tmpdir(), 'cs-agent-ground-cost-'));
const started = performance.now();
const child = spawn(process.execPath, ['--max-old-space-size=2048', resolve(root, 'node_modules/vitest/vitest.mjs'), 'run', 'apps/web/lib/review-history/ground-detail-cost.test.ts', '--maxWorkers=1', '--no-file-parallelism', '--pool=forks'], {
  cwd: root, detached: true, stdio: ['ignore', 'pipe', 'pipe'],
  env: { ...process.env, TMPDIR: ownedTemporaryRoot, NODE_OPTIONS: '--max-old-space-size=2048', CS_AGENT_GROUND_DETAIL_COST: mode },
});
let output = '', size = 0, stopReason;
function stop(reason) { if (stopReason) return; stopReason = reason; try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); } }
const timeout = setTimeout(() => stop('WALL_TIMEOUT'), 120_000);
process.once('SIGINT', () => stop('INTERRUPTED'));
process.once('SIGTERM', () => stop('TERMINATED'));
for (const stream of [child.stdout, child.stderr]) stream.on('data', bytes => { size += bytes.length; if (size > 32 * 1024) return stop('OUTPUT_LIMIT'); output += bytes.toString(); });
child.on('error', () => { clearTimeout(timeout); console.error('MEASUREMENT_SPAWN_FAILED'); process.exitCode = 1; });
child.on('close', code => {
  clearTimeout(timeout); rmSync(ownedTemporaryRoot, { recursive: true, force: true }); writeFileSync(resolve(directory, `${mode}.txt`), output);
  const processSummary = { exitCode: code, stopReason: stopReason ?? null, wallMs: Math.round(performance.now() - started), outputBytes: size, testWorkerMaxOldSpaceMiB: 2048 };
  writeFileSync(resolve(directory, `${mode}-process.json`), JSON.stringify(processSummary, null, 2) + '\n');
  if (code !== 0 || stopReason) { console.error(JSON.stringify({ ...processSummary, error: 'MEASUREMENT_FAILED_SEE_BOUNDED_LOG' })); process.exitCode = 1; return; }
  const summary = JSON.parse(readFileSync(resolve(directory, `${mode}.json`), 'utf8'));
  console.log(JSON.stringify({ ...summary, process: processSummary }));
});

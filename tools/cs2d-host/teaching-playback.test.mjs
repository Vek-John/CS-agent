import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { describe, expect, it, vi } from 'vitest';

// Execute the exact helper shipped by the patch, without an upstream checkout
// or browser. This exercises runtime behavior rather than matching source text.
const patch = readFileSync(new URL('./patches/0008-teaching-playback.patch', import.meta.url), 'utf8');
const helperDiff = patch.split('diff --git ').find((section) => section.startsWith('a/apps/app/src/viewer/player/teachingPlayback.ts '));
const source = helperDiff.split('\n').filter((line) => line.startsWith('+') && !line.startsWith('+++')).map((line) => line.slice(1)).join('\n');
const { controlTeachingPlayback, canAdvanceTeachingPlayback, playWithoutTeachingTool } = new Function(stripTypeScriptTypes(source).replaceAll('export ', '') + '\nreturn { controlTeachingPlayback, canAdvanceTeachingPlayback, playWithoutTeachingTool };')();
const identity = { callId: 'call-1', runId: 'run-1', cueId: 'cue-1', generation: 2 };
const command = (action, override = {}) => ({ type: 'teachingPlayback', ...identity, action, ...override });
function harness() {
  let active = { command: { ...identity }, phase: 'PLAYING', paused: false };
  const original = active;
  const play = vi.fn(); const pause = vi.fn(); const emitState = vi.fn();
  const cancel = vi.fn(() => { active = null; });
  const control = (cmd) => controlTeachingPlayback(active, cmd, { play, pause, cancel, emitState });
  return { original, get active() { return active; }, play, pause, cancel, emitState, control };
}

describe('Viewer same-tool playback lifecycle', () => {
  it('ignores raw play during a tool, including paused and returning phases', () => {
    const h = harness();
    playWithoutTeachingTool(h.active, h.play);
    h.control(command('pause'));
    playWithoutTeachingTool(h.active, h.play);
    h.active.phase = 'RETURNING';
    playWithoutTeachingTool(h.active, h.play);
    expect(h.play).not.toHaveBeenCalled();
    h.control(command('cancel'));
    playWithoutTeachingTool(h.active, h.play);
    expect(h.play).toHaveBeenCalledTimes(1);
  });
  it('pauses and resumes the same tool without cancel or restart', () => {
    const h = harness();
    expect(h.control(command('pause'))).toBe(true);
    expect(h.active).toBe(h.original);
    expect(h.active.paused).toBe(true);
    expect(canAdvanceTeachingPlayback(h.active, h.original)).toBe(false);
    expect(h.pause).toHaveBeenCalledTimes(1);
    expect(h.control(command('resume'))).toBe(true);
    expect(canAdvanceTeachingPlayback(h.active, h.original)).toBe(true);
    expect(h.play).toHaveBeenCalledTimes(1);
    expect(h.cancel).not.toHaveBeenCalled();
    expect(h.emitState).toHaveBeenCalledTimes(2);
  });
  it('ignores stale identities, finished tools and already returning tools', () => {
    const h = harness();
    for (const mismatch of [{ callId: 'old' }, { runId: 'old' }, { cueId: 'old' }, { generation: 1 }]) expect(h.control(command('resume', mismatch))).toBe(false);
    h.active.phase = 'RETURNING';
    expect(h.control(command('pause'))).toBe(false);
    expect(h.control(command('resume'))).toBe(false);
    expect(h.play).not.toHaveBeenCalled();
    expect(h.emitState).not.toHaveBeenCalled();
    expect(h.control(command('cancel'))).toBe(true);
    expect(h.active).toBe(null);
    expect(h.control(command('resume'))).toBe(false);
  });
  it('prevents delayed startup and completion work after pause, cancel or replacement', () => {
    const h = harness();
    const delayedStart = () => { if (canAdvanceTeachingPlayback(h.active, h.original)) h.play(); };
    h.control(command('pause')); delayedStart();
    expect(h.play).not.toHaveBeenCalled();
    h.control(command('cancel')); delayedStart();
    expect(h.play).not.toHaveBeenCalled();
    expect(canAdvanceTeachingPlayback({ ...h.original, paused: false }, h.original)).toBe(false);
    expect(h.pause).toHaveBeenCalledTimes(2);
  });
});

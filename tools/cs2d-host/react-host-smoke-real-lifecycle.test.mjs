import { afterEach, expect, it, vi } from 'vitest';
import { allowedRealDemoFiles, realDemoDeadlines, REAL_DEMO_INPUT_LIMIT } from './react-host-smoke-real-lifecycle.ts';
afterEach(()=>vi.useRealTimers());
it('checks the input bound before any reader starts, without opening files',()=>{
 expect(allowedRealDemoFiles([{name:'small.dem',size:8}])).toBe(true);
 expect(allowedRealDemoFiles([{name:'limit.dem',size:REAL_DEMO_INPUT_LIMIT}])).toBe(true);
 for(const files of [[],[{name:'archive.zip',size:8}],[{name:'empty.dem',size:0}],[{name:'large.dem',size:REAL_DEMO_INPUT_LIMIT+1}],[{name:'a.dem',size:8},{name:'b.dem',size:8}]])expect(allowedRealDemoFiles(files)).toBe(false);
});
it('keeps parsing/cache and selected pipeline deadlines independent and never times user selection',()=>{
 vi.useFakeTimers();const timeout=vi.fn(),gate=realDemoDeadlines(timeout);
 gate.start('parse');vi.advanceTimersByTime(100_000);gate.start('pipeline');vi.advanceTimersByTime(20_000);
 expect(timeout).toHaveBeenCalledTimes(1);expect(vi.getTimerCount()).toBe(0);
 timeout.mockClear();gate.start('parse');gate.finish('parse');vi.advanceTimersByTime(300_000);expect(timeout).not.toHaveBeenCalled();
 gate.start('pipeline');vi.advanceTimersByTime(119_999);expect(timeout).not.toHaveBeenCalled();gate.finish();vi.advanceTimersByTime(1);expect(timeout).not.toHaveBeenCalled();expect(vi.getTimerCount()).toBe(0);
});

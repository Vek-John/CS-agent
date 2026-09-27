import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { expect, it, vi } from "vitest";
import { TeachingSubmissionRequest } from "./teaching-submission-request";
import { HistoryPersistenceController } from "../review-history/history-persistence-controller";
const { transformSync } = createRequire(new URL("../../../../libs/coach-agent/package.json", import.meta.url))("esbuild") as { transformSync(source: string, options: { loader: string; format: string }): { code: string } };
function actualCallback(name: string, scope: Record<string, unknown>): (...args: unknown[]) => Promise<unknown> {
  const source = readFileSync(new URL("../../components/playback/cs2d-playback-host.tsx", import.meta.url), "utf8");
  const start = source.indexOf(`const ${name} = useCallback(`) + `const ${name} = useCallback(`.length;
  const end = source.indexOf("\n  }, [", start) + 4;
  if (start < 30 || end < start) throw Error("HOST_CALLBACK_NOT_FOUND");
  const code = transformSync(`export const callback = ${source.slice(start, end)};`, { loader: "ts", format: "cjs" }).code;
  return new Function("scope", "module", `with(scope){${code}} return module.exports.callback;`)(scope, { exports: {} });
}
function deferred() { let resolve!: () => void; const promise = new Promise<void>(yes => { resolve = yes; }); return { promise, resolve }; }
it.each(["submitTeachingReflection", "disagreeTeachingDiagnosis"])("%s claims pending synchronously before the actual history write and refuses a second click", async name => {
  const write = deferred(), append = vi.fn(() => write.promise), busy = vi.fn();
  const history = new HistoryPersistenceController({ createReview: vi.fn(), startRevision: vi.fn(), appendArtifact: append, commitRuntimeHead: vi.fn(), markFailed: vi.fn() });
  history.adopt("review", "revision", "demo");
  let live = true;
  const cue = { id: "cue" }, context = { cue, plan: {} };
  const scope = { generationRef: { current: 1 }, diagnosisRequestEpochRef: { current: 0 }, historyPersistenceControllerRef: { current: history },
    isTeachingDiagnosisRequestLive: () => live, diagnosisContext: () => context, liveCueRef: { current: cue }, cue,
    teachingSubmissionRequestRef: { current: new TeachingSubmissionRequest() }, teachingThreadsRef: { current: [] },
    teachingCasesRef: { current: { cue: { reflection: { cueId: "cue" }, attemptBudget: { disagreement: 0 } } } },
    setDiagnosticBusyCueId: busy, setDiagnosticError: vi.fn(), setHistoryError: vi.fn(),
  };
  const callback = actualCallback(name, scope), reflection = { cueId: "cue", source: "USER", response: "ANSWERED", limitations: [] };
  const first = callback(reflection), second = callback(reflection);
  try { expect({ busy: busy.mock.calls, writes: append.mock.calls.length }).toEqual({ busy: [["cue"]], writes: 1 }); }
  finally { live = false; write.resolve(); await Promise.all([first, second]); }
});

import { persistTeachingBeforeRuntimeHead } from "../playback/cs2d-playback-host";

it("an obsolete save failure cannot execute, publish an error or release a newer cue's pending state", async () => {
  const gate = new TeachingSubmissionRequest(), old = deferred(), newer = deferred();
  let cue = "old", epoch = 0, pending: string | undefined;
  const executed = vi.fn(), failed = vi.fn();
  const submit = (id: string, persistence: Promise<void>) => gate.run({ claim: () => {
    const owned = ++epoch; return { isCurrent: () => id === cue && owned === epoch, release: () => { if (owned === epoch) pending = undefined; } };
  }, pending: () => { pending = id; }, persistInteraction: () => persistence, interactionFailed: failed, execute: executed });
  const first = submit("old", old.promise.then(() => { throw Error("OLD_SAVE_FAILED"); }));
  cue = "new"; const second = submit("new", newer.promise);
  old.resolve(); await first; expect(pending).toBe("new"); expect(failed).not.toHaveBeenCalled(); expect(executed).not.toHaveBeenCalled();
  newer.resolve(); await second; expect(pending).toBeUndefined(); expect(executed).toHaveBeenCalledOnce();
});

it.each(["cue", "generation", "history", "skip", "takeover"])("actual Host reflection callback discards a late write after %s changes", async change => {
  const write = deferred(), append = vi.fn(() => write.promise), busy = vi.fn(), errors = vi.fn();
  const history = new HistoryPersistenceController({ createReview: vi.fn(), startRevision: vi.fn(), appendArtifact: append, commitRuntimeHead: vi.fn(), markFailed: vi.fn() });
  history.adopt("review", "revision", "demo");
  const generation = { current: 1 }, epoch = { current: 0 }, liveCue = { current: { id: "cue" } };
  let takenOver = false;
  const diagnostic = vi.fn();
  const scope = { generationRef: generation, diagnosisRequestEpochRef: epoch, historyPersistenceControllerRef: { current: history },
    liveCueRef: liveCue, cue: liveCue.current, diagnosisContext: () => ({ cue: liveCue.current, plan: {} }),
    isTeachingDiagnosisRequestLive: (id: string, g: number, e: number) => id === liveCue.current.id && g === generation.current && e === epoch.current && !takenOver,
    teachingSubmissionRequestRef: { current: new TeachingSubmissionRequest() }, setDiagnosticBusyCueId: busy, setDiagnosticError: errors, setHistoryError: errors,
    runTeachingDiagnosis: diagnostic,
  };
  const promise = actualCallback("submitTeachingReflection", scope)({ cueId: "cue", response: "ANSWERED", source: "USER", limitations: [] });
  if (change === "cue") liveCue.current = { id: "next" };
  if (change === "generation") generation.current++;
  if (change === "history") history.adopt("other", "other-revision", "other-demo");
  if (change === "skip") epoch.current++;
  if (change === "takeover") takenOver = true;
  errors.mockClear(); write.resolve(); await promise;
  expect(diagnostic).not.toHaveBeenCalled(); expect(errors).not.toHaveBeenCalled();
});

it("current interaction failure continues local diagnosis but cannot commit a head", async () => {
  const gate = new TeachingSubmissionRequest(), persist = vi.fn(async () => { throw Error("SAVE_FAILED"); }), failure = vi.fn();
  const local = vi.fn(async () => true), mirror = vi.fn(); let busy = false;
  await gate.run({ claim: () => ({ isCurrent: () => true, release: () => { busy = false; } }), pending: () => { busy = true; },
    persistInteraction: persist, interactionFailed: failure, execute: async interactionDurable => {
      expect(busy).toBe(true); expect(interactionDurable).toBe(false);
      expect(await persistTeachingBeforeRuntimeHead({ interactionDurable, persistDiagnosis: local, mirror })).toBe("ARTIFACTS_INCOMPLETE");
    } });
  expect(failure).toHaveBeenCalledOnce(); expect(local).toHaveBeenCalledOnce(); expect(mirror).not.toHaveBeenCalled(); expect(busy).toBe(false);
});

it.each(["wrong-cue", "budget", "no-context"])("actual Host disagreement rejects %s before writing or becoming busy", async kind => {
  const append = vi.fn(), busy = vi.fn();
  const history = new HistoryPersistenceController({ createReview: vi.fn(), startRevision: vi.fn(), appendArtifact: append, commitRuntimeHead: vi.fn(), markFailed: vi.fn() });
  history.adopt("review", "revision", "demo");
  const cue = { id: "cue" };
  const scope = { generationRef: { current: 1 }, diagnosisRequestEpochRef: { current: 0 }, historyPersistenceControllerRef: { current: history },
    isTeachingDiagnosisRequestLive: () => true, diagnosisContext: () => kind === "no-context" ? undefined : ({ cue, plan: {} }), liveCueRef: { current: cue }, cue,
    teachingCasesRef: { current: { cue: { reflection: { cueId: "cue" }, attemptBudget: { disagreement: kind === "budget" ? 1 : 0 } } } },
    teachingSubmissionRequestRef: { current: new TeachingSubmissionRequest() }, setDiagnosticBusyCueId: busy,
  };
  await actualCallback("disagreeTeachingDiagnosis", scope)({ cueId: kind === "wrong-cue" ? "old" : "cue" });
  expect(append).not.toHaveBeenCalled(); expect(busy).not.toHaveBeenCalled();
});

import { diagnoseTeachingCue } from "@cs-coach/coach-agent/client";
it.each(["resolved", "rejected"])("actual diagnosis artifact chain stops after an ownership change with a %s save", async outcome => {
  const write = deferred(); let current = true;
  const append = vi.fn(() => outcome === "rejected" ? write.promise.then(() => { throw Error("LATE_FAILURE"); }) : write.promise);
  const history = new HistoryPersistenceController({ createReview: vi.fn(), startRevision: vi.fn(), appendArtifact: append, commitRuntimeHead: vi.fn(), markFailed: vi.fn() });
  history.adopt("review", "revision", "demo");
  const errors = vi.fn();
  const scope = { setTeachingCases: vi.fn(), setTeachingThreads: vi.fn(), setSession: vi.fn(), planRef: { current: {} },
    historyPersistenceControllerRef: { current: history }, setHistoryError: errors };
  const output = diagnoseTeachingCue({ cueId: "cue", reflection: { cueId: "cue", selectedGoal: "GET_INFO", source: "USER", response: "ANSWERED", limitations: [] },
    decisionFacts: [], playerActionFacts: [], outcomeFacts: [], decisionResources: { evidenceRefs: [] } });
  const pending = actualCallback("applyTeachingDiagnosis", scope)(output, { isCurrent: () => current, history });
  expect(append).toHaveBeenCalledOnce(); current = false; history.adopt("other", "other-revision", "other-demo"); write.resolve();
  expect(await pending).toBe(false); expect(append).toHaveBeenCalledOnce(); expect(errors).not.toHaveBeenCalled();
});

it("all early exits and thrown execution release only their owned pending state", async () => {
  const gate = new TeachingSubmissionRequest(), release = vi.fn(), pending = vi.fn();
  const common = { claim: () => ({ isCurrent: () => true, release }), pending, persistInteraction: async () => {}, interactionFailed: vi.fn() };
  await gate.run({ ...common, execute: async () => {} });
  await expect(gate.run({ ...common, execute: async () => { throw Error("EXECUTION_FAILED"); } })).rejects.toThrow("EXECUTION_FAILED");
  expect(pending).toHaveBeenCalledTimes(2); expect(release).toHaveBeenCalledTimes(2);
});

import { baselineCueCase, reflectionForSkip } from "./teaching-diagnosis-host";
import { skipReflectionToBaseline } from "./skip-reflection-flow";
it("actual Host skip preempts a delayed submit and its late completion cannot clear the next cue's busy state", async () => {
  const old = deferred(), next = deferred();
  const append = vi.fn(async (_review, input) => {
    if (input.artifactType === "USER_INTERACTION" && input.payload.kind === "REFLECTION")
      await (input.payload.reflection.cueId === "cue" ? old.promise : next.promise);
  });
  const history = new HistoryPersistenceController({ createReview: vi.fn(), startRevision: vi.fn(), appendArtifact: append, commitRuntimeHead: vi.fn(), markFailed: vi.fn() });
  history.adopt("review", "revision", "demo");
  const generation = { current: 1 }, epoch = { current: 0 }, liveCue = { current: { id: "cue" } };
  let busy: string | undefined;
  const errors = vi.fn(), diagnostic = vi.fn(), cases = { current: {} as Record<string, ReturnType<typeof baselineCueCase>> };
  const scope = { generationRef: generation, diagnosisRequestEpochRef: epoch, historyPersistenceControllerRef: { current: history },
    liveCueRef: liveCue, cue: liveCue.current, liveSessionRef: { current: { current_cue_id: "cue", phase: "PAUSED_FOR_COACHING", outcome_completion: { cueId: "cue", status: "COMPLETE" } } },
    diagnosisContext: () => ({ cue: liveCue.current, plan: {} }),
    isTeachingDiagnosisRequestLive: (id: string, g: number, e: number) => id === liveCue.current.id && g === generation.current && e === epoch.current,
    teachingSubmissionRequestRef: { current: new TeachingSubmissionRequest() }, setDiagnosticBusyCueId: (value: string | undefined) => { busy = value; },
    setDiagnosticError: errors, setHistoryError: errors, runTeachingDiagnosis: diagnostic, teachingCasesRef: cases,
    reflectionForSkip, baselineCueCase, skipReflectionToBaseline, planRef: { current: {} }, activePlan: {}, setTeachingCases: vi.fn(), setSession: vi.fn(),
    historyPlaybackOnlyRef: { current: true }, stage3IdentityContext: undefined,
  };
  const submit = actualCallback("submitTeachingReflection", scope), skip = actualCallback("skipTeachingReflection", scope);
  const first = submit({ cueId: "cue", response: "ANSWERED", source: "USER", limitations: [] }); expect(busy).toBe("cue");
  await skip(); expect(busy).toBeUndefined(); expect(cases.current.cue.reflection?.response).toBe("SKIPPED");
  liveCue.current = { id: "next" };
  const second = submit({ cueId: "next", response: "ANSWERED", source: "USER", limitations: [] }); expect(busy).toBe("next");
  errors.mockClear(); old.resolve(); await first;
  expect(busy).toBe("next"); expect(diagnostic).not.toHaveBeenCalled(); expect(errors).not.toHaveBeenCalled();
  epoch.current++; busy = undefined; next.resolve(); await second;
});

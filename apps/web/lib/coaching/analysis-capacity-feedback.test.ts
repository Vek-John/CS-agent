import { analysisFailureFeedback } from "./analysis-failure-feedback";
import { existsSync, readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { runInNewContext } from "node:vm";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { buildCs2dAnalysisBundle, serializeCs2dAnalysisBundle } from "@cs-coach/cs2d-analysis-adapter";
import { eventEnvelope, isPlaybackEventEnvelope, type AnalysisFailedEvent } from "@cs-coach/contracts";
import { analysisEventMatchesSelectedPlayer } from "../playback/cs2d-playback-host";
import { fireReplay, self } from "../../../../libs/cs2d-analysis-adapter/src/window-self-fire-fixtures";

const viewerPath = resolve(".local-data/upstream/cs2d/apps/app/src/viewer/DemoAnalyzerView.vue");
const viewer = existsSync(viewerPath) ? readFileSync(viewerPath, "utf8") : "";
const host = readFileSync(new URL("../../components/playback/cs2d-playback-host.tsx", import.meta.url), "utf8");
function hostFeedback(payload: AnalysisFailedEvent, selectedId = self) {
  const start = host.indexOf('      if (payload.type === "ANALYSIS_FAILED")');
  const end = host.indexOf('      if (payload.type === "ANALYSIS_READY")', start);
  const context: Record<string, any> = { analysisFailureFeedback, selectedPlayerIdRef: { current: selectedId }, historyDurabilityReadyRef: {}, routeStateRef: {}, planRef: {}, userTookOverRef: {},
    historyPersistenceControllerRef: { current: { markFailed: vi.fn(async () => {}) } }, refreshReviewHistory: vi.fn(),
    analysisEventMatchesSelectedPlayer,
  };
  for (const name of ["invalidateGeneration", "invalidateGuidedSeek", "setAnalysisError", "setAnalysisProgress", "setBundle", "setPlan", "setRouteState", "setNarrationByCue", "setSession", "setTeachingCases", "setTeachingThreads", "setDiagnosticBusyCueId", "setDiagnosticError", "setReviewPreparationStatus", "setUserTookOver", "setHistoryError"]) context[name] = vi.fn();
  runInNewContext(`function receive(payload) { ${host.slice(start, end)} }`, context);
  context.receive(payload); return context;
}
describe.skipIf(!viewer)("actual capacity error through Viewer and Host", () => {
  it("keeps the real serializer limit and tells the user identical retry cannot solve capacity", async () => {
    const replay = fireReplay("DEATH", []), events: any[] = [];
    const bundle = buildCs2dAnalysisBundle({ replay, selectedSteamId: self, demoId: "synthetic-capacity" });
    const context: Record<string, any> = { Error, hostMode: { value: true }, hostSelectionLocked: { value: false }, managedLibraryMode: { value: false }, managedLoadGeneration: 0, managedReadyGeneration: 0, managedSource: { value: undefined }, hostStageReady: { value: false }, hostSelectedPlayerId: { value: null },
      parser: { replay: { value: replay }, demoContentHash: { value: undefined }, hashLatencyMs: { value: undefined } }, route: { params: {} }, nextTick: async () => {}, inferWinRate: async () => undefined,
      buildCs2dAnalysisBundle: () => ({ ...bundle, metadata: { ...bundle.metadata, limitations: ["x".repeat(16 * 1024 * 1024 + 1)] } }), serializeCs2dAnalysisBundle,
      emitPlaybackEvent: (event: any) => events.push(event),
    };
    const fn = viewer.match(/async function selectHostPlayer\([\s\S]*?\n}(?=\n)/)?.[0]; expect(fn).toBeDefined();
    runInNewContext(stripTypeScriptTypes(fn!), context); await context.selectHostPlayer(self);
    const failed = events.find(event => event.type === "ANALYSIS_FAILED");
    expect(failed?.message).toBe("AnalysisBundle exceeds 16 MiB.");
    expect(isPlaybackEventEnvelope(eventEnvelope(failed))).toBe(true);
    expect(events.some(event => event.type === "ANALYSIS_READY")).toBe(false);
    const feedback = hostFeedback(failed);
    expect(feedback.setAnalysisError.mock.calls[0][0]).toContain("原样重试");
  });
});

it.each([
  "AnalysisBundle exceeds 16 MiB.",
  "Analysis candidate windows exceed 512; analysis stopped without truncating timeline coverage.",
  "Analysis candidate windows exceed 512.",
])("maps only the exact known capacity error %s through the real Host branch", message => {
  const c = hostFeedback({ type: "ANALYSIS_FAILED", schemaVersion: "cs2d-analysis-failed.v1", selectedPlayerId: self, message });
  expect(c.setAnalysisError).toHaveBeenCalledWith(analysisFailureFeedback(message));
  expect(c.setAnalysisError.mock.calls[0][0]).toContain("原样重试不会改变结果");
  expect(c.invalidateGeneration).toHaveBeenCalledOnce(); expect(c.setPlan).toHaveBeenCalledWith(undefined);
  expect(c.historyPersistenceControllerRef.current.markFailed).toHaveBeenCalledOnce();
});
it.each([undefined, null, 16, {}, "prefix AnalysisBundle exceeds 16 MiB.", "AnalysisBundle exceeds 16 MiB. suffix", "AnalysisBundle exceeds 16 MiB. ", "Other failure"])("keeps unknown or non-exact messages on generic feedback: %j", message => {
  expect(analysisFailureFeedback(message)).toBe("比赛分析暂时未能完成，请重新选择比赛或玩家。");
});
it("keeps obsolete player failures outside the existing Host failure mutations", () => {
  const c = hostFeedback({ type: "ANALYSIS_FAILED", schemaVersion: "cs2d-analysis-failed.v1", selectedPlayerId: "other", message: "AnalysisBundle exceeds 16 MiB." });
  expect(c.setAnalysisError).not.toHaveBeenCalled(); expect(c.invalidateGeneration).not.toHaveBeenCalled();
  expect(c.historyPersistenceControllerRef.current.markFailed).not.toHaveBeenCalled();
});
it("reaches the current 512 candidate production gate without dropping timeline content", () => {
  const source = fireReplay("DEATH", []), round = source.rounds[0];
  const replay = { ...source, rounds: [{ ...round, events: Array.from({ length: 513 }, () => round.events[0]) }] };
  let message: unknown;
  try { buildCs2dAnalysisBundle({ replay, selectedSteamId: self, demoId: "synthetic-capacity-candidates" }); } catch (error) { message = error instanceof Error ? error.message : undefined; }
  expect(message).toBe("Analysis candidate windows exceed 512; analysis stopped without truncating timeline coverage.");
  expect(analysisFailureFeedback(message)).toContain("原样重试不会改变结果");
});
it("shows stopped feedback in the actual heading and setup expression, preserving other heading priorities", () => {
  const expression = host.match(/<h2>\{([^\n]+)\}<\/h2>/)?.[1]; expect(expression).toBeDefined();
  const start = host.indexOf("  const setupSteps:"), end = host.indexOf("\n  ];", start) + "\n  ];".length;
  const state = { analysisError: undefined as string | undefined, teachingPlayback: undefined, transportPaused: false,
    session: undefined, userTookOver: false, selected: { displayName: "Synthetic" }, routeState: undefined,
    phaseText: {}, replay: { map: "synthetic", roundCount: 1 }, phase: "READY", reviewPreparationStatus: undefined,
    analysisProgressText: "", analysisPercent: undefined };
  expect(runInNewContext(expression!, state)).toBe("正在分析 Synthetic");
  state.analysisError = analysisFailureFeedback("AnalysisBundle exceeds 16 MiB.");
  expect(runInNewContext(expression!, state)).toBe("分析未完成");
  const steps = runInNewContext(stripTypeScriptTypes(host.slice(start, end)) + "\nsetupSteps", state);
  expect(steps[2]).toMatchObject({ state: "error", detail: "本次分析已停止，完整教学复盘尚未就绪。" });
  expect(steps[2].detail).not.toContain("正在构建");
  expect(runInNewContext(expression!, { ...state, analysisError: undefined, teachingPlayback: { paused: true } })).toBe("演示已暂停");
  expect(runInNewContext(expression!, { ...state, analysisError: undefined, userTookOver: true })).toBe("自由查看");
});

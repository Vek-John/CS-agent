import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import {
  HISTORY_ANALYSIS_EVENT_TYPES,
  ignoreHistoryAnalysisEvent,
  runHistoryAnalysisGeneration,
} from "./generation-gate";

describe("saved Review generation gate", () => {
  it("keeps every real Host generation provider at zero calls during history playback", async () => {
    const hostSource = readFileSync(
      new URL("../../components/playback/cs2d-playback-host.tsx", import.meta.url),
      "utf8",
    );
    expect(hostSource).toMatch(/payload\.type === "ANALYSIS_READY"[\s\S]{0,240}runHistoryAnalysisGeneration\(historyPlaybackOnlyRef\.current/u);
    const bridgeGate = hostSource.indexOf(
      "ignoreHistoryAnalysisEvent(historyPlaybackOnlyRef.current, payload.type)",
    );
    const managedContextGate = hostSource.indexOf("managedReplayContextRequired(payload.type)", bridgeGate);
    expect(bridgeGate).toBeGreaterThan(0);
    expect(managedContextGate).toBeGreaterThan(bridgeGate);
    for (const branch of HISTORY_ANALYSIS_EVENT_TYPES) {
      expect(bridgeGate).toBeLessThan(hostSource.indexOf(`payload.type === "${branch}"`));
    }
    const replayReadyBranch = hostSource.indexOf('payload.type === "REPLAY_READY"');
    const managedReplayGate = hostSource.indexOf("managedReplayMatchesExpected(expectedManagedSourceRef.current, payload)", replayReadyBranch);
    const replayRefAssignment = hostSource.indexOf("replayRef.current = payload", replayReadyBranch);
    const playerSelectedBranch = hostSource.indexOf('payload.type === "PLAYER_SELECTED"');
    expect(managedContextGate).toBeLessThan(playerSelectedBranch);
    expect(replayRefAssignment).toBeGreaterThan(replayReadyBranch);
    expect(managedReplayGate).toBeGreaterThan(replayReadyBranch);
    expect(managedReplayGate).toBeLessThan(replayRefAssignment);
    expect(replayRefAssignment).toBeLessThan(playerSelectedBranch);
    expect(hostSource.slice(playerSelectedBranch, playerSelectedBranch + 1_600)).toMatch(
      /const currentReplay = replayRef\.current;[\s\S]*currentReplay\?\.sourceKind === "MANAGED_LIBRARY"/u,
    );
    expect(hostSource).toMatch(/const openEpoch = \+\+historyOpenEpochRef\.current/u);
    const adoptedDispatch = hostSource.indexOf('type: "SESSION_STARTED"');
    const adoptedEpochCheck = hostSource.indexOf("assertCurrentOpen();", adoptedDispatch);
    const adoptedCommit = hostSource.indexOf("acceptRecoveryResult(adopted)", adoptedDispatch);
    expect(adoptedEpochCheck).toBeGreaterThan(adoptedDispatch);
    expect(adoptedEpochCheck).toBeLessThan(adoptedCommit);
    const providers = {
      director: vi.fn(),
      narrator: vi.fn(),
      reflection: vi.fn(),
      adaptive: vi.fn(),
      embedding: vi.fn(),
    };
    const runActualHostGenerationBranch = async () => {
      await providers.director();
      await providers.narrator();
      await providers.reflection();
      await providers.adaptive();
      await providers.embedding();
    };

    await expect(runHistoryAnalysisGeneration(
      true,
      runActualHostGenerationBranch,
    )).resolves.toEqual({ status: "RESTORE_ONLY" });
    for (const provider of Object.values(providers)) expect(provider).toHaveBeenCalledTimes(0);

    await expect(runHistoryAnalysisGeneration(
      false,
      runActualHostGenerationBranch,
    )).resolves.toMatchObject({ status: "GENERATED" });
    for (const provider of Object.values(providers)) expect(provider).toHaveBeenCalledTimes(1);
  });

  it("drops late progress, telemetry, failure, and ready effects before they can mutate a restored Review", () => {
    const effects = {
      progress: vi.fn(),
      telemetry: vi.fn(),
      markFailedAndClearSession: vi.fn(),
      startGeneration: vi.fn(),
    };
    const effectByEvent = {
      ANALYSIS_PROGRESS: effects.progress,
      ANALYSIS_TELEMETRY: effects.telemetry,
      ANALYSIS_FAILED: effects.markFailedAndClearSession,
      ANALYSIS_READY: effects.startGeneration,
    } as const;

    for (const eventType of HISTORY_ANALYSIS_EVENT_TYPES) {
      if (!ignoreHistoryAnalysisEvent(true, eventType)) effectByEvent[eventType]();
    }
    for (const effect of Object.values(effects)) expect(effect).toHaveBeenCalledTimes(0);

    for (const eventType of HISTORY_ANALYSIS_EVENT_TYPES) {
      if (!ignoreHistoryAnalysisEvent(false, eventType)) effectByEvent[eventType]();
    }
    for (const effect of Object.values(effects)) expect(effect).toHaveBeenCalledTimes(1);
  });
});

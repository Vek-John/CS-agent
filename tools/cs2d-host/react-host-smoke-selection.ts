import { buildCs2dAnalysisBundle, serializeCs2dAnalysisBundle } from "../../libs/cs2d-analysis-adapter/src/index";
import type { AnalysisReadyEvent, PlayerSelectedEvent } from "../../libs/contracts/src/playback-bridge";
import { twoCueViewerPlayer, type twoCueViewerReplay } from "./viewer-two-cue-fixture";

/** Explicit synthetic replacement for DemoAnalyzerView's player selection, not a product UI. */
export function createSyntheticHostSelection(
  replay: ReturnType<typeof twoCueViewerReplay>,
  isLoaded: () => boolean,
  emit: (event: PlayerSelectedEvent | AnalysisReadyEvent) => void,
) {
  let selected = false;
  return (playerId: string): boolean => {
    if (!isLoaded() || selected || playerId !== twoCueViewerPlayer) return false;
    selected = true;
    emit({ type: "PLAYER_SELECTED", playerId, displayName: "Synthetic T", side: "T", selectionIndex: 0 });
    const bundle = buildCs2dAnalysisBundle({ replay, selectedSteamId: playerId, demoId: "synthetic-react-host", demoContentHash: "a".repeat(64) });
    emit({ type: "ANALYSIS_READY", schemaVersion: "cs2d-analysis-ready.v1", selectedPlayerId: playerId, bundleJson: serializeCs2dAnalysisBundle(bundle) });
    return true;
  };
}

export interface SyntheticRecoveryMarker {
  nonce: string;
  captured: boolean;
  reloaded?: boolean;
  recoveryId?: string;
  targetTick?: number;
  localKeys: string[];
  firstRun?: { analysisReady: number; prepareRoute: number; prepareNarration: number; savedNarrationCount?: number; consumedCueCount?: number };
}
/** Test-only reload permission. No recovery records are read or removed here. */
export function syntheticRecoveryAdmission(nonce: string, marker: SyntheticRecoveryMarker | undefined, databases: readonly string[], localKeys: readonly string[]): "FRESH" | "RELOAD" | "REJECT" {
  if (!/^[a-f0-9]{32}$/.test(nonce)) return "REJECT";
  if (!marker && databases.length === 0 && localKeys.length === 0) return "FRESH";
  return marker?.nonce === nonce && marker.captured === true && marker.reloaded !== true && typeof marker.recoveryId === "string" &&
    Number.isSafeInteger(marker.targetTick) && databases.every(name => name === "cs-coach-host-recovery") && databases.length === 1 &&
    localKeys.every(key => marker.localKeys.includes(key)) ? "RELOAD" : "REJECT";
}

/** Observe only new production writes, and report only after their transaction commits. */
export function observeSyntheticRecoveryWrites(onCommit: (record: unknown) => void, prototype = IDBObjectStore.prototype): () => void {
  const original = prototype.put;
  const wrapped: typeof original = function (this: IDBObjectStore, value, key) {
    const request = key === undefined ? original.call(this, value) : original.call(this, value, key);
    if (this.name === "session-recovery-records" && this.transaction.db.name === "cs-coach-host-recovery") {
      this.transaction.addEventListener("complete", () => onCommit(value), { once: true });
    }
    return request;
  };
  prototype.put = wrapped;
  return () => { if (prototype.put === wrapped) prototype.put = original; };
}

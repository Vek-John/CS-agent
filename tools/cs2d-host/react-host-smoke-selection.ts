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

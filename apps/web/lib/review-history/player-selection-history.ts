import type { HistoryPersistenceController } from "./history-persistence-controller";

export interface PlayerSelectionHistoryInput {
  history: HistoryPersistenceController | null | undefined;
  replay: { sourceKind?: string; demoId?: string; map: string } | undefined;
  player: { playerId: string; displayName: string };
  recoveryPending: boolean;
  useExistingReview: boolean;
  /** Stable selection owner: Replay, player, history-open epoch and Controller, not analysis generation. */
  isCurrent: () => boolean;
  onCreated: (reviewId: string) => void;
  onError: () => void;
}

/** Own the managed-player history side effect separately from playback/analysis state resets. */
export async function selectPlayerHistory(input: PlayerSelectionHistoryInput): Promise<void> {
  const { history, replay, player } = input;
  if (!history || !input.isCurrent() || input.recoveryPending || input.useExistingReview || replay?.sourceKind !== "MANAGED_LIBRARY" || !replay.demoId) return;
  const pending = history.createForPlayer({ demoId: replay.demoId, selectedPlayerId: player.playerId,
    selectedPlayerName: player.displayName, title: `${replay.map} · ${player.displayName}`, mapName: replay.map });
  // createForPlayer synchronously establishes its generation before its first await.
  const owner = history.ownershipGeneration;
  const current = () => history.ownershipGeneration === owner && input.isCurrent();
  try {
    const reviewId = await pending;
    if (current()) input.onCreated(reviewId);
  } catch {
    if (current()) input.onError();
  }
}

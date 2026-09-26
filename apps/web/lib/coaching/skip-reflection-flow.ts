import type { CueCase } from "@cs-coach/contracts";
import { persistTeachingBeforeRuntimeHead, type TeachingBoundaryDurability } from "../playback/cs2d-playback-host";

/** Show prepared narration immediately; only the captured review may receive its background writes. */
export async function skipReflectionToBaseline(input: {
  baseline: CueCase;
  isCurrent(): boolean;
  ownsHistory(): boolean;
  publishLocal(cueCase: CueCase): void;
  reconcile(cueCase: CueCase): void;
  persistInteraction(): Promise<boolean>;
  synchronize(): Promise<{ cueCase: CueCase; mirror(): Promise<void> } | undefined>;
  persistCase(cueCase: CueCase): Promise<boolean>;
}): Promise<TeachingBoundaryDurability> {
  if (!input.isCurrent()) return "NO_AGENT_CHECKPOINT";
  input.publishLocal(input.baseline);
  const interactionDurable = await input.persistInteraction();
  const synchronized = input.isCurrent() && input.ownsHistory() ? await input.synchronize() : undefined;
  const accepted = input.isCurrent() && input.ownsHistory() &&
    synchronized?.cueCase.cueId === input.baseline.cueId && synchronized.cueCase.status === "FALLBACK" &&
    synchronized.cueCase.reflection?.cueId === input.baseline.cueId && synchronized.cueCase.reflection.response === "SKIPPED"
    ? synchronized : undefined;
  if (accepted) input.reconcile(accepted.cueCase);
  if (!input.ownsHistory()) return "ARTIFACTS_INCOMPLETE";
  return persistTeachingBeforeRuntimeHead({
    interactionDurable,
    persistDiagnosis: () => input.persistCase(accepted?.cueCase ?? input.baseline),
    ...(accepted ? { mirror: async () => {
      // Persistence can finish after a cue change: never attach the old Graph head to it.
      if (!input.isCurrent() || !input.ownsHistory()) throw new Error("STALE_SKIP_BOUNDARY");
      await accepted.mirror();
    } } : {}),
  });
}

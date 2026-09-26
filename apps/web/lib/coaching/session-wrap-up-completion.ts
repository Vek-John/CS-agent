import {
  buildSessionWrapUpRequest, SessionWrapUpResultSchema,
  type SessionWrapUpBuildInput, type SessionWrapUpRequest, type SessionWrapUpResult,
} from "@cs-coach/coach-agent/client";
import type { HistoryPersistenceController } from "../review-history/history-persistence-controller";
import { requestSessionWrapUp } from "./deepseek-wrap-up";
import { isSessionWrapUpIdentityCurrent, sessionWrapUpFailureReasonMessage, type SessionWrapUpFailureReason } from "./session-wrap-up-presentation";

function failedSummary(reason: SessionWrapUpFailureReason): SessionWrapUpResult {
  return SessionWrapUpResultSchema.parse({
    status: "FALLBACK",
    bundle: { schemaVersion: "coach-agent-session-wrap-up.v1", themes: [], limitations: [sessionWrapUpFailureReasonMessage(reason)] },
    manifest: { status: "FALLBACK", provider: "DETERMINISTIC", reason, limitations: [reason] },
  });
}

interface SessionWrapUpOwner {
  generation: number;
  session: Pick<import("@cs-coach/contracts").CoachingSessionState, "id" | "phase"> | undefined;
  runId: string | undefined;
  historyEpoch: number;
  persistence: Pick<HistoryPersistenceController, "reviewId" | "revisionId" | "ownershipGeneration"> | null | undefined;
}

/** Capture the live Host's result owner before asynchronous completion starts. */
export function createSessionWrapUpGuard(identity: { sessionId: string; runId: string }, generation: number,
  read: () => SessionWrapUpOwner): () => boolean {
  const captured = read();
  const persistence = captured.persistence, reviewId = persistence?.reviewId, revisionId = persistence?.revisionId;
  const historyGeneration = persistence?.ownershipGeneration;
  return () => {
    const current = read();
    // Playback takeover does not change ownership of a finished session summary.
    return generation === current.generation
      && isSessionWrapUpIdentityCurrent({ identity }, current.session, current.runId)
      && (current.session?.phase === "WRAP_UP" || current.session?.phase === "COMPLETED")
      && current.historyEpoch === captured.historyEpoch && current.persistence === persistence
      && persistence?.reviewId === reviewId && persistence?.revisionId === revisionId
      && persistence?.ownershipGeneration === historyGeneration;
  };
}

export interface SessionSummarySaveRetry {
  isCurrent(): boolean;
  /** Retry the retained payload only. False means stale or already saved. */
  retry(): Promise<boolean>;
}

function retainedSummarySave(result: SessionWrapUpResult, persistence: Pick<HistoryPersistenceController, "artifact">,
  isCurrent: () => boolean): SessionSummarySaveRetry {
  const snapshot = structuredClone(result);
  let saved = false, inFlight: Promise<boolean> | undefined;
  return { isCurrent, retry: () => {
    if (inFlight) return inFlight;
    if (saved || !isCurrent()) return Promise.resolve(false);
    // Defer to publish the single in-flight promise before any dependency runs.
    inFlight = Promise.resolve().then(async () => {
      if (saved || !isCurrent()) return false;
      await persistence.artifact("SESSION_SUMMARY", "session-summary", structuredClone(snapshot), "session-wrap-up.v1");
      if (!isCurrent()) return false;
      saved = true;
      return true;
    }).finally(() => { inFlight = undefined; });
    return inFlight;
  } };
}

/** Host completion seam: persist every terminal result, never regenerate on restore. */
export async function completeAndSaveSessionWrapUp(input: {
  buildInput: () => SessionWrapUpBuildInput | null;
  isCurrent: () => boolean;
  persistence: Pick<HistoryPersistenceController, "artifact"> | null | undefined;
  onRequest: (request: SessionWrapUpRequest) => void;
  onResult: (result: SessionWrapUpResult) => void;
  onSaveError: (retry: SessionSummarySaveRetry) => void;
}): Promise<void> {
  if (!input.isCurrent()) return;
  let result: SessionWrapUpResult;
  try {
    const projection = input.buildInput();
    if (!projection) result = failedSummary("MISSING_SESSION_SUMMARY");
    else {
      input.onRequest(buildSessionWrapUpRequest(projection));
      result = await requestSessionWrapUp(projection);
    }
  } catch (error) {
    result = failedSummary(error instanceof Error && error.message === "SOURCE_LIMITATIONS_EXCEED_OUTPUT_LIMIT"
      ? "SOURCE_LIMITATIONS_EXCEED_OUTPUT_LIMIT" : "INVALID_PRESENTABLE_INPUT");
  }
  if (!input.isCurrent()) return;
  const save = input.persistence ? retainedSummarySave(result, input.persistence, input.isCurrent) : undefined;
  input.onResult(result);
  if (!save) return;
  try { await save.retry(); }
  catch { if (input.isCurrent()) input.onSaveError(save); }
}

/** The live Host completion entry, shared by its effect and isolated integration tests. */
export async function completeStage3SessionWrapUp(input: Omit<Parameters<typeof completeAndSaveSessionWrapUp>[0], "buildInput"> & {
  controller: Pick<import("./coach-agent-stage3-controller").CoachAgentStage3Controller, "completeSession">;
  identity: import("./coach-agent-stage3-host-adapter").Stage3IdentityInput;
  buildInput: (result: import("@cs-coach/coach-agent/client").CoachAgentResult) => SessionWrapUpBuildInput | null;
  claim: () => boolean;
  onStart: () => void;
}): Promise<void> {
  if (!input.isCurrent()) return;
  const completion = await input.controller.completeSession(input.identity, () => { if (input.isCurrent()) input.onStart(); });
  if (!completion || !input.isCurrent()) return;
  if (!input.claim()) return;
  await completeAndSaveSessionWrapUp({ ...input, buildInput: () => completion.status === "SUCCEEDED" ? input.buildInput(completion.result) : null });
}

import {
  buildSessionWrapUpRequest, SessionWrapUpResultSchema,
  type SessionWrapUpBuildInput, type SessionWrapUpRequest, type SessionWrapUpResult,
} from "@cs-coach/coach-agent/client";
import type { HistoryPersistenceController } from "../review-history/history-persistence-controller";
import { requestSessionWrapUp } from "./deepseek-wrap-up";
import { sessionWrapUpFailureReasonMessage, type SessionWrapUpFailureReason } from "./session-wrap-up-presentation";

function failedSummary(reason: SessionWrapUpFailureReason): SessionWrapUpResult {
  return SessionWrapUpResultSchema.parse({
    status: "FALLBACK",
    bundle: { schemaVersion: "coach-agent-session-wrap-up.v1", themes: [], limitations: [sessionWrapUpFailureReasonMessage(reason)] },
    manifest: { status: "FALLBACK", provider: "DETERMINISTIC", reason, limitations: [reason] },
  });
}

/** Host completion seam: persist every terminal result, never regenerate on restore. */
export async function completeAndSaveSessionWrapUp(input: {
  buildInput: () => SessionWrapUpBuildInput | null;
  isCurrent: () => boolean;
  persistence: Pick<HistoryPersistenceController, "artifact"> | null | undefined;
  onRequest: (request: SessionWrapUpRequest) => void;
  onResult: (result: SessionWrapUpResult) => void;
  onSaveError: () => void;
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
  input.onResult(result);
  try {
    await input.persistence?.artifact("SESSION_SUMMARY", "session-summary", result, "session-wrap-up.v1");
  } catch {
    if (input.isCurrent()) input.onSaveError();
  }
}

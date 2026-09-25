import { expect, it, vi } from "vitest";
import type { CoachAgentResult, SessionWrapUpBuildInput } from "@cs-coach/coach-agent/client";
import { completeAndSaveSessionWrapUp } from "./session-wrap-up-completion";
import { canPublishSessionWrapUp, isSessionWrapUpIdentityCurrent } from "./session-wrap-up-presentation";
import { HistoryPersistenceController } from "../review-history/history-persistence-controller";

const empty: SessionWrapUpBuildInput = {
  summary: { schemaVersion: "coach-agent-session-summary.v1", themes: [], completedCues: [], limitations: [] }, presentableCues: {},
};
const completed = { status: "COMPLETED", identity: { runId: "run" }, state: { sessionStatus: "COMPLETED" } } as CoachAgentResult;
function setup() {
  const deps = { createReview: vi.fn(), startRevision: vi.fn(), appendArtifact: vi.fn().mockResolvedValue(undefined), commitRuntimeHead: vi.fn(), markFailed: vi.fn() };
  const persistence = new HistoryPersistenceController(deps);
  persistence.adopt("review", "revision", "demo");
  const live = { generation: 1, runId: "run", takeover: false };
  const input = {
    persistence, buildInput: () => empty,
    isCurrent: () => canPublishSessionWrapUp(completed, 1, live.generation, live.runId, live.takeover)
      && persistence.reviewId === "review" && persistence.revisionId === "revision",
    onRequest: vi.fn(), onResult: vi.fn(), onSaveError: vi.fn(),
  };
  return { deps, input, live, persistence };
}

it.each(["generation", "run", "takeover", "review", "revision"])("does not publish or save after %s changes while completion is pending", async kind => {
  const { deps, input, live, persistence } = setup();
  const pending = completeAndSaveSessionWrapUp(input);
  if (kind === "generation") live.generation++;
  if (kind === "run") live.runId = "new-run";
  if (kind === "takeover") live.takeover = true;
  if (kind === "review") persistence.adopt("new-review", "new-revision", "demo");
  if (kind === "revision") persistence.adopt("review", "new-revision", "demo");
  await pending;
  expect(input.onResult).not.toHaveBeenCalled();
  expect(deps.appendArtifact).not.toHaveBeenCalled();
  expect(input.onSaveError).not.toHaveBeenCalled();
});

it("does no summary work for an already invalidated request", async () => {
  const { input, live, deps } = setup();
  live.generation++;
  const buildInput = vi.fn(() => empty);
  await completeAndSaveSessionWrapUp({ ...input, buildInput });
  expect(buildInput).not.toHaveBeenCalled(); expect(deps.appendArtifact).not.toHaveBeenCalled();
});

it.each([false, true])("only surfaces a delayed save error in its own active review (switch=%s)", async switchReview => {
  const { input, persistence, deps } = setup();
  let reject!: (error: Error) => void;
  deps.appendArtifact.mockImplementation(() => new Promise<void>((_, fail) => { reject = fail; }));
  const pending = completeAndSaveSessionWrapUp({ ...input, buildInput: () => null });
  // Missing-summary publication is synchronous; pending durability cannot block it.
  expect(input.onResult).toHaveBeenCalledWith(expect.objectContaining({ status: "FALLBACK", manifest: expect.objectContaining({ reason: "MISSING_SESSION_SUMMARY" }) }));
  expect(deps.appendArtifact).toHaveBeenCalledWith("review", expect.objectContaining({ revisionId: "revision" }));
  if (switchReview) persistence.adopt("new-review", "new-revision", "demo");
  reject(new Error("private storage error details"));
  await expect(pending).resolves.toBeUndefined();
  expect(input.onSaveError).toHaveBeenCalledTimes(switchReview ? 0 : 1);
  expect(deps.appendArtifact).toHaveBeenCalledTimes(1);
});

it("stores only the bounded failure reason instead of exception text", async () => {
  const { input, deps } = setup();
  await completeAndSaveSessionWrapUp({ ...input, buildInput: () => { throw new Error("sensitive arbitrary error details"); } });
  expect(deps.appendArtifact).toHaveBeenCalledWith("review", expect.objectContaining({ payload: expect.objectContaining({ manifest: expect.objectContaining({ reason: "INVALID_PRESENTABLE_INPUT" }) }) }));
  expect(JSON.stringify(deps.appendArtifact.mock.calls)).not.toContain("sensitive");
});


it("still publishes and reports save failure after normal completion clears the transient run identity", async () => {
  const { input, deps } = setup();
  const result = { ...completed, identity: { ...completed.identity, sessionId: "session" } };
  let activeRunId: string | undefined = "run";
  const session = { id: "session", phase: "COMPLETED" as const };
  deps.appendArtifact.mockRejectedValue(new Error("save failed"));
  const pending = completeAndSaveSessionWrapUp({ ...input,
    isCurrent: () => input.isCurrent() && isSessionWrapUpIdentityCurrent(result, session, activeRunId) });
  activeRunId = undefined;
  await pending;
  expect(input.onResult).toHaveBeenCalledOnce();
  expect(deps.appendArtifact).toHaveBeenCalledOnce();
  expect(input.onSaveError).toHaveBeenCalledOnce();
  expect(isSessionWrapUpIdentityCurrent(result, { id: "other", phase: "COMPLETED" }, undefined)).toBe(false);
  expect(isSessionWrapUpIdentityCurrent(result, { id: "session", phase: "WRAP_UP" }, undefined)).toBe(false);
  expect(isSessionWrapUpIdentityCurrent(result, session, "other-run")).toBe(false);
});

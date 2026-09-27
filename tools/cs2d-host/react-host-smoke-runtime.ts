import { createCoachAgentRuntime } from "../../libs/coach-agent/src/index";
import { parseRemoteCoachAgentDispatchEnvelope, parseRemoteCoachAgentDispatchResponse } from "../../libs/coach-agent/src/remote-dispatch-client";
const runtimes = new Map<string, ReturnType<typeof createCoachAgentRuntime>>();
export const metrics = { transportRequests: 0, reflectionAttempts: 0, injectedFailures: 0, dispatches: 0, events: {} as Record<string, number>, externalFetches: 0, completions: [] as Array<{ runStatus: string; sessionStatus: string; routeCursor: number; completedCueCount: number; graphCaseCount: number; summaryCompletedCueCount: number; summaryThemeCount: number; checkpointBackend: string }>, reflections: [] as Array<{ response: string; caseStatus: string | null; verdict: string | null; diagnostic: string | null; evidenceRefCount: number; learningThreadCount: number }> };
globalThis.fetch = async () => { metrics.externalFetches++; throw Error("SMOKE_EXTERNAL_NETWORK_FORBIDDEN"); };
export async function dispatch(value: unknown) {
  const envelope = parseRemoteCoachAgentDispatchEnvelope(value);
  if (runtimes.size >= 4 && !runtimes.has(envelope.sessionId)) throw Error("SMOKE_SESSION_LIMIT");
  let runtime = runtimes.get(envelope.sessionId);
  if (!runtime) { runtime = createCoachAgentRuntime({ checkpoint: "memory" }); runtimes.set(envelope.sessionId, runtime); }
  metrics.dispatches++; metrics.events[envelope.event.type] = (metrics.events[envelope.event.type] ?? 0) + 1;
  const result = parseRemoteCoachAgentDispatchResponse(await runtime.dispatch(envelope.event));
  if (envelope.event.type === "SUBMIT_REFLECTION") {
    const cueId = envelope.event.cueId;
    const cueCase = result.state.cueCases[cueId];
    metrics.reflections.push({ response: envelope.event.reflection.response, caseStatus: cueCase?.status ?? null,
      verdict: cueCase?.verdict?.type ?? null, diagnostic: cueCase?.diagnosticResult?.status ?? null,
      evidenceRefCount: cueCase?.verdict?.evidenceRefs.length ?? 0,
      learningThreadCount: result.state.learningThreads.filter(thread => thread.evidenceCueIds.includes(cueId)).length });
    metrics.reflections = metrics.reflections.slice(-8);
  }
  if (envelope.event.type === "COMPLETE_SESSION") {
    metrics.completions.push({ runStatus: result.state.runStatus, sessionStatus: result.state.sessionStatus,
      routeCursor: result.state.routeCursor, completedCueCount: result.state.completedCueIds.length,
      graphCaseCount: Object.keys(result.state.cueCases).length,
      summaryCompletedCueCount: result.state.sessionSummaryInput?.completedCues.length ?? 0,
      summaryThemeCount: result.state.sessionSummaryInput?.themes.length ?? 0,
      checkpointBackend: result.checkpoint.backend });
    metrics.completions = metrics.completions.slice(-4);
  }
  return result;
}

/** Test-only transport fault: validation precedes injection, and a rejected request never reaches Runtime. */
export function createSmokeTransport(options: { failFirstReflection?: boolean } = {}) {
  let pendingFailure = options.failFirstReflection === true;
  return async (value: unknown) => {
    const envelope = parseRemoteCoachAgentDispatchEnvelope(value);
    metrics.transportRequests++;
    if (envelope.event.type === "SUBMIT_REFLECTION") {
      metrics.reflectionAttempts++;
      if (pendingFailure) {
        pendingFailure = false;
        metrics.injectedFailures++;
        return { status: 503, payload: { code: "SYNTHETIC_REFLECTION_TRANSPORT_FAILURE" } };
      }
    }
    return { status: 200, payload: await dispatch(envelope) };
  };
}

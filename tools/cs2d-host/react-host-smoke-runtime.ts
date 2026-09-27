import { createCoachAgentRuntime } from "../../libs/coach-agent/src/index";
import { parseRemoteCoachAgentDispatchEnvelope, parseRemoteCoachAgentDispatchResponse } from "../../libs/coach-agent/src/remote-dispatch-client";
const runtimes = new Map<string, ReturnType<typeof createCoachAgentRuntime>>();
export const metrics = { dispatches: 0, events: {} as Record<string, number>, externalFetches: 0, reflections: [] as Array<{ response: string; caseStatus: string | null; verdict: string | null; diagnostic: string | null; evidenceRefCount: number; learningThreadCount: number }> };
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
  return result;
}

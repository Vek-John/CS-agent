import { createCoachAgentRuntime } from "../../libs/coach-agent/src/index";
import { parseRemoteCoachAgentDispatchEnvelope, parseRemoteCoachAgentDispatchResponse } from "../../libs/coach-agent/src/remote-dispatch-client";
const runtimes = new Map<string, ReturnType<typeof createCoachAgentRuntime>>();
export const metrics = { dispatches: 0, events: {} as Record<string, number>, externalFetches: 0 };
globalThis.fetch = async () => { metrics.externalFetches++; throw Error("SMOKE_EXTERNAL_NETWORK_FORBIDDEN"); };
export async function dispatch(value: unknown) {
  const envelope = parseRemoteCoachAgentDispatchEnvelope(value);
  if (runtimes.size >= 4 && !runtimes.has(envelope.sessionId)) throw Error("SMOKE_SESSION_LIMIT");
  let runtime = runtimes.get(envelope.sessionId);
  if (!runtime) { runtime = createCoachAgentRuntime({ checkpoint: "memory" }); runtimes.set(envelope.sessionId, runtime); }
  metrics.dispatches++; metrics.events[envelope.event.type] = (metrics.events[envelope.event.type] ?? 0) + 1;
  return parseRemoteCoachAgentDispatchResponse(await runtime.dispatch(envelope.event));
}

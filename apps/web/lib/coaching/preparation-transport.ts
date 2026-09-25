import { requestJsonWithDeadline } from "./request-json-deadline";

// Server model budget is 15s; allow 5s for local routing/body overhead.
// This is per request, not an end-to-end review startup guarantee.
export const PREPARATION_REQUEST_TIMEOUT_MS = 20_000;

export class PreparationRequestTimeout extends Error {
  constructor() { super("LOCAL_REQUEST_TIMEOUT"); this.name = "PreparationRequestTimeout"; }
}

export function assertPreparationActive(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DOMException("Preparation cancelled", "AbortError");
}

/** Preserves preparation's 20-second deadline, cancellation and body-error semantics. */
export async function requestPreparationJson(
  fetcher: (input: string | URL, init?: RequestInit) => Promise<Response>, endpoint: string,
  init: Omit<RequestInit, "signal">, parent?: AbortSignal,
): Promise<{ ok: boolean; status: number; payload?: unknown }> {
  assertPreparationActive(parent);
  return requestJsonWithDeadline(fetcher, endpoint, init, {
    timeoutMs: PREPARATION_REQUEST_TIMEOUT_MS, timeoutError: () => new PreparationRequestTimeout(), cancelMessage: "Preparation cancelled",
  }, parent);
}

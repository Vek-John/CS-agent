// Server model budget is 15s; allow 5s for local routing/body overhead.
// This is per request, not an end-to-end review startup guarantee.
export const PREPARATION_REQUEST_TIMEOUT_MS = 20_000;

export class PreparationRequestTimeout extends Error {
  constructor() { super("LOCAL_REQUEST_TIMEOUT"); this.name = "PreparationRequestTimeout"; }
}

export function assertPreparationActive(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DOMException("Preparation cancelled", "AbortError");
}

type Fetcher = (input: string | URL, init?: RequestInit) => Promise<Response>;
interface JsonResponse { ok: boolean; status: number; payload?: unknown }

/** Owns fetch + body with one deadline, even when an injected transport ignores abort. */
export async function requestPreparationJson(fetcher: Fetcher, endpoint: string, init: Omit<RequestInit, "signal">, parent?: AbortSignal): Promise<JsonResponse> {
  assertPreparationActive(parent);
  return new Promise((resolve, reject) => {
    const controller = new AbortController();
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (result: { value: JsonResponse } | { error: unknown }) => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      parent?.removeEventListener("abort", cancel);
      if ("error" in result) reject(result.error); else resolve(result.value);
    };
    const cancel = () => {
      const error = new DOMException("Preparation cancelled", "AbortError");
      finish({ error });
      controller.abort(error);
    };
    parent?.addEventListener("abort", cancel, { once: true });
    if (parent?.aborted) { cancel(); return; }
    timer = setTimeout(() => {
      // Settle our owned promise first so transport AbortError cannot mask timeout.
      const error = new PreparationRequestTimeout();
      finish({ error });
      controller.abort(error);
    }, PREPARATION_REQUEST_TIMEOUT_MS);
    void (async () => {
      try {
        const response = await fetcher(endpoint, { ...init, signal: controller.signal });
        if (settled) return; // A late header must not start reading a body.
        if (!response.ok) { finish({ value: { ok: false, status: response.status } }); return; }
        const payload: unknown = await response.json();
        if (settled) return;
        finish({ value: { ok: true, status: response.status, payload } });
      } catch (error) {
        // Always observe late rejections; they cannot publish or replace our result.
        finish({ error });
      }
    })();
  });
}

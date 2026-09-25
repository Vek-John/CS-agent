type Fetcher = (input: string | URL, init?: RequestInit) => Promise<Response>;
interface JsonResponse { ok: boolean; status: number; payload?: unknown }
interface RequestDeadline {
  timeoutMs: number;
  timeoutError: () => Error;
  cancelMessage: string;
  invalidJsonError?: () => Error;
  readErrorBody?: boolean;
  allowInvalidJson?: boolean;
}

/** One owned fetch + JSON lifetime. Abort is best effort; settling does not depend on transport cooperation. */
export async function requestJsonWithDeadline(fetcher: Fetcher, endpoint: string, init: Omit<RequestInit, "signal">,
  options: RequestDeadline, parent?: AbortSignal): Promise<JsonResponse> {
  if (parent?.aborted) throw new DOMException(options.cancelMessage, "AbortError");
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
      const error = new DOMException(options.cancelMessage, "AbortError");
      finish({ error });
      controller.abort(error);
    };
    parent?.addEventListener("abort", cancel, { once: true });
    if (parent?.aborted) { cancel(); return; }
    timer = setTimeout(() => {
      // Settle our owned promise first so transport AbortError cannot mask timeout.
      const error = options.timeoutError();
      finish({ error });
      controller.abort(error);
    }, options.timeoutMs);
    void (async () => {
      try {
        const response = await fetcher(endpoint, { ...init, signal: controller.signal });
        if (settled) return; // A late header must not start reading a body.
        if (!response.ok && !options.readErrorBody) { finish({ value: { ok: false, status: response.status } }); return; }
        let payload: unknown;
        try { payload = await response.json(); }
        catch (error) {
          if (settled) return;
          if (!options.allowInvalidJson) { finish({ error: options.invalidJsonError ? options.invalidJsonError() : error }); return; }
        }
        if (settled) return;
        finish({ value: { ok: response.ok, status: response.status, payload } });
      } catch (error) {
        // Always observe late rejections; they cannot publish or replace our result.
        finish({ error });
      }
    })();
  });
}

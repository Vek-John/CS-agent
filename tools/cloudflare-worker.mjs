// OpenNext owns the generated request router. This thin entrypoint is kept
// outside the generated directory so the same isolation headers cover HTML,
// /cs2d/, Worker modules, WASM, model and static asset responses.
import generatedWorker from "../apps/web/.open-next/worker.js";

const ISOLATION_HEADERS = {
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Embedder-Policy": "require-corp",
  "Cross-Origin-Resource-Policy": "cross-origin",
};
export default {
  async fetch(request, env, ctx) {
    const response = await generatedWorker.fetch(request, env, ctx);
    const headers = new Headers(response.headers);
    for (const [key, value] of Object.entries(ISOLATION_HEADERS)) headers.set(key, value);
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  },
};

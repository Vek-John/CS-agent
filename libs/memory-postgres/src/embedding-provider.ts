import type { EmbeddingProvider } from "@cs-coach/memory";
import { VectorUnavailableError } from "./errors";
import { MAX_EMBEDDING_DIMENSION } from "./embedding";

export interface HttpEmbeddingProviderOptions {
  readonly endpoint: string;
  readonly token?: string;
  readonly model?: string;
  readonly timeoutMs?: number;
  readonly fetcher?: typeof fetch;
}

function endpointUrl(value: string): string {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error("unsupported protocol");
    return url.href;
  } catch {
    throw new VectorUnavailableError("Invalid embedding endpoint");
  }
}

function parseEmbedding(value: unknown): readonly number[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new VectorUnavailableError("Embedding provider returned an invalid vector");
  }
  const object = value as { embedding?: unknown; data?: unknown };
  const data = Array.isArray(object.data) ? object.data : [];
  const first = data[0];
  const candidate = object.embedding ?? (first && typeof first === "object" && !Array.isArray(first)
    ? (first as { embedding?: unknown }).embedding
    : undefined);
  if (!Array.isArray(candidate) || candidate.length === 0 || candidate.length > MAX_EMBEDDING_DIMENSION || !candidate.every((item) => typeof item === "number" && Number.isFinite(item))) {
    throw new VectorUnavailableError("Embedding provider returned an invalid vector");
  }
  return candidate;
}

/** Optional HTTP adapter; absence/failure is intentionally handled by MemoryService. */
export function createHttpEmbeddingProvider(options: HttpEmbeddingProviderOptions): EmbeddingProvider {
  const endpoint = endpointUrl(options.endpoint);
  const timeoutMs = Number.isFinite(options.timeoutMs) ? Math.max(100, Math.min(10_000, Math.floor(options.timeoutMs as number))) : 2_000;
  const fetcher = options.fetcher ?? fetch;
  return {
    model: options.model?.trim() || "memory-embedding.v1",
    async embed(text: string): Promise<readonly number[]> {
      const value = text.trim();
      if (!value || value.length > 4_000) throw new VectorUnavailableError("Embedding input is outside the supported range");
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const response = await fetcher(endpoint, {
          method: "POST",
          signal: controller.signal,
          headers: {
            "content-type": "application/json",
            ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
          },
          body: JSON.stringify({
            ...(options.model?.trim() ? { model: options.model.trim() } : {}),
            input: value,
          }),
        });
        if (!response.ok) throw new VectorUnavailableError("Embedding provider request failed");
        const raw = await response.text();
        if (new TextEncoder().encode(raw).byteLength > 128 * 1024) throw new VectorUnavailableError("Embedding provider response is too large");
        let parsed: unknown;
        try {
          parsed = JSON.parse(raw) as unknown;
        } catch {
          throw new VectorUnavailableError("Embedding provider returned invalid JSON");
        }
        return parseEmbedding(parsed);
      } catch (error) {
        if (error instanceof VectorUnavailableError) throw error;
        throw new VectorUnavailableError(error instanceof Error && error.name === "AbortError" ? "Embedding provider timed out" : "Embedding provider unavailable", { cause: error });
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

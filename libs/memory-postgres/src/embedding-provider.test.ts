import { describe, expect, it } from "vitest";
import { createHttpEmbeddingProvider } from "./embedding-provider";

describe("optional HTTP embedding provider", () => {
  it("validates the endpoint, sends bounded text and parses common response shapes", async () => {
    let requestBody = "";
    const provider = createHttpEmbeddingProvider({
      endpoint: "https://embeddings.example.test/v1",
      token: "secret-token",
      model: "demo-model",
      fetcher: async (_input, init) => {
        requestBody = String(init?.body);
        expect(init?.headers).toMatchObject({ authorization: "Bearer secret-token" });
        return new Response(JSON.stringify({ data: [{ embedding: [0.1, -0.2] }] }), { status: 200 });
      },
    });
    await expect(provider.embed("  trade timing  ")).resolves.toEqual([0.1, -0.2]);
    expect(JSON.parse(requestBody)).toEqual({ model: "demo-model", input: "trade timing" });
  });

  it("fails closed for malformed endpoints, provider errors and invalid vectors", async () => {
    expect(() => createHttpEmbeddingProvider({ endpoint: "file:///not-http" })).toThrow("Invalid embedding endpoint");
    const failing = createHttpEmbeddingProvider({ endpoint: "https://embeddings.example.test", fetcher: async () => new Response("", { status: 503 }) });
    await expect(failing.embed("text")).rejects.toThrow("Embedding provider request failed");
    const malformed = createHttpEmbeddingProvider({ endpoint: "https://embeddings.example.test", fetcher: async () => new Response(JSON.stringify({ embedding: [Number.NaN] }), { status: 200 }) });
    await expect(malformed.embed("text")).rejects.toThrow("Embedding provider returned an invalid vector");
  });
});

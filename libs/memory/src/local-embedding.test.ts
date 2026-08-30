import { describe, expect, it } from "vitest";
import {
  LOCAL_FEATURE_HASH_DIMENSIONS,
  createLocalFeatureHashEmbeddingProvider,
  localFeatureHashEmbedding,
} from "./local-embedding";

function cosine(left: readonly number[], right: readonly number[]): number {
  return left.reduce((sum, value, index) => sum + value * (right[index] ?? 0), 0);
}

describe("local feature-hash embedding", () => {
  it("is deterministic, normalized and Unicode-compatible", async () => {
    const provider = createLocalFeatureHashEmbeddingProvider();
    const first = await provider.embed("  等队友补枪，再一起进点  ");
    const normalized = await provider.embed("等队友补枪,再一起进点");
    expect(first).toHaveLength(LOCAL_FEATURE_HASH_DIMENSIONS);
    expect(first.every(Number.isFinite)).toBe(true);
    expect(cosine(first, first)).toBeCloseTo(1, 10);
    expect(cosine(first, normalized)).toBeGreaterThan(0.7);
    expect(provider.contentHash?.("same")).toBe(provider.contentHash?.("same"));
  });

  it("ranks lexical coaching overlap above an unrelated topic", () => {
    const query = localFeatureHashEmbedding("等队友一起补枪再进点");
    const related = localFeatureHashEmbedding("先等队友到位，形成补枪再一起进点");
    const unrelated = localFeatureHashEmbedding("经济局保枪，下一回合买长枪和道具");
    expect(cosine(query, related)).toBeGreaterThan(cosine(query, unrelated));
  });
});

import type { EmbeddingProvider } from "./ports";

export const LOCAL_FEATURE_HASH_DIMENSIONS = 256;
export const LOCAL_FEATURE_HASH_MODEL = "local-unicode-feature-hash/1.0.0";

function normalizedText(text: string): string {
  return text.normalize("NFKC").toLocaleLowerCase("und").replace(/\s+/gu, " ").trim();
}

function fnv1a(value: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

export function localFeatureHashEmbedding(text: string): readonly number[] {
  const normalized = normalizedText(text) || "<empty>";
  const characters = Array.from(normalized);
  const vector = new Array<number>(LOCAL_FEATURE_HASH_DIMENSIONS).fill(0);
  for (let width = 1; width <= 3; width += 1) {
    if (characters.length < width) continue;
    const weight = width === 1 ? 0.5 : width === 2 ? 1 : 1.25;
    for (let index = 0; index <= characters.length - width; index += 1) {
      const hash = fnv1a(`${width}:${characters.slice(index, index + width).join("")}`);
      const bucket = hash % LOCAL_FEATURE_HASH_DIMENSIONS;
      vector[bucket] += (hash & 0x80000000) === 0 ? weight : -weight;
    }
  }
  const norm = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
  if (!Number.isFinite(norm) || norm === 0) {
    vector[fnv1a(normalized) % LOCAL_FEATURE_HASH_DIMENSIONS] = 1;
    return vector;
  }
  return vector.map((value) => value / norm);
}

export function createLocalFeatureHashEmbeddingProvider(): EmbeddingProvider {
  return {
    model: LOCAL_FEATURE_HASH_MODEL,
    contentHash: (text) => `fnv1a-${fnv1a(normalizedText(text)).toString(16).padStart(8, "0")}`,
    embed: async (text) => localFeatureHashEmbedding(text),
    embedMany: async (texts) => texts.map(localFeatureHashEmbedding),
  };
}

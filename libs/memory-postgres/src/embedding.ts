import { MemoryIdSchema } from "@cs-coach/memory";
import { VectorUnavailableError } from "./errors";

export const MAX_EMBEDDING_DIMENSION = 4_096;

export interface MemoryEmbeddingInput {
  readonly memoryId: string;
  readonly embedding: readonly number[];
  readonly embeddingDimension?: number;
  readonly contentHash: string;
  readonly model: string;
  readonly sourceRevision: number;
  readonly createdAt?: string;
}

export interface MemoryEmbedding {
  readonly userId: string;
  readonly memoryId: string;
  readonly embedding: readonly number[];
  readonly embeddingDimension: number;
  readonly contentHash: string;
  readonly model: string;
  readonly sourceRevision: number;
  readonly createdAt?: string;
}

function nonEmpty(value: string, field: string): string {
  const normalized = value.trim();
  if (!normalized || normalized.length > 256) throw new VectorUnavailableError(`Invalid embedding ${field}`);
  return normalized;
}

/** Validate and encode a vector as a generated pgvector literal. */
export function embeddingToVectorLiteral(embedding: readonly number[]): string {
  if (!Array.isArray(embedding) || embedding.length === 0 || embedding.length > MAX_EMBEDDING_DIMENSION) {
    throw new VectorUnavailableError("Embedding dimension is outside the supported range");
  }
  if (!embedding.every((value) => typeof value === "number" && Number.isFinite(value))) {
    throw new VectorUnavailableError("Embedding contains a non-finite value");
  }
  // Values are generated from finite numbers, never interpolated user text.
  return `[${embedding.map((value) => String(value)).join(",")}]`;
}

export function validateEmbeddingInput(userId: string, input: MemoryEmbeddingInput): MemoryEmbedding {
  if (!MemoryIdSchema.safeParse(userId).success) throw new VectorUnavailableError("Invalid embedding user scope");
  if (!MemoryIdSchema.safeParse(input.memoryId).success) throw new VectorUnavailableError("Invalid embedding memory id");
  const literal = embeddingToVectorLiteral(input.embedding);
  const dimension = input.embeddingDimension ?? input.embedding.length;
  if (!Number.isInteger(dimension) || dimension !== input.embedding.length || dimension <= 0 || dimension > MAX_EMBEDDING_DIMENSION) {
    throw new VectorUnavailableError("Embedding dimension metadata does not match the vector");
  }
  if (!Number.isInteger(input.sourceRevision) || input.sourceRevision <= 0) {
    throw new VectorUnavailableError("Embedding source revision must be positive");
  }
  return {
    userId,
    memoryId: input.memoryId.trim(),
    embedding: input.embedding,
    embeddingDimension: dimension,
    contentHash: nonEmpty(input.contentHash, "content hash"),
    model: nonEmpty(input.model, "model"),
    sourceRevision: input.sourceRevision,
    ...(input.createdAt ? { createdAt: input.createdAt } : {}),
  };
}

/** Used by repository SQL construction after validation. */
export function embeddingLiteral(input: MemoryEmbeddingInput): string {
  validateEmbeddingInput("embedding-user", input);
  return embeddingToVectorLiteral(input.embedding);
}

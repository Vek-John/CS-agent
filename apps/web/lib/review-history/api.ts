import { requestJsonWithDeadline } from "../coaching/request-json-deadline";
import type { ReviewSummary } from "@cs-coach/review-library";
import type { ReviewHistoryItem } from "../../components/history/review-history-sidebar";
import type { ManagedDemoSource, ReviewHistoryDetail } from "./history-restore-controller";

const JSON_HEADERS = { "content-type": "application/json" };

export class ReviewHistoryApiError extends Error {
  constructor(readonly code: string) { super(code); }
}

export interface DemoDeletionImpact {
  readonly demoId: string;
  readonly originalFilename: string;
  readonly reviews: readonly {
    readonly id: string;
    readonly title: string;
    readonly selectedPlayerName: string;
    readonly status: string;
  }[];
  readonly reviewCount: number;
  readonly truncated: boolean;
  /** Locks DELETE to the exact association set the user confirmed. */
  readonly impactToken: string;
}

async function responseJson<T>(response: Response): Promise<T> {
  const body: unknown = await response.json().catch(() => undefined);
  if (!response.ok) {
    const code = body && typeof body === "object" && "code" in body && typeof body.code === "string" ? body.code : "REQUEST_FAILED";
    throw new ReviewHistoryApiError(code);
  }
  return body as T;
}

// Only checkpoint JSON mutations: SESSION_RECOVERY <=256 KiB stored JSON; head <=128,000 bytes.
// Endpoints may materialize existing analysis for validation, so use a conservative local wait policy.
export const CHECKPOINT_REQUEST_TIMEOUT_MS = 20_000;
async function checkpointJson(fetcher: typeof fetch, endpoint: string, init: RequestInit): Promise<void> {
  const response = await requestJsonWithDeadline(fetcher, endpoint, init, {
    timeoutMs: CHECKPOINT_REQUEST_TIMEOUT_MS, timeoutError: () => new ReviewHistoryApiError("CHECKPOINT_SAVE_TIMEOUT"),
    cancelMessage: "Checkpoint save cancelled", readErrorBody: true, allowInvalidJson: true,
  });
  if (!response.ok) {
    const body = response.payload;
    const code = body && typeof body === "object" && "code" in body && typeof body.code === "string" ? body.code : "REQUEST_FAILED";
    throw new ReviewHistoryApiError(code);
  }
}

function query(url: string, values: Record<string, string | undefined>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(values)) if (value) search.set(key, value);
  const text = search.toString();
  return text ? `${url}?${text}` : url;
}

/** Browser-only DTO API. It never receives paths, raw bytes, or artifact locations. */
export function createReviewHistoryApi(fetcher: typeof fetch = fetch) {
  return {
    async list(search?: string, cursor?: string): Promise<{ items: ReviewHistoryItem[]; nextCursor?: string }> {
      const page = await responseJson<{ items: ReviewSummary[]; nextCursor: string | null }>(await fetcher(query("/api/review-history", { search, cursor }), { cache: "no-store" }));
      return {
        items: page.items.map((item) => ({
          id: item.reviewId,
          demoId: item.demoId,
          title: item.title,
          playerName: item.selectedPlayerName,
          originalFilename: item.originalFilename,
          updatedAt: item.lastOpenedAt,
          createdAt: item.createdAt,
          status: item.status,
          progress: item.totalCueCount > 0 ? item.completedCueCount / item.totalCueCount * 100 : 0,
          map: item.mapName,
          scoreText: item.scoreText,
          demoStatus: item.demoStatus,
          completedCueCount: item.completedCueCount,
          totalCueCount: item.totalCueCount,
        })),
        ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}),
      };
    },
    async detail(reviewId: string, signal?: AbortSignal): Promise<ReviewHistoryDetail> {
      return responseJson(await fetcher(`/api/review-history/${encodeURIComponent(reviewId)}`, { cache: "no-store", signal }));
    },
    async viewerSource(reviewId: string, signal?: AbortSignal): Promise<ManagedDemoSource> {
      return responseJson(await fetcher(`/api/review-history/${encodeURIComponent(reviewId)}/viewer-source`, { method: "POST", headers: JSON_HEADERS, cache: "no-store", signal, body: "{}" }));
    },
    async importCapability(input: { requestId: string; originalFilename: string; byteSize: number }): Promise<{ requestId: string; capabilityToken: string }> {
      return responseJson(await fetcher("/api/review-history/import-capability", { method: "POST", headers: JSON_HEADERS, cache: "no-store", body: JSON.stringify(input) }));
    },
    async rename(reviewId: string, title: string): Promise<void> {
      await responseJson(await fetcher(`/api/review-history/${encodeURIComponent(reviewId)}`, { method: "PATCH", headers: JSON_HEADERS, cache: "no-store", body: JSON.stringify({ title }) }));
    },
    async markFailed(reviewId: string): Promise<void> {
      await responseJson(await fetcher(`/api/review-history/${encodeURIComponent(reviewId)}`, { method: "PATCH", headers: JSON_HEADERS, cache: "no-store", body: JSON.stringify({ status: "FAILED" }) }));
    },
    async create(input: { demoId: string; selectedPlayerId: string; selectedPlayerName: string; title: string; mapName?: string }): Promise<{ reviewId: string }> {
      return responseJson(await fetcher("/api/review-history", { method: "POST", headers: JSON_HEADERS, cache: "no-store", body: JSON.stringify(input) }));
    },
    async startRevision(reviewId: string, input: {
      mode: "REANALYZE" | "SELECT_PLAYER";
      routeId: string;
      routeHash: string;
      analysisVersion: string;
      graphVersion: string;
      promptVersion: string;
      modelMetadata: Record<string, unknown>;
    }): Promise<{ revisionId: string }> {
      return responseJson(await fetcher(`/api/review-history/${encodeURIComponent(reviewId)}/revisions`, { method: "POST", headers: JSON_HEADERS, cache: "no-store", body: JSON.stringify(input) }));
    },
    async removeReview(reviewId: string): Promise<void> {
      await responseJson(await fetcher(`/api/review-history/${encodeURIComponent(reviewId)}`, { method: "DELETE", cache: "no-store" }));
    },
    async demoImpact(demoId: string): Promise<DemoDeletionImpact> {
      return responseJson(await fetcher(`/api/review-history/demos/${encodeURIComponent(demoId)}`, { cache: "no-store" }));
    },
    async removeDemo(demoId: string, impactToken: string): Promise<void> {
      await responseJson(await fetcher(`/api/review-history/demos/${encodeURIComponent(demoId)}`, {
        method: "DELETE",
        headers: JSON_HEADERS,
        cache: "no-store",
        body: JSON.stringify({ impactToken }),
      }));
    },
    async appendArtifact(reviewId: string, input: { revisionId: string; artifactType: string; artifactKey: string; artifactRevision?: number; schemaVersion: string; payload: unknown; idempotencyKey: string }): Promise<void> {
      const endpoint = `/api/review-history/${encodeURIComponent(reviewId)}/artifacts`;
      const request = { method: "POST", headers: JSON_HEADERS, cache: "no-store" as const, body: JSON.stringify(input) };
      if (input.artifactType === "SESSION_RECOVERY") await checkpointJson(fetcher, endpoint, request);
      else await responseJson(await fetcher(endpoint, request));
    },
    async commitRuntimeHead(reviewId: string, input: Record<string, unknown>): Promise<void> {
      await checkpointJson(fetcher, `/api/review-history/${encodeURIComponent(reviewId)}/runtime-head`, { method: "PUT", headers: JSON_HEADERS, cache: "no-store", body: JSON.stringify(input) });
    },
  };
}

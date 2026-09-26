import { requestJsonWithDeadline } from "../coaching/request-json-deadline";
import { recoveryArtifactIdFromHead } from "./history-persistence-controller";
import type { ReviewSummary } from "@cs-coach/review-library";
import type { ReviewHistoryItem } from "../../components/history/review-history-sidebar";
import type { ManagedDemoSource, ReviewHistoryDetail } from "./history-restore-controller";

const JSON_HEADERS = { "content-type": "application/json" };
// Small capability DTO only. This bounds client waiting, not issuance or Demo loading on the server/Viewer.
export const VIEWER_SOURCE_REQUEST_TIMEOUT_MS = 20_000;

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
export const TEACHING_SAVE_TIMEOUT_MS = 20_000;
// Paginated summaries (default 30, max 50) and a small status PATCH, never full artifacts.
export const HISTORY_REQUEST_TIMEOUT_MS = 20_000;
// Small teaching projections, completed summaries and user input. Large analysis/route payloads retain their own lifetime.
const TEACHING_ARTIFACT_TYPES = new Set(["USER_INTERACTION", "CUE_CASE", "DIAGNOSTIC_RESULT", "TRANSFER_RULE", "LEARNING_THREAD", "SESSION_SUMMARY"]);
async function boundedHistoryJson(fetcher: typeof fetch, endpoint: string, init: RequestInit, kind: "CHECKPOINT" | "TEACHING" | "HISTORY" = "CHECKPOINT"): Promise<unknown> {
  const response = await requestJsonWithDeadline(fetcher, endpoint, init, {
    timeoutMs: kind === "HISTORY" ? HISTORY_REQUEST_TIMEOUT_MS : kind === "TEACHING" ? TEACHING_SAVE_TIMEOUT_MS : CHECKPOINT_REQUEST_TIMEOUT_MS,
    timeoutError: () => new ReviewHistoryApiError(kind === "HISTORY" ? "HISTORY_REQUEST_TIMEOUT" : kind === "TEACHING" ? "TEACHING_SAVE_TIMEOUT" : "CHECKPOINT_SAVE_TIMEOUT"),
    cancelMessage: kind === "HISTORY" ? "History request cancelled" : kind === "TEACHING" ? "Teaching save cancelled" : "Checkpoint save cancelled", readErrorBody: true, allowInvalidJson: true,
  });
  if (!response.ok) {
    const body = response.payload;
    const code = body && typeof body === "object" && "code" in body && typeof body.code === "string" ? body.code : "REQUEST_FAILED";
    throw new ReviewHistoryApiError(code);
  }
  return response.payload;
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
      const page = await boundedHistoryJson(fetcher, query("/api/review-history", { search, cursor }), { cache: "no-store" }, "HISTORY") as { items: ReviewSummary[]; nextCursor: string | null };
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
      const response = await requestJsonWithDeadline(fetcher,
        `/api/review-history/${encodeURIComponent(reviewId)}/viewer-source`,
        { method: "POST", headers: JSON_HEADERS, cache: "no-store", body: "{}" }, {
          timeoutMs: VIEWER_SOURCE_REQUEST_TIMEOUT_MS,
          timeoutError: () => new ReviewHistoryApiError("VIEWER_SOURCE_TIMEOUT"),
          cancelMessage: "Viewer source request cancelled", readErrorBody: true, allowInvalidJson: true,
        }, signal);
      if (!response.ok) {
        const body = response.payload;
        const code = body && typeof body === "object" && "code" in body && typeof body.code === "string" ? body.code : "REQUEST_FAILED";
        throw new ReviewHistoryApiError(code);
      }
      return response.payload as ManagedDemoSource;
    },
    async importCapability(input: { requestId: string; originalFilename: string; byteSize: number }): Promise<{ requestId: string; capabilityToken: string }> {
      return responseJson(await fetcher("/api/review-history/import-capability", { method: "POST", headers: JSON_HEADERS, cache: "no-store", body: JSON.stringify(input) }));
    },
    async rename(reviewId: string, title: string): Promise<void> {
      await responseJson(await fetcher(`/api/review-history/${encodeURIComponent(reviewId)}`, { method: "PATCH", headers: JSON_HEADERS, cache: "no-store", body: JSON.stringify({ title }) }));
    },
    async markFailed(reviewId: string): Promise<void> {
      await boundedHistoryJson(fetcher, `/api/review-history/${encodeURIComponent(reviewId)}`, { method: "PATCH", headers: JSON_HEADERS, cache: "no-store", body: JSON.stringify({ status: "FAILED" }) }, "HISTORY");
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
      if (input.artifactType === "SESSION_RECOVERY") await boundedHistoryJson(fetcher, endpoint, request);
      else if (TEACHING_ARTIFACT_TYPES.has(input.artifactType)) await boundedHistoryJson(fetcher, endpoint, request, "TEACHING");
      else await responseJson(await fetcher(endpoint, request));
    },
    async commitRuntimeHead(reviewId: string, input: Record<string, unknown>): Promise<{ recoveryArtifactId: string }> {
      const result = await boundedHistoryJson(fetcher, `/api/review-history/${encodeURIComponent(reviewId)}/runtime-head`, { method: "PUT", headers: JSON_HEADERS, cache: "no-store", body: JSON.stringify(input) });
      try {
        const recoveryArtifactId = recoveryArtifactIdFromHead(result);
        if (recoveryArtifactId) return { recoveryArtifactId };
      } catch { /* An ambiguous acknowledgement must not advance the client's expected head. */ }
      throw new ReviewHistoryApiError("INVALID_RUNTIME_HEAD_ACK");
    },
  };
}

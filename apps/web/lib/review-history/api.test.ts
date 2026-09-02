import { describe, expect, it, vi } from "vitest";
import { createReviewHistoryApi } from "./api";

describe("review history Demo deletion API", () => {
  it("previews the exact impact and sends its token in a strict JSON DELETE", async () => {
    const impact = {
      demoId: "demo-a",
      originalFilename: "match.dem",
      reviews: [{ id: "review-a", title: "Mirage · Player", selectedPlayerName: "Player", status: "READY" }],
      reviewCount: 1,
      truncated: false,
      impactToken: "a".repeat(64),
    };
    const fetcher = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify(impact), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ deleted: true }), { status: 200 }));
    const api = createReviewHistoryApi(fetcher as unknown as typeof fetch);

    await expect(api.demoImpact("demo-a")).resolves.toEqual(impact);
    await api.removeDemo("demo-a", impact.impactToken);

    expect(fetcher).toHaveBeenNthCalledWith(1, "/api/review-history/demos/demo-a", { cache: "no-store" });
    expect(fetcher).toHaveBeenNthCalledWith(2, "/api/review-history/demos/demo-a", {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      cache: "no-store",
      body: JSON.stringify({ impactToken: impact.impactToken }),
    });
  });
});

import { afterEach, describe, expect, it, vi } from "vitest";
import { createSyntheticMirageTimeline } from "@cs-coach/demo-domain";
import {
  buildNarrationPayload,
  enrichReviewPlanWithNarration,
  resetNarrationRequestCacheForTests
} from "./coach-narration";
import { createFixtureReviewPlan } from "@cs-coach/review-planner";

function fixturePlan() {
  return createFixtureReviewPlan(createSyntheticMirageTimeline());
}

function successResponse(plan = fixturePlan()) {
  const payload = buildNarrationPayload(plan);
  return {
    status: "SUCCEEDED",
    items: payload.cues.map((cue, index) => ({
      cue_id: cue.cue_id,
      title: `模型标题 ${index + 1}`,
      question: "基于当前事实，先保留撤退路线。",
      explanation: `模型判断 ${index + 1}`
    })),
    manifest: { model: "deepseek-test", prompt_version: "test-prompt/1" }
  };
}

afterEach(() => {
  resetNarrationRequestCacheForTests();
  vi.restoreAllMocks();
});

describe("coach narration client", () => {
  it("builds an anonymous payload from decision-visible facts only", () => {
    const plan = fixturePlan();
    const planWithSensitiveText = structuredClone(plan);
    planWithSensitiveText.cues[0].facts[0].text = "decision tick 前，Подсосник blick'a 有 100 HP / 0 甲。";
    planWithSensitiveText.cues[0].inferences[0].text = "Pod player-r2 应该保留 $800，不要看 outcome path。";
    planWithSensitiveText.cues[0].advice[0].trigger = "rule-advantage-reset 在 canonical tick: 4175 检查。";
    const payload = buildNarrationPayload(planWithSensitiveText, {
      playerNames: ["Подсосник blick'a"],
      additionalForbiddenValues: ["Pod"]
    });
    const serialized = JSON.stringify(payload);

    expect(Object.keys(payload)).toEqual(["cues"]);
    expect(payload.cues[0]).toEqual(expect.objectContaining({ cue_id: "c1" }));
    expect(payload.cues[0].cue_type).toBe("DECISION");
    expect(payload.cues[0].facts[0].id).toBe("f1");
    expect(payload.cues[0].facts[0].availability).toBe("DECISION");
    expect(payload.cues[0].facts.every((fact) => /^f\d+$/.test(fact.id))).toBe(true);
    expect(payload.cues[0].inferences[0].id).toBe("i1");
    expect(payload.cues[0].advice[0].id).toBe("a1");
    expect(serialized).not.toContain(planWithSensitiveText.cues[0].id);
    expect(serialized).not.toContain(planWithSensitiveText.cues[0].facts[0].id);
    expect(serialized).not.toContain(planWithSensitiveText.cues[0].inferences[0].id);
    expect(serialized).not.toContain(planWithSensitiveText.cues[0].advice[0].id);
    expect(serialized).not.toContain(planWithSensitiveText.demo_id);
    expect(serialized).not.toContain(planWithSensitiveText.player_id);
    expect(serialized).not.toContain("Подсосник blick'a");
    expect(serialized).not.toContain("Pod");
    expect(serialized).not.toContain("4169");
    expect(serialized).not.toContain("4175");
    expect(serialized).not.toMatch(/decision_tick|outcome_start_tick|outcome_end_tick|annotations|outcome|trajectory|path|segment_id|demo_id|player_id|observer_player_id|display_name|\btick\b/i);
    expect(serialized).toContain("当前时刻");
    expect(serialized).toContain("100 HP");
    expect(serialized).toContain("0 甲");
    expect(serialized).toContain("$800");
    expect(payload.cues[0].facts).toHaveLength(2);
  });

  it("changes only narration text and the narration manifest on success", async () => {
    const plan = fixturePlan();
    const original = structuredClone(plan);
    const fetcher = vi.fn().mockResolvedValue({ ok: true, json: async () => successResponse(plan) });

    const narrated = await enrichReviewPlanWithNarration(plan, { fetcher });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(narrated.segments).toBe(plan.segments);
    expect(narrated.habit_clusters).toBe(plan.habit_clusters);
    expect(narrated.cues[0].facts).toBe(plan.cues[0].facts);
    expect(narrated.cues[0].advice).toBe(plan.cues[0].advice);
    expect(narrated.cues[0].decision_tick).toBe(original.cues[0].decision_tick);
    expect(narrated.cues[0].observable_fact_refs).toEqual(original.cues[0].observable_fact_refs);
    expect(narrated.cues[0].title).toBe("模型标题 1");
    expect(narrated.cues[0].question).toBe("模型判断 1");
    expect(narrated.cues[0].inferences[0].text).toBe("模型判断 1");
    expect(narrated.cues[0].inferences[0].fact_refs).toEqual(original.cues[0].inferences[0].fact_refs);
    expect(narrated.generation_manifest.provider).toBe("DEEPSEEK");
    expect(narrated.generation_manifest.status).toBe("SUCCEEDED");
    expect(narrated.generation_manifest.narration_deterministic).toBe(false);
    expect(narrated.generation_manifest.model).toBe("deepseek-test");
    expect(narrated.generation_manifest.prompt_version).toBe("test-prompt/1");
  });

  it("passes redaction context to the real request and removes bare tick words", async () => {
    const plan = fixturePlan();
    plan.cues[0].facts[0].text = "decision tick 前，Alpha 保持 100 HP。";
    plan.cues[0].limitations = [
      "该判断只在 canonical tick 前有效。",
      "死亡是结果事实，回看结果事实仅用于揭示。"
    ];
    const requests: string[] = [];
    const fetcher = vi.fn().mockImplementation(async (_input: string, init?: RequestInit) => {
      requests.push(String(init?.body ?? ""));
      return { ok: true, json: async () => successResponse(plan) };
    });

    await enrichReviewPlanWithNarration(plan, {
      fetcher,
      redaction: {
        playerNames: ["Alpha"],
        additionalForbiddenValues: [plan.player_id]
      }
    });

    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(requests[0]).not.toContain("Alpha");
    expect(requests[0]).not.toContain(plan.player_id);
    expect(requests[0]).not.toMatch(/\btick\b/i);
    expect(requests[0]).not.toMatch(/死亡|被击杀|结果|outcome|reveal/i);
    expect(requests[0]).toContain("100 HP");
  });

  it("keeps the original plan for disabled, fallback, HTTP, and network failures", async () => {
    for (const body of [{ status: "DISABLED" }, { status: "FALLBACK" }]) {
      const plan = fixturePlan();
      const result = await enrichReviewPlanWithNarration(plan, {
        fetcher: vi.fn().mockResolvedValue({ ok: true, json: async () => body })
      });
      expect(result).toBe(plan);
      resetNarrationRequestCacheForTests();
    }

    const httpPlan = fixturePlan();
    expect(await enrichReviewPlanWithNarration(httpPlan, {
      fetcher: vi.fn().mockResolvedValue({ ok: false, json: async () => ({}) })
    })).toBe(httpPlan);
    resetNarrationRequestCacheForTests();

    const networkPlan = fixturePlan();
    expect(await enrichReviewPlanWithNarration(networkPlan, {
      fetcher: vi.fn().mockRejectedValue(new Error("offline"))
    })).toBe(networkPlan);
  });

  it("rejects duplicate source IDs and duplicate or incomplete response aliases", async () => {
    const duplicatePlan = fixturePlan();
    duplicatePlan.cues[1].id = duplicatePlan.cues[0].id;
    expect(() => buildNarrationPayload(duplicatePlan)).toThrow(/duplicate cue IDs/);

    const plan = fixturePlan();
    const payload = buildNarrationPayload(plan);
    const duplicateResponse = {
      status: "SUCCEEDED",
      items: [
        { cue_id: payload.cues[0].cue_id, title: "one", question: "one", inference_text: "one" },
        { cue_id: payload.cues[0].cue_id, title: "two", question: "two", explanation: "two" }
      ]
    };
    const result = await enrichReviewPlanWithNarration(plan, {
      fetcher: vi.fn().mockResolvedValue({ ok: true, json: async () => duplicateResponse })
    });
    expect(result).toBe(plan);
  });

  it("deduplicates concurrent requests for one plan", async () => {
    const plan = fixturePlan();
    let resolveResponse: ((value: { ok: boolean; json: () => Promise<unknown> }) => void) | undefined;
    const fetcher = vi.fn().mockReturnValue(new Promise((resolve) => { resolveResponse = resolve; }));
    const first = enrichReviewPlanWithNarration(plan, { fetcher });
    const second = enrichReviewPlanWithNarration(plan, { fetcher });
    expect(fetcher).toHaveBeenCalledTimes(1);
    resolveResponse?.({ ok: true, json: async () => successResponse(plan) });
    expect(await first).toBe(await second);
  });
});

import { describe, expect, it, vi } from "vitest";
import { analyzeFire, fireReplay } from "../../../../libs/cs2d-analysis-adapter/src/window-self-fire-fixtures";
import { buildCoachingPackage, buildOutcomePackage, deterministicNarrationBundle } from "@cs-coach/review-planner";
import { buildNarratorRequestContext, mapNarrationBundle, requestNarrationBundle } from "./narrator-contract";
import { narrateWithDeepSeek } from "./deepseek-narrator";

function productionContext() {
  const bundle = analyzeFire(fireReplay("HP_CHANGE"));
  const cue = bundle.review_plan.cues[0];
  return buildNarratorRequestContext(buildCoachingPackage(cue, bundle.candidate_set, bundle.observation_evidence), buildOutcomePackage(cue, bundle.candidate_set));
}
const fakeEnv = { DEEPSEEK_ALLOW_EMPTY_KEY: true, DEEPSEEK_URL: "http://fake-provider.invalid/completions" };
function copyingProvider() {
  return vi.fn(async (_input: string | URL, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body));
    const request = JSON.parse(body.messages[1].content);
    return new Response(JSON.stringify({ choices: [{ finish_reason: "stop", message: { content: JSON.stringify({ bundle: request.approvedNarration }) } }] }));
  });
}

describe("closed narration local completion", () => {
  it("proves the existing provider copy equals the local approved projection", async () => {
    const context = productionContext(), provider = copyingProvider();
    const response = await narrateWithDeepSeek(context.request, fakeEnv, provider);
    expect(provider).toHaveBeenCalledTimes(1);
    expect(mapNarrationBundle(response.bundle, context)).toEqual(deterministicNarrationBundle(context.coachingPackage, context.outcomePackage));
  });
  it("avoids both client and provider copying for a real production context", async () => {
    const context = productionContext(), provider = copyingProvider();
    const client = vi.fn(async (_input: string | URL, init?: RequestInit) => new Response(JSON.stringify(await narrateWithDeepSeek(JSON.parse(String(init?.body)), fakeEnv, provider))));
    const result = await requestNarrationBundle(context, { fetcher: client });
    expect(result.bundle).toEqual(deterministicNarrationBundle(context.coachingPackage, context.outcomePackage));
    expect(client).not.toHaveBeenCalled();
    expect(provider).not.toHaveBeenCalled();
    expect(result.manifest).toMatchObject({ status: "DISABLED", provider: "DETERMINISTIC", reason: "CLOSED_SEMANTIC_PROJECTION" });
  });
  it("finishes without waiting for an unresponsive transport", async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    let settled = false;
    const fetcher = vi.fn(() => new Promise<Response>(() => {}));
    const pending = requestNarrationBundle(productionContext(), { fetcher, signal: controller.signal }).then(result => { settled = true; return result; }).catch(error => error);
    try {
      await vi.advanceTimersByTimeAsync(0);
      expect(settled).toBe(true);
      expect(fetcher).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);
    } finally { controller.abort(); await pending; vi.useRealTimers(); }
  });
});

it("rebuilds independently of forged approved text, request fields and aliases", async () => {
  const context = productionContext();
  const expected = deterministicNarrationBundle(context.coachingPackage, context.outcomePackage);
  context.request.approvedNarration!.playerAction = { text: "伪造的任意文本", refs: ["o1"], confidence: 1 };
  context.request.coachingPackage.primaryFocusCode = "FORGED";
  context.aliases.action = { wrong: "a1" };
  const fetcher = vi.fn();
  const result = await requestNarrationBundle(context, { fetcher });
  expect(result.bundle).toEqual(expected);
  expect(result.manifest.model).toBeUndefined();
  expect(fetcher).not.toHaveBeenCalled();
});

it.each(["overlap", "identity", "invalid-ref"])("rejects invalid domain input %s without fetching", async mode => {
  const context = productionContext();
  if (mode === "overlap") context.outcomePackage.outcomeFacts = [{ ...context.outcomePackage.outcomeFacts[0], id: context.coachingPackage.allowedRefs.decision[0] }];
  if (mode === "identity") context.outcomePackage.candidateId = "wrong-candidate";
  if (mode === "invalid-ref") context.coachingPackage.allowedRefs.decision = [];
  const fetcher = vi.fn();
  await expect(requestNarrationBundle(context, { fetcher })).rejects.toThrow();
  expect(fetcher).not.toHaveBeenCalled();
});

it("keeps an already-cancelled closed job out of local completion and transport", async () => {
  const controller = new AbortController(); controller.abort();
  const fetcher = vi.fn();
  await expect(requestNarrationBundle(productionContext(), { fetcher, signal: controller.signal })).rejects.toMatchObject({ name: "AbortError" });
  expect(fetcher).not.toHaveBeenCalled();
});

it("keeps domain-valid long narration startable through the existing local fallback", async () => {
  const context = productionContext();
  context.coachingPackage.decisionContext.facts = context.coachingPackage.decisionContext.facts.map(fact => ({ ...fact, text: "该项已记录事实。".repeat(90) }));
  const expected = deterministicNarrationBundle(context.coachingPackage, context.outcomePackage);
  expect(expected.currentSituation.text.length).toBeGreaterThan(1600);
  const fetcher = vi.fn();
  const result = await requestNarrationBundle(context, { fetcher });
  expect(result.bundle).toEqual(expected);
  expect(result.manifest).toMatchObject({ status: "FALLBACK", provider: "DETERMINISTIC", reason: "LOCAL_WIRE_VALIDATION_FAILED" });
  expect(fetcher).not.toHaveBeenCalled();
});

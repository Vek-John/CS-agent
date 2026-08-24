import { afterEach, describe, expect, it, vi } from "vitest";
import type { SessionWrapUpBuildInput, SessionWrapUpRequest } from "@cs-coach/coach-agent";
import {
  directSessionWrapUp,
  requestSessionWrapUp,
} from "./deepseek-wrap-up";

function buildInput(): SessionWrapUpBuildInput {
  const theme = (focus: string, cueRefs: string[], evidenceRef: string, adviceRef: string, occurrence: number) => ({
    focus,
    cueRefs,
    roundRefs: cueRefs.map((cueId) => `round-${cueId}`),
    evidenceRefs: [evidenceRef],
    occurrence,
    economyContext: "FULL" as const,
    repeated: true as const,
    conflictEvidence: false,
    adviceRefs: [adviceRef],
    limitations: [],
  });
  const cue = (cueId: string, focus: string, evidenceRef: string, adviceRef: string) => ({
    cueId,
    roundId: `round-${cueId}`,
    focus,
    evidenceRefs: [evidenceRef],
    adviceRefs: [adviceRef],
  });
  const source = (cueId: string, focus: string, adviceRef: string, evidenceRef: string) => ({
    cueId,
    focus,
    coreIssue: { text: `${focus} 的现有问题。`, refs: [`decision-${cueId}`], limitations: [] },
    betterPlay: { text: `${focus} 的现有改法。`, refs: [adviceRef], limitations: [] },
    advice: [{ id: adviceRef, text: `${focus} 的现有训练建议。`, refs: [evidenceRef] }],
  });
  return {
    summary: {
      schemaVersion: "coach-agent-session-summary.v1",
      themes: [
        theme("THEME_A", ["cue-a-1", "cue-a-2", "cue-a-3"], "evidence-a", "advice-a", 3),
        theme("THEME_B", ["cue-b-1", "cue-b-2"], "evidence-b", "advice-b", 2),
        theme("THEME_C", ["cue-c-1", "cue-c-2"], "evidence-c", "advice-c", 2),
      ],
      completedCues: [
        cue("cue-a-1", "THEME_A", "evidence-a", "advice-a"),
        cue("cue-b-1", "THEME_B", "evidence-b", "advice-b"),
        cue("cue-c-1", "THEME_C", "evidence-c", "advice-c"),
      ],
      limitations: [],
    },
    presentableCues: {
      "cue-a-1": source("cue-a-1", "THEME_A", "advice-a", "evidence-a"),
      "cue-b-1": source("cue-b-1", "THEME_B", "advice-b", "evidence-b"),
      "cue-c-1": source("cue-c-1", "THEME_C", "advice-c", "evidence-c"),
    },
  };
}

function anonymousRequest(): SessionWrapUpRequest {
  return {
    schemaVersion: "coach-agent-session-wrap-up.v1",
    themes: [
      { focus: "f1", cueRefs: ["c1"], evidenceRefs: ["e1"], occurrence: 2, economyContext: "FULL", repeated: true, conflictEvidence: false, adviceRefs: ["v1"], limitations: [] },
      { focus: "f2", cueRefs: ["c2"], evidenceRefs: ["e2"], occurrence: 2, economyContext: "ECO", repeated: true, conflictEvidence: false, adviceRefs: ["v2"], limitations: [] },
      { focus: "f3", cueRefs: ["c3"], evidenceRefs: ["e3"], occurrence: 2, economyContext: "FORCE", repeated: true, conflictEvidence: false, adviceRefs: ["v3"], limitations: [] },
    ],
    completedCues: [
      { cueId: "c1", focus: "f1", coreIssue: { text: "问题一", refs: ["r1"], limitations: [] }, betterPlay: { text: "改法一", refs: ["r2"], limitations: [] }, advice: [{ id: "v1", text: "建议一", refs: ["r3"] }] },
      { cueId: "c2", focus: "f2", coreIssue: { text: "问题二", refs: ["r4"], limitations: [] }, betterPlay: { text: "改法二", refs: ["r5"], limitations: [] }, advice: [{ id: "v2", text: "建议二", refs: ["r6"] }] },
      { cueId: "c3", focus: "f3", coreIssue: { text: "问题三", refs: ["r7"], limitations: [] }, betterPlay: { text: "改法三", refs: ["r8"], limitations: [] }, advice: [{ id: "v3", text: "建议三", refs: ["r9"] }] },
    ],
    limitations: [],
  };
}

function completion(bundle: unknown, finishReason = "stop"): Response {
  return new Response(JSON.stringify({
    choices: [{ finish_reason: finishReason, message: { content: JSON.stringify({ bundle }) } }],
  }), { status: 200, headers: { "content-type": "application/json" } });
}

function successBundle(secondCue = "c4") {
  return {
    schemaVersion: "coach-agent-session-wrap-up.v1",
    themes: [
      { focus: "f1", summary: { text: "主题一总结", refs: ["c1", "e1"] }, trainingAdvice: { text: "建议一", refs: ["v1"] } },
      { focus: "f2", summary: { text: "主题二总结", refs: [secondCue] }, trainingAdvice: { text: "建议二", refs: ["v2"] } },
      { focus: "f3", summary: { text: "主题三总结", refs: ["e3"] }, trainingAdvice: { text: "建议三", refs: ["v3"] } },
    ],
    limitations: [],
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("DeepSeek Session Wrap-Up adapter", () => {
  it("anonymizes the strict packet, maps a legal provider result, and hides control-plane fields", async () => {
    let requestBody: Record<string, unknown> | undefined;
    const result = await requestSessionWrapUp(buildInput(), {
      fetcher: async (_url, init) => {
        requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return new Response(JSON.stringify({
          status: "SUCCEEDED",
          bundle: successBundle(),
          manifest: { status: "SUCCEEDED", provider: "DEEPSEEK", model: "deepseek-v4-flash", limitations: [] },
        }), { status: 200, headers: { "content-type": "application/json" } });
      },
    });

    expect(result.status).toBe("SUCCEEDED");
    expect(result.manifest.provider).toBe("DEEPSEEK");
    expect(result.bundle.themes.map((theme) => theme.focus)).toEqual(["THEME_A", "THEME_B", "THEME_C"]);
    expect(result.bundle.themes.map((theme) => theme.trainingAdvice.refs[0])).toEqual(["advice-a", "advice-b", "advice-c"]);
    const serialized = JSON.stringify(requestBody);
    expect(serialized).not.toMatch(/tick|route|playerId|rawReplay|frames|prompt|cot/i);
    expect(requestBody).toMatchObject({ schemaVersion: "coach-agent-session-wrap-up.v1" });
  });

  it.each([
    ["network failure", async () => { throw new Error("offline"); }],
    ["invalid JSON", async () => new Response("not-json", { status: 200 })],
  ])("returns deterministic fallback for %s", async (_label, fetcher) => {
    const result = await requestSessionWrapUp(buildInput(), { fetcher: fetcher as never });
    expect(result.status).toBe("FALLBACK");
    expect(result.manifest.provider).toBe("DETERMINISTIC");
    expect(result.bundle.themes[0]?.trainingAdvice.refs).toEqual(["advice-a"]);
  });

  it("falls back when the provider adds a field, a fourth theme, changes focus, or uses an unknown ref", async () => {
    const invalidBundles = [
      { ...successBundle(), themes: successBundle().themes.map((theme) => ({ ...theme, facts: ["new-fact"] })) },
      { ...successBundle(), themes: [...successBundle().themes, successBundle().themes[0]!] },
      { ...successBundle(), themes: successBundle().themes.map((theme, index) => index === 0 ? { ...theme, focus: "f9" } : theme) },
      { ...successBundle(), themes: successBundle().themes.map((theme, index) => index === 0 ? { ...theme, summary: { ...theme.summary, refs: ["e99"] } } : theme) },
    ];
    for (const bundle of invalidBundles) {
      const result = await requestSessionWrapUp(buildInput(), {
        fetcher: async () => new Response(JSON.stringify({
          status: "SUCCEEDED",
          bundle,
          manifest: { status: "SUCCEEDED", provider: "DEEPSEEK", limitations: [] },
        }), { status: 200 }),
      });
      expect(result.status).toBe("FALLBACK");
      expect(result.manifest.reason).toBe("WRAP_UP_REQUEST_FAILED");
    }
  });

  it("direct provider seam handles missing key, timeout, invalid JSON, and legal success", async () => {
    await expect(directSessionWrapUp(anonymousRequest(), {})).resolves.toMatchObject({ status: "FALLBACK", manifest: { reason: "MISSING_API_KEY" } });
    await expect(directSessionWrapUp(anonymousRequest(), { DEEPSEEK_API_KEY: "secret" }, async () => { throw new DOMException("timeout", "AbortError"); })).resolves.toMatchObject({ status: "FALLBACK", manifest: { reason: "TIMEOUT" } });
    await expect(directSessionWrapUp(anonymousRequest(), { DEEPSEEK_API_KEY: "secret" }, async () => completion({}, "stop"))).resolves.toMatchObject({ status: "FALLBACK", manifest: { reason: "UPSTREAM_SCHEMA" } });
    await expect(directSessionWrapUp(anonymousRequest(), { DEEPSEEK_API_KEY: "secret" }, async () => completion(successBundle("c2")))).resolves.toMatchObject({ status: "SUCCEEDED", manifest: { provider: "DEEPSEEK" } });
  });
});

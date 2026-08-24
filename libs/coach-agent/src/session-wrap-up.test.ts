import { describe, expect, it } from "vitest";
import {
  assertValidSessionWrapUpBundle,
  buildSessionWrapUpRequest,
  deterministicSessionWrapUpResult,
  type SessionWrapUpBuildInput,
} from "./session-wrap-up";

function theme(focus: string, cueRefs: string[], evidenceRef: string, adviceRef: string, occurrence: number) {
  return {
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
  };
}

function cue(cueId: string, focus: string, evidenceRef: string, adviceRef: string) {
  return {
    cueId,
    roundId: `round-${cueId}`,
    focus,
    evidenceRefs: [evidenceRef],
    adviceRefs: [adviceRef],
  };
}

function source(cueId: string, focus: string, adviceRef: string, evidenceRef: string) {
  return {
    cueId,
    focus,
    coreIssue: { text: `${focus} 的已验证问题。`, refs: [`decision-${cueId}`], limitations: [] },
    betterPlay: { text: `${focus} 的已有改进建议。`, refs: [adviceRef], limitations: [] },
    advice: [{ id: adviceRef, text: `${focus} 的训练建议。`, refs: [evidenceRef] }],
  };
}

function validInput(): SessionWrapUpBuildInput {
  return {
    summary: {
      schemaVersion: "coach-agent-session-summary.v1",
      themes: [
        theme("THEME_A", ["cue-a-1", "cue-a-2", "cue-a-3"], "evidence-a", "advice-a", 3),
        theme("THEME_B", ["cue-b-1", "cue-b-2"], "evidence-b", "advice-b", 2),
        theme("THEME_C", ["cue-c-1", "cue-c-2"], "evidence-c", "advice-c", 2),
      ],
      // These are the stable representatives selected by the Graph; the
      // earlier cues remain legal theme refs but need not be re-read.
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

describe("Session Wrap-Up domain seam", () => {
  it("builds a strict three-theme request from completed presentable cue material", () => {
    const request = buildSessionWrapUpRequest(validInput());

    expect(request.themes).toHaveLength(3);
    expect(request.completedCues).toHaveLength(3);
    expect(Object.keys(request)).toEqual(["schemaVersion", "themes", "completedCues", "limitations"]);
    expect(JSON.stringify(request)).not.toMatch(/tick|route|playerId|rawReplay|frames|prompt|cot/i);

    const fallback = deterministicSessionWrapUpResult(request, "MISSING_API_KEY");
    expect(fallback.status).toBe("FALLBACK");
    expect(fallback.bundle.themes.map((item) => item.focus)).toEqual(["THEME_A", "THEME_B", "THEME_C"]);
    expect(fallback.bundle.themes.map((item) => item.trainingAdvice.refs[0])).toEqual([
      "advice-a",
      "advice-b",
      "advice-c",
    ]);
    expect(fallback.bundle.themes[0]?.trainingAdvice.text).toContain("THEME_A");
  });

  it("rejects singleton themes and cross-theme cue/evidence/advice references", () => {
    const singleton = validInput();
    singleton.summary = {
      ...singleton.summary,
      themes: [{ ...singleton.summary.themes[0]!, repeated: false } as never],
    };
    expect(() => buildSessionWrapUpRequest({
      ...singleton,
    })).toThrow(/singleton|invalid/i);

    const unknownCue = validInput();
    unknownCue.summary.completedCues[0] = cue("cue-unknown", "THEME_A", "evidence-a", "advice-a");
    expect(() => buildSessionWrapUpRequest(unknownCue)).toThrow(/cue/i);

    const unknownEvidence = validInput();
    unknownEvidence.summary.completedCues[0] = cue("cue-a-1", "THEME_A", "evidence-not-in-theme", "advice-a");
    expect(() => buildSessionWrapUpRequest(unknownEvidence)).toThrow(/evidence/i);

    const unknownAdvice = validInput();
    unknownAdvice.summary.completedCues[0] = cue("cue-a-1", "THEME_A", "evidence-a", "advice-not-in-theme");
    expect(() => buildSessionWrapUpRequest(unknownAdvice)).toThrow(/advice/i);
  });

  it("rejects provider-added facts, fourth themes, changed focus, and unknown output refs", () => {
    const request = buildSessionWrapUpRequest(validInput());
    const valid = deterministicSessionWrapUpResult(request, "TEST").bundle;

    expect(() => assertValidSessionWrapUpBundle({
      ...valid,
      themes: valid.themes.map((item) => ({
        ...item,
        summary: { ...item.summary, facts: ["invented"] },
      })),
    }, request)).toThrow();

    expect(() => assertValidSessionWrapUpBundle({
      ...valid,
      themes: [...valid.themes, valid.themes[0]!],
    }, request)).toThrow();

    expect(() => assertValidSessionWrapUpBundle({
      ...valid,
      themes: valid.themes.map((item, index) => index === 0 ? { ...item, focus: "THEME_NEW" } : item),
    }, request)).toThrow(/focus|theme/i);

    expect(() => assertValidSessionWrapUpBundle({
      ...valid,
      themes: valid.themes.map((item, index) => index === 0 ? {
        ...item,
        summary: { ...item.summary, refs: ["unknown-evidence"] },
      } : item),
    }, request)).toThrow(/ref/i);
  });
});

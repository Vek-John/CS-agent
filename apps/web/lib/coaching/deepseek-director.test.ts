import { describe, expect, it, vi } from "vitest";
import { MAX_DIRECTOR_PACKET_CANDIDATES, MAX_TEACHING_CUES } from "@cs-coach/contracts";
import type { CandidateMaterial, TeachingCandidate } from "@cs-coach/contracts";
import { assembleCandidateSet } from "@cs-coach/review-planner";
import {
  buildDirectorProviderRequestContext,
  directWithDeepSeek,
  parseDirectorRequest,
  requestTeachingDirector
} from "./deepseek-director";

const manifest = {
  timelineVersion: "timeline/1",
  sceneIndexVersion: "scene/1",
  observationVersion: "observation/1",
  signalVersion: "signal/1",
  candidateGeneratorVersion: "generator/1"
} as const;

function decisionSnapshot(decisionTick: number): import("@cs-coach/contracts").DecisionSnapshot {
  const unknown = { value: null, boundary: "OBSERVABLE" as const, evidenceRefs: [], limitations: [] };
  return {
    version: "decision-snapshot.v1", snapshotId: "snapshot-test", roundNumber: 1,
    selectedPlayerId: "p-user", decisionTick, sampledAtTick: decisionTick,
    selectedPlayer: unknown,
    aliveCounts: { ...unknown, value: { allies: 1, enemies: 3, includesSelectedPlayer: true } },
    players: [], score: unknown, clock: unknown, bomb: unknown,
    supportChecks: [], pressureChecks: [], spatialChecks: [], missingFields: [], limitations: [],
  };
}

function candidate(index: number): TeachingCandidate {
  const id = `candidate-${index}`;
  return {
    candidateId: id,
    decisionSnapshot: decisionSnapshot(index * 100 + 10),
    roundNumber: (index % 20) + 1,
    source: { kind: "DEATH", refs: [`source-${index}`] },
    preRollStart: index * 100,
    decisionTick: index * 100 + 10,
    revealTick: index * 100 + 20,
    outcomeEnd: index * 100 + 80,
    factRefs: [`fact-${index}`],
    observableClaimRefs: [],
    actionRefs: [`action-${index}`],
    outcomeRefs: [`outcome-${index}`],
    evidenceRefs: [`evidence-${index}`],
    winRateSignalRefs: index % 2 === 0 ? [`swing-${index}`] : [],
    economySignalRefs: [`economy-${index}`],
    missingFields: [],
    limitations: index % 3 === 0 ? ["多个结果事件同时发生"] : [],
    deterministicScore: 5 + (index % 5),
    resultSummary: {
      winProbabilityBefore: 0.65,
      winProbabilityAfter: 0.42,
      winProbabilityDelta: -0.23,
      winProbabilityPercentagePoints: -23,
      selectedPlayerDeath: true,
      economyClass: index % 3 === 0 ? "ECO" : index % 3 === 1 ? "FORCE" : "FULL",
      concurrentEvents: index % 3 === 0,
      missingFields: [],
      limitations: []
    }
  };
}

function material(index: number): CandidateMaterial {
  return {
    candidateId: `candidate-${index}`,
    decisionFacts: [{ id: `fact-${index}`, text: "决策时有可用事实。", availability: "DECISION", available_at_tick: index * 100 + 10, source: "DEMO", observed_by_player: true }],
    playerActionFacts: [{ id: `action-${index}`, text: "你继续处理当前接触。", actorPlayerId: "p-user", availableAtTick: index * 100 + 10, source: "DEMO", evidenceRefs: [`source-${index}`], limitations: [] }],
    outcomeFacts: [{ id: `outcome-${index}`, text: "结果窗口发生可验证事件。", availableAtTick: index * 100 + 20, source: "DEMO", outcomeKind: "DEATH", evidenceRefs: [`source-${index}`], limitations: [] }],
    inferences: [],
    advice: [],
    evidence: [{ id: `evidence-${index}`, source: "DEMO", label: "evidence", fact_refs: [`fact-${index}`] }],
    limitations: []
  };
}

function candidateSet(count = 100) {
  return assembleCandidateSet({
    id: "candidate-set-provider",
    version: "candidate/1",
    demoId: "demo-provider",
    playerId: "p-user",
    candidates: Array.from({ length: count }, (_, index) => candidate(index)),
    materials: Array.from({ length: count }, (_, index) => material(index)),
    generationManifest: manifest
  });
}

function successfulKillSet() {
  const base = candidateSet(1);
  const candidate = {
    ...base.candidates[0],
    source: { kind: "KILL" as const, refs: ["successful-kill"] },
    resultSummary: {
      ...base.candidates[0].resultSummary,
      selectedPlayerDeath: false,
      winProbabilityBefore: 0.4,
      winProbabilityAfter: 0.7,
      winProbabilityDelta: 0.3,
      winProbabilityPercentagePoints: 30
    }
  };
  return assembleCandidateSet({ ...base, candidates: [candidate], materials: [...base.materials] });
}

function noModelKillSet() {
  const base = successfulKillSet();
  const candidate = {
    ...base.candidates[0],
    resultSummary: {
      ...base.candidates[0].resultSummary,
      winProbabilityBefore: undefined,
      winProbabilityAfter: undefined,
      winProbabilityDelta: undefined,
      winProbabilityPercentagePoints: undefined,
      limitations: ["WinProbabilityTimeline unavailable."]
    }
  };
  return assembleCandidateSet({ ...base, candidates: [candidate] });
}

function completion(content: string, finishReason = "stop"): Response {
  return new Response(JSON.stringify({ choices: [{ finish_reason: finishReason, message: { content } }] }), { status: 200, headers: { "content-type": "application/json" } });
}

describe("DeepSeek Director provider packet", () => {
  it("keeps the full CandidateSet while budgeting the anonymous provider packet", () => {
    const set = candidateSet();
    const context = buildDirectorProviderRequestContext(set);
    expect(set.candidates).toHaveLength(100);
    expect(context.request.candidates).not.toHaveLength(0)
    expect(context.request.candidates.length).toBeLessThanOrEqual(MAX_DIRECTOR_PACKET_CANDIDATES);
    expect(new TextEncoder().encode(JSON.stringify(context.request)).byteLength).toBeLessThan(48 * 1024);
    expect(context.request.candidates[0].result_summary).toMatchObject({ selectedPlayerDeath: true, winProbabilityDelta: -0.23 });
    expect(context.request.candidates[0].allowed_focus_codes).toContain("REVIEW_UNCERTAINTY");
  });

  it("keeps hostile missing-field text inside the 48KB provider packet budget", () => {
    const base = candidateSet(100);
    const hugeText = "missing-field-" + "x".repeat(20_000);
    const set = assembleCandidateSet({
      ...base,
      candidates: base.candidates.map((candidate) => ({
        ...candidate,
        missingFields: [hugeText],
        resultSummary: { ...candidate.resultSummary, missingFields: [hugeText] }
      }))
    });
    const context = buildDirectorProviderRequestContext(set);
    expect(new TextEncoder().encode(JSON.stringify(context.request)).byteLength).toBeLessThan(48 * 1024);
  });

  it("carries the 50-cue route cap through the provider request boundary", () => {
    const context = buildDirectorProviderRequestContext(candidateSet(1), MAX_TEACHING_CUES);
    expect(context.request.max_selected).toBe(50);
    expect(() => parseDirectorRequest(context.request)).not.toThrow();
  });

  it("states the exact selected response shape so the provider does not echo the request", async () => {
    const context = buildDirectorProviderRequestContext(candidateSet(1));
    let requestBody: { messages?: Array<{ content?: string }> } | undefined;
    const result = await directWithDeepSeek(context.request, { DEEPSEEK_API_KEY: "secret" }, async (_input, init) => {
      requestBody = JSON.parse(String(init?.body));
      return completion(JSON.stringify({
        selected: [{
          candidate_id: "c1",
          priority: 1,
          primary_focus_code: "REVIEW_UNCERTAINTY",
          selection_reason: "有明确的死亡结果和可验证证据。",
          reason_refs: ["r1"],
          evidence_refs: ["e1"],
          confidence: 0.8
        }]
      }));
    });

    expect(result.status).toBe("SUCCEEDED");
    const clientResult = await requestTeachingDirector(candidateSet(1), { fetcher: async () => Response.json(result) });
    expect(clientResult.manifest.status).toBe("SUCCEEDED");
    expect(clientResult.selected).toHaveLength(1);
    expect(requestBody?.messages?.[0]?.content).toContain("do not use a selections key");
    expect(requestBody?.messages?.[0]?.content).toContain("priority, primary_focus_code, selection_reason, reason_refs, evidence_refs, confidence");
    expect(requestBody?.messages?.[0]?.content).toContain("Do not echo candidate_set_id");
  });

  it("returns deterministic fallback with a reason for missing key and invalid provider schema", async () => {
    const context = buildDirectorProviderRequestContext(candidateSet(1));
    await expect(directWithDeepSeek(context.request, {}, vi.fn())).resolves.toMatchObject({ status: "FALLBACK", reason: "MISSING_API_KEY" });
    const invalid = JSON.stringify({ selected: [{ candidate_id: "c1", priority: 1, primary_focus_code: "INVENTED_FOCUS", selection_reason: "选择", reason_refs: ["r1"], evidence_refs: ["e1"], confidence: 0.8 }] });
    await expect(directWithDeepSeek(context.request, { DEEPSEEK_API_KEY: "secret" }, async () => completion(invalid))).resolves.toMatchObject({ status: "FALLBACK", reason: "UPSTREAM_SCHEMA" });
  });

  it("passes an AbortSignal through the client Director seam and does not synthesize fallback", async () => {
    const controller = new AbortController();
    const abort = Object.assign(new Error("aborted"), { name: "AbortError" });
    const fetcher = vi.fn(async (_input: string | URL, init?: RequestInit) => {
      expect(init?.signal?.aborted).toBe(false);
      throw abort;
    });
    await expect(requestTeachingDirector(candidateSet(1), { fetcher, signal: controller.signal })).rejects.toMatchObject({ name: "AbortError" });
  });

  it("does not create a provider job for an ordinary candidate-less round", async () => {
    const fetcher = vi.fn();
    const result = await requestTeachingDirector(candidateSet(0), { fetcher });
    expect(result.manifest.status).toBe("DISABLED");
    expect(result.manifest.reason).toBe("NO_CANDIDATES");
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("does not call the provider when only non-practical KILL candidates remain", async () => {
    const fetcher = vi.fn();
    const result = await requestTeachingDirector(successfulKillSet(), { fetcher });
    expect(result.manifest.status).toBe("DISABLED");
    expect(result.manifest.reason).toBe("NO_PRACTICAL_CANDIDATES");
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("does not call the provider for a KILL when WinProbabilityTimeline is unavailable", async () => {
    const fetcher = vi.fn();
    const result = await requestTeachingDirector(noModelKillSet(), { fetcher });
    expect(result.manifest.status).toBe("DISABLED");
    expect(result.manifest.reason).toBe("NO_PRACTICAL_CANDIDATES");
    expect(fetcher).not.toHaveBeenCalled();
  });
});

it("projects public decision state and rejects hidden-state additions to the Director wire", () => {
  const set = candidateSet(1);
  const snapshot = decisionSnapshot(10);
  snapshot.players = [{ playerId: "hidden-enemy-identity", side: "CT", alive: true, health: 83, boundary: "APPLICABILITY_ONLY" }];
  snapshot.clock = { value: { phase: "LIVE", elapsedSeconds: 70, remainingSeconds: 45 }, boundary: "OBSERVABLE", evidenceRefs: ["fact-0"], limitations: [] };
  snapshot.bomb = { value: { state: "PLANTED", carriedBySelectedPlayer: false, remainingSeconds: 8 }, boundary: "GROUND_TRUTH", evidenceRefs: ["hidden-bomb"], limitations: [] };
  const modified = assembleCandidateSet({ ...set, materials: [{ ...set.materials[0], decisionSnapshot: snapshot }] });
  const context = buildDirectorProviderRequestContext(modified);
  expect(context.request.candidates[0].decision_summary?.situation).toMatchObject({ allies: 1, enemies: 3, remainingSeconds: 45, objective: null });
  const packet = JSON.stringify(context.request);
  expect(packet).not.toMatch(/hidden-enemy-identity|hidden-bomb|decisionTick|sampledAtTick|GROUND_TRUTH|APPLICABILITY_ONLY|world_position/);
  expect(context.request.candidates[0].decision_summary?.approved_advice).toEqual([]);
  const malicious = structuredClone(context.request);
  Object.assign(malicious.candidates[0].result_summary, { enemyPositions: [{ x: 1234, y: 5678 }] });
  expect(() => parseDirectorRequest(malicious)).toThrow(/unapproved data/);
});


describe("bounded preparation transport regression", () => {
  it.each(["fetch", "body"] as const)("settles a hung %s at the client deadline even if abort is ignored", async stage => {
    vi.useFakeTimers();
    try {
      const never = new Promise<Response>(() => {});
      const fetcher = vi.fn(() => stage === "fetch" ? never : Promise.resolve({ ok: true, status: 200, json: () => new Promise(() => {}) } as Response));
      let settled = false;
      const pending = requestTeachingDirector(candidateSet(1), { fetcher }).then(value => { settled = true; return value; });
      await vi.advanceTimersByTimeAsync(20_000);
      expect(settled).toBe(true);
      expect((await pending).manifest).toMatchObject({ status: "FALLBACK", reason: "LOCAL_REQUEST_TIMEOUT" });
    } finally { vi.useRealTimers(); }
  });
});


it("does not request or return fallback when the client parent is already cancelled", async () => {
  const parent = new AbortController(); parent.abort(); const fetcher = vi.fn();
  await expect(requestTeachingDirector(candidateSet(1), { fetcher, signal: parent.signal })).rejects.toMatchObject({ name: "AbortError" });
  expect(fetcher).not.toHaveBeenCalled();
});
it("exits the client on parent cancellation even when fetch ignores abort", async () => {
  vi.useFakeTimers();
  try {
    const parent = new AbortController();
    const pending = requestTeachingDirector(candidateSet(1), { fetcher: () => new Promise(() => {}), signal: parent.signal }).catch(error => error);
    parent.abort();
    expect(await pending).toMatchObject({ name: "AbortError" });
    expect(vi.getTimerCount()).toBe(0);
  } finally { vi.useRealTimers(); }
});


it.each(["http", "bad-body"] as const)("retains the client fallback reason for %s", async mode => {
  const fetcher = async () => mode === "http" ? new Response(null, { status: 503 })
    : Object.assign(new Response(), { json: async () => { throw new SyntaxError("bad-body"); } });
  const result = await requestTeachingDirector(candidateSet(1), { fetcher });
  expect(result.manifest).toMatchObject({ status: "FALLBACK", reason: mode === "http" ? "HTTP_503" : "bad-body" });
});

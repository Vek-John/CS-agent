import { describe, expect, it } from "vitest";
import { CoachAgentEventSchema, MemoryBriefWireSchema, diagnoseTeachingCue, type CoachAgentEvent, type CoachAgentResult } from "@cs-coach/coach-agent";
import { InMemoryMemoryRepository, MemoryService, MemoryBriefSchema, buildAgentMemoryBrief, approximateMemoryBriefTokens } from "@cs-coach/memory";
import { buildLocalAgentMemoryEvents } from "./agent-events";

describe("uncertain diagnoses across distinct Demo evidence", () => {
  it.each(["RESOURCE", "INFORMATION"] as const)("preserves %s uncertainty after aggregation and Agent projection", async kind => {
    const userId = "uncertain-recall-user";
    const service = new MemoryService({ repository: new InMemoryMemoryRepository(), memoryEnabled: true });
    await service.setAuthorization(userId, { userId, memoryEnabled: true, consent: "GRANTED" });
    for (const suffix of ["first", "second"]) {
      const cueId = `cue-${suffix}`;
      const event = CoachAgentEventSchema.parse({
        version: "coach-agent-event.v2", type: "SUBMIT_REFLECTION", eventId: `event-${suffix}`,
        identity: { runId: `run-${suffix}`, sessionId: `session-${suffix}`, demoId: `demo-${suffix}`,
          demoContentHash: `synthetic-content-${suffix}`, selectedPlayerId: "player-selected", routeId: `route-${suffix}`, routeHash: "route-version" },
        cueId, outcomeGateStatus: "COMPLETE",
        reflection: { cueId, selectedGoal: kind === "RESOURCE" ? "OTHER" : "GET_INFO",
          rawText: kind === "RESOURCE" ? "我没甲" : "我没有看到敌人", response: "ANSWERED", source: "USER", limitations: [] },
        input: { cueId, candidateId: `candidate-${suffix}`, focusCode: "POSITIONING", decisionFacts: [], playerActionFacts: [], outcomeFacts: [],
          decisionResources: { health: 100, armor: 100, hasHelmet: true, utilityCount: 2, evidenceRefs: ["synthetic-resource"] }, limitations: [] },
      }) as Extract<CoachAgentEvent, { type: "SUBMIT_REFLECTION" }>;
      const output = diagnoseTeachingCue({ ...(event.input as Parameters<typeof diagnoseTeachingCue>[0]), reflection: event.reflection });
      expect(output.cueCase.verdict?.type).toBe("INCONCLUSIVE");
      const result = { identity: event.identity, state: { cueCases: { [cueId]: output.cueCase }, learningThreads: [output.learningThread] } } as unknown as CoachAgentResult;
      const events = buildLocalAgentMemoryEvents(event, result, userId);
      expect(events).toHaveLength(1);
      const ingested = await service.ingestEvent(userId, events[0]);
      expect(ingested.accepted).toBe(true);
      expect(ingested.record?.status).toBe(suffix === "first" ? "CANDIDATE" : "EMERGING");
    }
    const recalled = await service.getBrief(userId);
    expect(recalled.memories).toHaveLength(1);
    expect(recalled.memories[0].demoContentHashes).toHaveLength(2);
    const projected = MemoryBriefWireSchema.parse(buildAgentMemoryBrief(recalled));
    expect(projected.memories).toHaveLength(1);
    const memory = projected.memories[0] as { verdict: { type: string; confidence: number; explanation: string }; claims: { type: string; verification: string }[]; transferRule: { do: string; unless?: string; limitations?: string[] } };
    expect(memory.verdict.type).toBe("INCONCLUSIVE");
    expect(memory.verdict.confidence).toBe(recalled.memories[0].verdict?.confidence);
    expect(memory.claims.find(claim => claim.type === (kind === "RESOURCE" ? "RESOURCE_BELIEF" : "ENEMY_BELIEF"))?.verification).toBe("UNVERIFIABLE");
    expect(recalled.memories[0].transferRule?.limitations).toContain("这条规则是条件化建议，不代表已确定归因。");
    expect(memory.transferRule.limitations).toEqual(recalled.memories[0].transferRule?.limitations);
    if (kind === "INFORMATION") expect(memory.transferRule.unless).toContain("保持条件化判断");
    expect(projected.activeThreads.length).toBeGreaterThan(0);
    for (const thread of projected.activeThreads as { transferRule: { limitations: string[] } }[]) {
      expect(thread.transferRule.limitations).toContain("这条规则是条件化建议，不代表已确定归因。");
    }
    expect(approximateMemoryBriefTokens(projected)).toBeLessThanOrEqual(800);
    expect(JSON.stringify(projected)).not.toContain(userId);
    // This is a schema-valid size probe, not an additional observation or a
    // write to the repository. Even a late qualification must not be clipped.
    const limitations = Array.from({ length: 12 }, (_, i) => `${String(i).padEnd(235, "限")}不能省略。`);
    const large = MemoryBriefSchema.parse({ ...recalled,
      activeThreads: recalled.activeThreads.map(thread => ({ ...thread, transferRule: { ...thread.transferRule, limitations } })),
      memories: recalled.memories.map(record => ({ ...record, transferRule: { ...record.transferRule!, limitations },
        advice: record.advice.map(advice => ({ ...advice, do: "UNQUALIFIED_ADVICE_MUST_DISAPPEAR" })) })),
    });
    const fallback = MemoryBriefWireSchema.parse(buildAgentMemoryBrief(large));
    expect(fallback.source).toBe("EMPTY");
    expect(fallback.memories).toEqual([]);
    expect(fallback.activeThreads).toEqual([]);
    expect(JSON.stringify(fallback)).not.toContain("UNQUALIFIED_ADVICE_MUST_DISAPPEAR");
    expect(approximateMemoryBriefTokens(fallback)).toBeLessThanOrEqual(800);
    await service.setAuthorization(userId, { userId, memoryEnabled: true, consent: "REVOKED" });
    expect((await service.getBrief(userId)).memories).toEqual([]);
  });
});

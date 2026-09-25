import { describe, expect, it } from "vitest";
import { deserializeCs2dAnalysisBundle, serializeCs2dAnalysisBundle } from "./index";
import { buildCoachingPackage, buildOutcomePackage, deterministicNarrationBundle } from "@cs-coach/review-planner";

import { analyzeFire, fireReplay, self, shot } from "./window-self-fire-fixtures";

describe("existing processing-window self fire evidence", () => {
  it.each(["DEATH", "HP_CHANGE"] as const)("carries an independent shot through the real %s Adapter/Compiler/Narrator", kind => {
    const bundle = analyzeFire(fireReplay(kind));
    const candidate = bundle.candidate_set.candidates.find(c => c.source.kind === kind)!;
    expect(candidate).toMatchObject({ decisionTick: 1400, revealTick: 1408 });
    const material = bundle.candidate_set.materials.find(m => m.candidateId === candidate.candidateId)!;
    expect(material.playerActionFacts).toHaveLength(1);
    expect(material.playerActionFacts[0]).toMatchObject({ actorPlayerId: self, availableAtTick: 1404, source: "DEMO" });
    expect(material.playerActionFacts[0].text).toContain("本人开火");
    const cue = bundle.review_plan.cues.find(c => c.candidate_id === candidate.candidateId)!;
    expect(cue.assessment?.kind).toBe("INSUFFICIENT_EVIDENCE");
    const narration = deterministicNarrationBundle(buildCoachingPackage(cue, bundle.candidate_set, bundle.observation_evidence), buildOutcomePackage(cue, bundle.candidate_set));
    expect(narration.playerAction.refs).toContain(material.playerActionFacts[0].id);
  });
  it.each(["absent", "other", "unknown"])("does not invent fire from %s actor evidence", mode => {
    const bundle = analyzeFire(fireReplay("DEATH", mode === "absent" ? [] : [shot(1404, mode === "other" ? "other" : null)]));
    expect(bundle.candidate_set.materials.flatMap(m => m.playerActionFacts)).toEqual([]);
  });
});

it.each([1400, 1408, 1409, 999, 1801, 1404.5, NaN, Infinity])("excludes shot time %s outside the strict processing interval", time => {
  const bundle = analyzeFire(fireReplay("DEATH", [shot(time)]));
  expect(bundle.candidate_set.materials.flatMap(m => m.playerActionFacts)).toEqual([]);
});

it("keeps identity, route selection, assessment and decision facts unchanged when adding fire", () => {
  // Mask identity rather than deleting events, so original parser event references remain stable.
  const withFire = analyzeFire(fireReplay("DEATH", [shot(1404)]));
  const without = analyzeFire(fireReplay("DEATH", [shot(1404, null)]));
  const signature = (bundle: ReturnType<typeof analyzeFire>) => ({
    candidates: bundle.candidate_set.candidates.map(c => ({ id: c.candidateId, decision: c.decisionTick, reveal: c.revealTick, outcome: c.outcomeEnd, assessment: c.assessment, score: c.deterministicScore, facts: c.factRefs })),
    route: bundle.review_plan.cues.map(c => ({ candidate: c.candidate_id, decision: c.decision_tick, assessment: c.assessment })),
  });
  expect(signature(withFire)).toEqual(signature(without));
  expect(withFire.candidate_set.materials[0].playerActionFacts[0]).toMatchObject({ presentationOnly: true, evidenceRefs: ["cs2d-r1-event-1"] });
  expect(withFire.candidate_set.materials[0].playerActionFacts[0].decisionAction).toBeUndefined();
});

it("bounds aggregate references without claiming a hit count and survives history round-trip", () => {
  const bundle = analyzeFire(fireReplay("DEATH", [shot(1401), shot(1402), shot(1403), shot(1404), shot(1405)]));
  const facts = bundle.candidate_set.materials.find(m => m.playerActionFacts.length)?.playerActionFacts!;
  expect(facts).toHaveLength(1);
  expect(facts[0].evidenceRefs).toHaveLength(3);
  expect(facts[0].availableAtTick).toBe(1403);
  expect(facts[0].limitations.join(" ")).toContain("不代表完整开火次数");
  expect(facts[0].text).not.toMatch(/命中|再次|探身|目标|\d/);
  expect(deserializeCs2dAnalysisBundle(serializeCs2dAnalysisBundle(bundle)).candidate_set).toEqual(bundle.candidate_set);
  const legacy = analyzeFire(fireReplay("DEATH", [shot(1404, null)]));
  expect(deserializeCs2dAnalysisBundle(serializeCs2dAnalysisBundle(legacy))).toEqual(legacy);
});

it("does not promote a later overlapping candidate just because it gained presentation-only fire", () => {
  const make = (actor: string | null) => {
    const replay = fireReplay("HP_CHANGE", [shot(1412, actor)]);
    return { ...replay, rounds: replay.rounds.map(round => ({ ...round, frames: round.frames.map(frame => ({ ...frame, players: frame.players.map(p => ({ ...p, health: frame.tick < 1408 ? 40 : frame.tick < 1416 ? 25 : 10 })) })) })) };
  };
  const baseline = analyzeFire(make(null));
  const enriched = analyzeFire(make(self));
  expect(enriched.candidate_set.materials.some(m => m.playerActionFacts.length > 0)).toBe(true);
  expect(enriched.review_plan.cues.map(c => c.candidate_id)).toEqual(baseline.review_plan.cues.map(c => c.candidate_id));
  expect(enriched.review_plan.cues[0].decision_tick).toBe(1400);
});

it("does not duplicate an existing BOMB action with a window-fire presentation", () => {
  const replay = fireReplay("HP_CHANGE", [shot(1404)]);
  const round = replay.rounds[0];
  const bundle = analyzeFire({ ...replay, rounds: [{ ...round, frames: round.frames.map(frame => ({ ...frame, players: frame.players.map(p => ({ ...p, health: 40 })) })), events: [...round.events, { type: "bomb_planted", tick: 1408, t: 0, playerSteamId: self }] }] });
  const candidate = bundle.candidate_set.candidates.find(c => c.source.kind === "BOMB")!;
  const material = bundle.candidate_set.materials.find(m => m.candidateId === candidate.candidateId)!;
  expect(material.playerActionFacts).toHaveLength(1);
  expect(material.playerActionFacts[0].presentationOnly).toBeUndefined();
});

import { describe, expect, it } from "vitest";
import type { DecisionSnapshot, ObservableState } from "@cs-coach/contracts";
import { buildCoachingPackage, buildOutcomePackage, deterministicNarrationBundle } from "@cs-coach/review-planner";
import { assertDecisionSnapshot, buildDecisionSnapshot, buildObservableDecisionContext } from "./decision-context";
import { buildCs2dAnalysisBundle, deserializeCs2dAnalysisBundle, serializeCs2dAnalysisBundle, type Cs2dReplay, type Cs2dRound } from "./index";
import { decisionSelfHurtEvents, selfHurtEvents, selfHurtFactText, type Cs2dHurtEvent } from "./self-hurt";

// Entirely synthetic regression data: these integers are not measurements from a parsed Demo.
const roster = Array.from({ length: 10 }, (_, i) => `synthetic-p${i}`);
const self = roster[0]!;
const hurt = (id: string, tick: number, patch: Partial<Cs2dHurtEvent> = {}): Cs2dHurtEvent => ({ id, tick, victimSteamId: self, ...patch });
function fixture(hurtEvents?: readonly Cs2dHurtEvent[]): Cs2dRound {
  return {
    number: 1, freezeStartTick: 1000, startTick: 1064, decidedTick: 1900,
    endTick: 1950, postEndTick: 2000, winner: "T", scoreT: 0, scoreCt: 0,
    ...(hurtEvents === undefined ? {} : { hurtEvents }),
    frames: Array.from({ length: 113 }, (_, i) => {
      const tick = 1064 + i * 8;
      return { tick, t: (tick - 1000) / 64, players: roster.map((steamId, p) => ({
        steamId, side: p < 5 ? "T" as const : "CT" as const,
        alive: p === 0 || p >= 5, health: p === 0 ? tick < 1408 ? 100 : 70 : p < 5 ? 0 : 100,
        armor: 100, helmet: true, weapon: "ak47", grenades: [], money: 1000, equipValue: 3700,
        x: p * 100, y: 0, z: 0, yaw: 0,
      })) };
    }),
    events: [{ type: "bomb_planted", tick: 1536, t: 8.375, playerSteamId: self }],
    grenadePaths: [],
  };
}
function snapshot(round = fixture(), decisionTick = 1528) {
  return buildDecisionSnapshot({ round, selectedPlayerId: self, decisionTick, tickRate: 64,
    snapshotId: "synthetic-hurt-snapshot", rosterIds: roster });
}
function bundle(round: Cs2dRound) {
  const replay: Cs2dReplay = { map: "de_mirage", demoTickRate: 64, frameRate: 8,
    generatedBy: "synthetic-test+cs-coach.hurt-events.v1",
    players: roster.map((steamId, i) => ({ steamId, name: steamId, startSide: i < 5 ? "T" : "CT" })), rounds: [round] };
  return buildCs2dAnalysisBundle({ replay, selectedSteamId: self, demoId: "synthetic-hurt-regression" });
}
function context(value: DecisionSnapshot) {
  const state: ObservableState = { id: "synthetic-observation", demo_id: "synthetic", timeline_version: "test",
    observer_player_id: self, at_tick: value.decisionTick, observation_version: "test", claims: [], limitations: [] };
  return buildObservableDecisionContext(value, state);
}

describe("self hurt facts at the decision boundary", () => {
  it("uses only strictly prior self events, without requiring or inspecting an attacker", () => {
    const unknownAttacker = Object.defineProperty(hurt("unknown-attacker", 1526), "attackerSteamId", {
      get() { throw new Error("attacker identity must not be read"); },
    });
    const round = fixture([hurt("other", 1520, { victimSteamId: roster[1]! }),
      hurt("unknown-victim", 1520, { victimSteamId: null }), unknownAttacker,
      hurt("before", 1527), hurt("same", 1528), hurt("after", 1529)]);
    expect(snapshot(round).selfHurtEvents).toEqual([
      { source: "DEMO_PLAYER_HURT", sourceRef: "before", tick: 1527 },
      { source: "DEMO_PLAYER_HURT", sourceRef: "unknown-attacker", tick: 1526 },
    ]);
    expect(context(snapshot(round)).publicFacts.filter(text => text === selfHurtFactText())).toHaveLength(1);
  });

  it("retains occurrence evidence when damage fields and attacker fields are absent", () => {
    // The raw contract intentionally cannot distinguish self/world/unknown-attacker causes.
    const round = fixture([hurt("synthetic-self-damage", 1525), hurt("synthetic-world-damage", 1526),
      hurt("synthetic-zero-report", 1527, { reportedHealthDamage: 0, reportedArmorDamage: null })]);
    expect(snapshot(round).selfHurtEvents).toHaveLength(3);
    for (const item of snapshot(round).selfHurtEvents!) expect(Object.keys(item).sort()).toEqual(["source", "sourceRef", "tick"]);
    expect(context(snapshot(round)).publicFacts.filter(text => text.includes("本人受击"))).toEqual([selfHurtFactText()]);
  });

  it("does not transform overkill, remaining health or armor reports into HP-loss knowledge", () => {
    const round = fixture([hurt("raw-reports", 1527, { reportedHealthDamage: 777, reportedArmorDamage: 91,
      reportedHealthAfter: 4, reportedArmorAfter: 9 })]);
    const json = JSON.stringify({ snapshot: snapshot(round), context: context(snapshot(round)) });
    expect(json).not.toMatch(/reportedHealth|reportedArmor|777|attackerSteamId|damageDirection/);
    expect(snapshot(round).selectedPlayer.value?.health).toBe(70);
    expect(snapshot(round).selfHurtEvents).toEqual([{ source: "DEMO_PLAYER_HURT", sourceRef: "raw-reports", tick: 1527 }]);
  });

  it("keeps the latest three unique events in an inclusive ten-second lookback", () => {
    const round = { ...fixture(), freezeStartTick: 0, hurtEvents: [hurt("too-old", 887), hurt("boundary", 888),
      hurt("second", 900), hurt("third", 901), hurt("fourth", 902), hurt("fourth", 903)] };
    expect(decisionSelfHurtEvents(round, self, 1528, 64, true).map(item => item.sourceRef)).toEqual(["fourth", "third", "second"]);
    expect(decisionSelfHurtEvents({ ...round, hurtEvents: round.hurtEvents.slice(0, 2) }, self, 1528, 64, true))
      .toEqual([{ source: "DEMO_PLAYER_HURT", sourceRef: "boundary", tick: 888 }]);
    for (const rate of [0, -1, NaN, Infinity]) expect(decisionSelfHurtEvents(round, self, 1528, rate, true)).toEqual([]);
  });

  it("rejects invalid identity/ticks and preserves separate equal-tick events", () => {
    const round = fixture([hurt("", 1520), hurt(" ", 1520), hurt("x".repeat(161), 1520), hurt("fractional", 1520.5),
      hurt("nan", NaN), hurt("negative", -1), hurt("previous-round", 999),
      hurt("a", 1521), hurt("a", 1522), hurt("b", 1521)]);
    expect(selfHurtEvents(round, self).map(item => item.id)).toEqual(["a", "b"]);
  });

  it("uses the round container half-open boundary, independently of the result cutoff", () => {
    const round = fixture([hurt("before-round", 999), hurt("round-start", 1000),
      hurt("official-end", 1950), hurt("last-container-tick", 1999), hurt("next-round", 2000), hurt("beyond", 2001)]);
    expect(selfHurtEvents(round, self).map(item => item.id)).toEqual(["round-start", "official-end", "last-container-tick"]);
  });

  it("requires a fresh live selected player and excludes known fatal reports", () => {
    const round = fixture([hurt("prior", 1520), hurt("fatal", 1521, { reportedHealthAfter: 0 })]);
    expect(snapshot(round).selfHurtEvents?.map(item => item.sourceRef)).toEqual(["prior"]);
    const frame = round.frames.find(item => item.tick === 1528)!;
    expect(snapshot({ ...round, frames: [{ ...frame, tick: 1495 }] }).selfHurtEvents).toEqual([]);
    expect(snapshot({ ...round, frames: [{ ...frame, tick: 1496 }] }).selfHurtEvents).toHaveLength(1);
    for (const alive of [false, undefined]) {
      const frames = [{ ...frame, players: frame.players.map(p => p.steamId === self ? { ...p, alive } : p) }] as unknown as Cs2dRound["frames"];
      expect(snapshot({ ...round, frames }).selfHurtEvents).toEqual([]);
    }
    expect(snapshot({ ...round, frames: [] }).selfHurtEvents).toEqual([]);
  });

  it("never uses a pre-death live frame to revive decision evidence at or after death", () => {
    const round = fixture([hurt("before", 1526), hurt("fatal-tick", 1528), hurt("after-death", 1529)]);
    const dead: Cs2dRound = { ...round, events: [{ type: "kill", tick: 1528, t: 8.25,
      attackerSteamId: roster[5]!, victimSteamId: self, assisterSteamId: null, assistedFlash: false,
      weapon: "ak47", headshot: false, x: 0, y: 0, z: 0 }] };
    expect(snapshot(dead, 1527).selfHurtEvents?.map(item => item.sourceRef)).toEqual(["before"]);
    for (const tick of [1528, 1529, 1536]) expect(snapshot(dead, tick).selfHurtEvents).toEqual([]);
    expect(selfHurtEvents(dead, self).map(item => item.id)).toEqual(["before", "fatal-tick"]);
  });

  it("does not revise decision evidence when only future hurt reports or outcomes change", () => {
    const round = fixture([hurt("prior", 1500)]);
    const changed: Cs2dRound = { ...round, winner: "CT", hurtEvents: [...round.hurtEvents!,
      hurt("same-tick", 1528, { reportedHealthDamage: 777 }),
      hurt("future-fatal", 1529, { reportedHealthAfter: 0 })], events: [...round.events,
      { type: "kill", tick: 1530, t: 8.28, attackerSteamId: roster[5]!, victimSteamId: self,
        assisterSteamId: null, assistedFlash: false, weapon: "awp", headshot: true, x: 999, y: 999, z: 999 }] };
    expect(snapshot(changed)).toEqual(snapshot(round));
    expect(context(snapshot(changed))).toEqual(context(snapshot(round)));
  });

  it("distinguishes old absent streams from a present empty stream", () => {
    const old = snapshot(fixture());
    expect(old).not.toHaveProperty("selfHurtEvents");
    expect(old.missingFields).toContain("self_hurt_events");
    expect(snapshot(fixture([])).selfHurtEvents).toEqual([]);
    expect(snapshot(fixture([])).missingFields).not.toContain("self_hurt_events");
    expect(() => assertDecisionSnapshot(JSON.parse(JSON.stringify(old)))).not.toThrow();
  });

  it("rejects persisted extra fields, future evidence, duplicates, excess events and dead consumers", () => {
    const base = snapshot(fixture([hurt("prior", 1527)]));
    const entry = base.selfHurtEvents![0]!;
    for (const entries of [[{ ...entry, tick: 1528 }], [{ ...entry, tick: -1 }], [{ ...entry, sourceRef: "" }],
      [entry, entry], Array.from({ length: 4 }, (_, i) => ({ ...entry, sourceRef: `h${i}` })),
      [{ ...entry, reportedHealthDamage: 777 }], [{ ...entry, attackerSteamId: "hidden-attacker" }]]) {
      expect(() => assertDecisionSnapshot({ ...base, selfHurtEvents: entries } as DecisionSnapshot)).toThrow();
    }
    expect(() => assertDecisionSnapshot({ ...base, selectedPlayer: { ...base.selectedPlayer,
      value: { ...base.selectedPlayer.value!, alive: false } } })).toThrow(/live/);
  });
});

describe("self hurt analysis and narration integration", () => {
  it("round-trips exact occurrence IDs into real coaching and outcome packages without raw reports", () => {
    const source = fixture([hurt("covered-health-step", 1401), hurt("prior-decision", 1500, { reportedHealthDamage: 777 }),
      hurt("after-decision-before-reveal", 1535), hurt("at-reveal", 1536), hurt("at-outcome-end", 1792), hurt("past-outcome-end", 1793)]);
    const built = bundle(source);
    const restored = deserializeCs2dAnalysisBundle(serializeCs2dAnalysisBundle(built));
    expect(restored).toEqual(built);
    const candidate = restored.candidate_set.candidates.find(item => item.source.kind === "BOMB")!;
    expect(candidate).toBeDefined();
    expect(candidate.decisionTick).toBe(1528);
    const material = restored.candidate_set.materials.find(item => item.candidateId === candidate.candidateId)!;
    expect(material.decisionSnapshot?.selfHurtEvents?.map(item => item.sourceRef)).toEqual(["prior-decision", "covered-health-step"]);
    const hurtOutcomes = material.outcomeFacts.filter(item => item.evidenceRefs.includes("at-reveal"));
    expect(hurtOutcomes).toHaveLength(1);
    expect(hurtOutcomes[0]!.evidenceRefs).toEqual(["at-reveal", "at-outcome-end"]);
    const cue = restored.review_plan.cues.find(item => item.candidate_id === candidate.candidateId)!;
    expect(cue).toBeDefined();
    const coaching = buildCoachingPackage(cue, restored.candidate_set, restored.observation_evidence);
    const outcome = buildOutcomePackage(cue, restored.candidate_set);
    const narration = deterministicNarrationBundle(coaching, outcome);
    expect(coaching.decisionContext.facts.filter(item => item.text === selfHurtFactText())).toHaveLength(1);
    expect(narration.currentSituation.text).toContain("本人受击");
    expect(outcome.outcomeFacts.some(item => item.evidenceRefs.includes("at-reveal"))).toBe(true);
    expect(JSON.stringify({ coaching, outcome, narration })).not.toMatch(/reportedHealth|reportedArmor|777|attackerSteamId/);
    expect(restored.match_timeline.match_events?.filter(item => item.source_parser_event === "cs2d:player_hurt").map(item => item.id))
      .toEqual(source.hurtEvents!.map(item => item.id));
    for (const event of restored.match_timeline.match_events!.filter(item => item.source_parser_event === "cs2d:player_hurt")) {
      expect(event.event_type).toBe("DAMAGE");
      expect(event.payload).toEqual({ source: "cs2d-player-hurt", occurrence_only: true });
      expect(event).not.toHaveProperty("actor_player_id");
      expect(event.missing_fields).toContain("actual_hp_loss");
    }
    expect(restored.match_timeline.match_events?.filter(item => item.source_parser_event === "cs2d:frame-health-step")).toEqual([]);
    const old = bundle(fixture());
    expect(restored.candidate_set.candidates.filter(item => item.source.kind === "HP_CHANGE").map(item => item.source.refs))
      .toEqual(old.candidate_set.candidates.filter(item => item.source.kind === "HP_CHANGE").map(item => item.source.refs));
    expect(deserializeCs2dAnalysisBundle(serializeCs2dAnalysisBundle(old))).toEqual(old);
    expect(old.candidate_set.materials.every(item => item.decisionSnapshot?.selfHurtEvents === undefined)).toBe(true);
    expect(old.match_timeline.match_events?.some(item => item.source_parser_event === "cs2d:frame-health-step")).toBe(true);
  });

  it("keeps the existing result window while enforcing the round container end", () => {
    const round = { ...fixture([hurt("at-official-end", 1600), hurt("last-container-tick", 1663), hurt("outside-container", 1664)]),
      decidedTick: 1599, endTick: 1600, postEndTick: 1664 };
    const built = bundle(round);
    const candidate = built.candidate_set.candidates.find(item => item.source.kind === "BOMB")!;
    const material = built.candidate_set.materials.find(item => item.candidateId === candidate.candidateId)!;
    const outcome = material.outcomeFacts.find(item => item.evidenceRefs.includes("at-official-end"))!;
    expect(candidate.outcomeEnd).toBe(1664);
    expect(outcome.evidenceRefs).toEqual(["at-official-end", "last-container-tick"]);
    expect(outcome.availableAtTick).toBe(1663);
    expect(built.match_timeline.match_events?.filter(item => item.source_parser_event === "cs2d:player_hurt").map(item => item.id))
      .toEqual(["at-official-end", "last-container-tick"]);
  });
});

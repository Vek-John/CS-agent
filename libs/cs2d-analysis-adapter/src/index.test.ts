import type { Cs2dReplay, Cs2dAnalysisBundle } from "./index";
import { describe, expect, it } from "vitest";
import {
  CS2D_SOURCE,
  buildCs2dAnalysisBundle,
  deserializeCs2dAnalysisBundle,
  serializeCs2dAnalysisBundle
} from "./index";
import { createCoachingSession, reduceCoachingSession } from "@cs-coach/session";
import type { WinProbabilityTimelineV1 } from "@cs-coach/contracts";
import { stableFingerprint } from "@cs-coach/review-planner";

function player(steamId: string, side: "T" | "CT", index: number) {
  return {
    steamId,
    name: `Player ${index + 1}`,
    startSide: side
  } as const;
}

function state(steamId: string, tick: number, health: number, x = 100 + tick / 10) {
  return {
    steamId,
    x,
    y: 200 + tick / 10,
    z: 64,
    yaw: 90,
    health,
    alive: health > 0,
    side: steamId.startsWith("p-t") ? "T" as const : "CT" as const,
    weapon: "AK-47",
    lastPlaceName: "Connector",
    money: 3200,
    equipValue: 4500,
    armor: 100,
    helmet: true,
    grenades: ["Smoke"]
  };
}

function replayFixture(): Cs2dReplay {
  const players = Array.from({ length: 10 }, (_, index) =>
    player(index < 5 ? `p-t${index + 1}` : `p-ct${index - 4}`, index < 5 ? "T" : "CT", index)
  );
  const selected = "p-t1";
  const replay: Cs2dReplay = {
    map: "de_mirage",
    demoTickRate: 64,
    frameRate: 8,
    players,
    rounds: [
      {
        number: 1,
        freezeStartTick: 0,
        startTick: 64,
        decidedTick: 640,
        endTick: 700,
        postEndTick: 760,
        winner: "T",
        scoreCt: 0,
        scoreT: 0,
        damage: { [selected]: 30 },
        frames: [
          { tick: 64, t: 1, players: [state(selected, 64, 100)] },
          { tick: 160, t: 2.5, players: [state(selected, 160, 100)] },
          { tick: 256, t: 4, players: [state(selected, 256, 70)] },
          { tick: 352, t: 5.5, players: [state(selected, 352, 70)] },
          { tick: 448, t: 7, players: [state(selected, 448, 100)] },
          { tick: 544, t: 8.5, players: [state(selected, 544, 100)] }
        ],
        events: [
          {
            type: "kill",
            tick: 224,
            t: 3.5,
            attackerSteamId: "p-t1",
            victimSteamId: "p-ct1",
            assisterSteamId: null,
            assistedFlash: false,
            weapon: "AK-47",
            headshot: false,
            x: 500,
            y: 300,
            z: 64
          },
          {
            type: "bomb_planted",
            tick: 480,
            t: 7.5,
            playerSteamId: "p-t1"
          },
          {
            type: "shot",
            tick: 300,
            t: 4.7,
            x: 120,
            y: 220,
            yaw: 90
          }
        ],
        grenadePaths: [
          {
            kind: "smoke",
            throwerSteamId: "p-t1",
            points: [
              { t: 5.8, x: 100, y: 200 },
              { t: 6.2, x: 160, y: 240 },
              { t: 6.7, x: 220, y: 260 }
            ]
          }
        ]
      },
      {
        number: 2,
        freezeStartTick: 800,
        startTick: 864,
        decidedTick: 1500,
        endTick: 1560,
        postEndTick: 1620,
        winner: "CT",
        scoreCt: 0,
        scoreT: 1,
        frames: [
          { tick: 864, t: 1, players: [state(selected, 864, 100)] },
          { tick: 960, t: 2.5, players: [state(selected, 960, 100)] },
          { tick: 1056, t: 4, players: [state(selected, 1056, 60)] },
          { tick: 1152, t: 5.5, players: [state(selected, 1152, 60)] }
        ],
        events: [
          {
            type: "kill",
            tick: 1024,
            t: 3.5,
            attackerSteamId: "p-ct1",
            victimSteamId: "p-t1",
            assisterSteamId: null,
            assistedFlash: false,
            weapon: "AWP",
            headshot: false,
            x: 700,
            y: 400,
            z: 64
          }
        ],
        grenadePaths: []
      }
    ]
  };
  // A complete ten-player decision scene: the selected player is the only survivor
  // on their side. This supplies real reflection value without inventing a mistake.
  return { ...replay, rounds: replay.rounds.map((round) => ({ ...round,
    frames: round.frames.map((frame) => ({ ...frame, players: [
      ...frame.players,
      ...players.filter((player) => player.steamId !== selected).map((player) => state(player.steamId, frame.tick, player.startSide === "T" ? 0 : 100))
    ] }))
  })) };
}

function negativeSelectedSideTimeline(tick: number, roundNumber = 1): WinProbabilityTimelineV1 {
  return {
    version: "win-probability-timeline.v1",
    status: "AVAILABLE",
    model: {
      provider: "CS_NET",
      revision: "fixture-negative-kill",
      assetUrl: "/models/fixture.onnx",
      assetSha256: "a".repeat(64),
      assetBytes: 1,
      quantization: "INT8",
      temperature: 1,
      sourceCommit: "fixture",
      featureVersion: "fixture"
    },
    tickRate: 64,
    rounds: [{
      roundNumber,
      startTick: 0,
      endTick: 760,
      winner: "T",
      economy: { ct: "FULL", t: "FULL", ctValue: 20_000, tValue: 20_000 },
      samples: [
        { tick: Math.max(64, tick - 1), probability: 0.3, roundNumber, side: "CT", source: "CS_NET" },
        { tick, probability: 0.6, roundNumber, side: "CT", source: "CS_NET" }
      ]
    }],
    swings: [{
      id: `negative-kill-${roundNumber}-${tick}`,
      tick,
      before: 0.3,
      after: 0.6,
      delta: 0.3,
      direction: "UP",
      cause: "PLAYER_DEATH",
      selectedPlayerDeath: false,
      victimSide: "CT",
      economy: "FULL"
    }],
    limitations: []
  };
}

function rehashBoundaryFixture(bundle: Cs2dAnalysisBundle): Cs2dAnalysisBundle {
  const set = bundle.candidate_set;
  const hash = stableFingerprint({ id: set.id, version: set.version, demoId: set.demoId, playerId: set.playerId,
    status: set.status, failureReason: set.failureReason, generationManifest: set.generationManifest,
    candidates: set.candidates, materials: set.materials, limitations: set.limitations });
  return { ...bundle, candidate_set: { ...set, hash }, review_plan: { ...bundle.review_plan, candidate_set_hash: hash,
    ...(bundle.review_plan.director_decision_set ? { director_decision_set: { ...bundle.review_plan.director_decision_set, candidateSetHash: hash } } : {}) } };
}

describe("cs2d analysis adapter", () => {
  it.each([
    [undefined, ""],
    ["cs2-demo-parser-wasm@0.0.0+cs-coach.hurt-events.v1", "/hurt-events.v1"],
    ["cs2-demo-parser-wasm@0.0.0+cs-coach.hurt-events.v1.shot-identity.v2", "/hurt-events.v1/shot-identity.v2"],
    ["cs2-demo-parser-wasm@0.0.0+cs-coach.hurt-events.v1.shot-identity.v2.ammo-clip.v2", "/hurt-events.v1/shot-identity.v2/ammo-clip.v2"],
    ["cs2-demo-parser-wasm@0.0.0+cs-coach.hurt-events.v1.shot-identity.v2.ammo-clip.v2.bomb-identity.v1", "/hurt-events.v1/shot-identity.v2/ammo-clip.v2/bomb-identity.v1"],
    ["cs2-demo-parser-wasm@0.0.0+cs-coach.hurt-events.v1.shot-identity.v2.ammo-clip.v2.bomb-identity.v1.death-identity.v1", "/hurt-events.v1/shot-identity.v2/ammo-clip.v2/bomb-identity.v1/death-identity.v1"],
    ["unknown+cs-coach.hurt-events.v1.shot-identity.v2.ammo-clip.v3", ""]
  ] as const)("preserves independent parser provenance for %s", (generatedBy, suffix) => {
    const bundle = buildCs2dAnalysisBundle({ replay: { ...replayFixture(), generatedBy }, selectedSteamId: "p-t1", demoId: "parser-provenance" });
    const version = bundle.review_plan.generation_manifest.parser_version;
    expect(version).toBe(`zenojunior/cs2d@dbbe698c9b9c91f9a14cecea92374b4114bf60ec${suffix}`);
    expect(deserializeCs2dAnalysisBundle(serializeCs2dAnalysisBundle(bundle)).review_plan.generation_manifest.parser_version).toBe(version);
  });

  it.each(["bomb_planted", "bomb_defused", "bomb_exploded"] as const)("keeps unknown %s actors out of personal action evidence", (type) => {
    const source = replayFixture();
    const replayWithActor = (playerSteamId: string | null): Cs2dReplay => ({ ...source, rounds: [{
      ...source.rounds[0], grenadePaths: [],
      frames: source.rounds[0].frames.map(frame => ({ ...frame, players: frame.players.map(p => ({ ...p, health: 100, alive: true })) })),
      events: [{ type, tick: 480, t: 7.5, playerSteamId }]
    }] });
    for (const actor of [null, "p-ct1", "p-t1"]) {
      const bundle = buildCs2dAnalysisBundle({ replay: replayWithActor(actor), selectedSteamId: "p-t1", demoId: "bomb-identity-fixture" });
      const personal = bundle.match_timeline.match_events?.filter(event => ["BOMB_PLANT", "BOMB_DEFUSE"].includes(event.event_type)) ?? [];
      expect(personal).toHaveLength(actor === "p-t1" && type !== "bomb_exploded" ? 1 : 0);
      const actions = bundle.candidate_set.materials.flatMap(material => material.playerActionFacts);
      if (actor !== "p-t1" || type === "bomb_exploded") expect(actions).toHaveLength(0);
      else expect(actions.length).toBeGreaterThan(0);
      expect(bundle.match_timeline.rounds).toHaveLength(1);
      expect(deserializeCs2dAnalysisBundle(serializeCs2dAnalysisBundle(bundle)).match_timeline.match_events).toEqual(bundle.match_timeline.match_events);
    }
  });

  it("keeps unknown killers out of own kills while retaining the known victim death", () => {
    const source = replayFixture();
    const kill = source.rounds[0].events.find(event => event.type === "kill");
    if (!kill || kill.type !== "kill") throw new Error("Missing kill fixture");
    for (const attackerSteamId of [null, "p-t1", "p-ct2"]) {
      const replay: Cs2dReplay = { ...source, rounds: [{ ...source.rounds[0], grenadePaths: [],
        frames: source.rounds[0].frames.map(frame => ({ ...frame, players: frame.players.map(p => ({ ...p, health: 100, alive: true })) })),
        events: [{ ...kill, attackerSteamId, assisterSteamId: null }]
      }] };
      const actor = buildCs2dAnalysisBundle({ replay, selectedSteamId: "p-t1", demoId: "death-identity-fixture", winProbabilityTimeline: negativeSelectedSideTimeline(kill.tick) });
      const victim = buildCs2dAnalysisBundle({ replay, selectedSteamId: "p-ct1", demoId: "death-identity-fixture" });
      const ownKills = actor.match_timeline.match_events?.filter(event => event.source_parser_event === "cs2d:kill") ?? [];
      expect(ownKills).toHaveLength(attackerSteamId === "p-t1" ? 1 : 0);
      const deaths = victim.match_timeline.match_events?.filter(event => event.event_type === "PLAYER_DEATH") ?? [];
      expect(deaths).toHaveLength(1);
      expect(deaths[0].target_player_id).toBe("p-ct1");
      expect(deaths[0].actor_player_id).toBe(attackerSteamId ?? undefined);
      const ownKillFacts = actor.candidate_set.materials.flatMap(material => material.outcomeFacts).filter(fact => fact.text === "你随后完成击杀。");
      expect(ownKillFacts).toHaveLength(attackerSteamId === "p-t1" ? 1 : 0);
      expect(deserializeCs2dAnalysisBundle(serializeCs2dAnalysisBundle(victim)).match_timeline.match_events).toEqual(victim.match_timeline.match_events);
    }
  });

  it("records the pinned structured-input boundary and supports every player selection", () => {
    const replay = replayFixture();
    expect(CS2D_SOURCE.commit).toBe("dbbe698c9b9c91f9a14cecea92374b4114bf60ec");
    const plans = replay.players.map((candidate) =>
      buildCs2dAnalysisBundle({ replay, selectedSteamId: candidate.steamId, demoId: "demo-fixture" }).review_plan
    );
    expect(plans).toHaveLength(10);
    expect(new Set(plans.map((plan) => plan.player_id)).size).toBe(10);
    expect(plans.every((plan) => plan.generation_manifest.analysis_subject_selection === "EXPLICIT_PLAYER")).toBe(true);
    expect(plans[0].cues.length).toBeGreaterThan(plans[1].cues.length);
  });

  it("keeps OutcomeImpact signed and gated to the parsed cue window", () => {
    const replay = replayFixture();
    const baseline = buildCs2dAnalysisBundle({ replay, selectedSteamId: "p-t1", demoId: "impact-fixture" });
    const cue = baseline.review_plan.cues.find((cue) => cue.decision_tick >= 800)!;
    const timeline: WinProbabilityTimelineV1 = {
      version: "win-probability-timeline.v1",
      status: "AVAILABLE",
      model: {
        provider: "CS_NET",
        revision: "fixture",
        assetUrl: "/models/cs-net/win-rate.int8.onnx",
        assetSha256: "a".repeat(64),
        assetBytes: 1,
        quantization: "INT8",
        temperature: 1.0613423585891724,
        sourceCommit: "fixture",
        featureVersion: "fixture"
      },
      tickRate: 64,
      rounds: [{
        roundNumber: 2,
        startTick: 800,
        endTick: 1620,
        winner: "T",
        economy: { ct: "FULL", t: "FORCE", ctValue: 20_000, tValue: 12_500 },
        samples: [
          { tick: cue.decision_tick, probability: 0.31, roundNumber: 2, side: "CT", source: "CS_NET" },
          { tick: cue.reveal_tick, probability: 0.62, roundNumber: 2, side: "CT", source: "CS_NET" }
        ]
      }],
      swings: [{
        id: "fixture-swing",
        tick: cue.reveal_tick,
        before: 0.31,
        after: 0.62,
        delta: 0.31,
        direction: "UP",
        cause: "PLAYER_DEATH",
        selectedPlayerDeath: true,
        victimSide: "T",
        economy: "FORCE"
      }],
      limitations: []
    };
    const bundle = buildCs2dAnalysisBundle({
      replay,
      selectedSteamId: "p-t1",
      demoId: "impact-fixture",
      winProbabilityTimeline: timeline
    });
    const impact = bundle.outcome_impacts.find((candidate) => candidate.cueId === cue.id);
    expect(impact).toMatchObject({
      beforeProbability: 0.69,
      afterProbability: 0.38,
      delta: -0.31,
      percentagePoints: -31,
      attribution: "SELECTED_PLAYER_DEATH",
      confidence: "MEDIUM"
    });
    expect(impact?.text).toContain("少了 31 个百分点");
    expect(impact?.text).toContain("这段结果窗口后");
    expect(impact?.limitations.join(" ")).toContain("不能单独判断");
    expect(impact?.relativeChange).toBeCloseTo(-0.31 / 0.69);
  });

  it("uses canonical Round ticks and produces continuous, non-overlapping coverage", () => {
    const bundle = buildCs2dAnalysisBundle({ replay: replayFixture(), selectedSteamId: "p-t1", demoId: "demo-fixture" });
    expect(bundle.match_timeline.start_tick).toBe(0);
    expect(bundle.match_timeline.end_tick).toBe(1620);
    expect(bundle.match_timeline.rounds.map((round) => [round.start_tick, round.freeze_end_tick, round.end_tick])).toEqual([
      [0, 64, 760],
      [800, 864, 1620]
    ]);
    const segments = [...bundle.review_plan.segments].sort((a, b) => a.start_tick - b.start_tick);
    expect(segments[0].start_tick).toBe(0);
    expect(segments.at(-1)?.end_tick).toBe(1620);
    for (let index = 1; index < segments.length; index += 1) {
      expect(segments[index - 1].end_tick).toBe(segments[index].start_tick);
    }
    for (const cue of bundle.review_plan.cues) {
      const segment = bundle.review_plan.segments.find((candidate) => candidate.id === cue.segment_id);
      const round = bundle.match_timeline.rounds.find((candidate) => candidate.round_number === segment?.round_number);
      expect(segment).toBeDefined();
      expect(round).toBeDefined();
      expect(segment?.start_tick).toBe(Math.max(round!.freeze_end_tick, cue.decision_tick - 64));
      expect(segment?.start_tick).toBeLessThanOrEqual(cue.decision_tick);
    }
    expect(segments.some((segment) => segment.reason_code === "FREEZE_TIME")).toBe(true);
    expect(segments.some((segment) => segment.reason_code === "INTER_ROUND_GAP")).toBe(true);
  });

  it("clamps one second of pre-roll to the live boundary without moving decision evidence", () => {
    const replay = replayFixture();
    const events = replay.rounds[0].events.map((event, index) =>
      index === 0 ? { ...event, tick: 80, t: 1.25, attackerSteamId: "p-ct1", victimSteamId: "p-t1" } : event
    );
    const bundle = buildCs2dAnalysisBundle({
      replay: { ...replay, rounds: [{ ...replay.rounds[0], events }, replay.rounds[1]] },
      selectedSteamId: "p-t1",
      demoId: "early-live-cue",
      winProbabilityTimeline: negativeSelectedSideTimeline(80)
    });
    const cue = bundle.review_plan.cues.find((candidate) => candidate.decision_tick === 64);
    expect(cue).toBeDefined();
    const segment = bundle.review_plan.segments.find((candidate) => candidate.id === cue!.segment_id);
    expect(segment?.start_tick).toBe(64);
    expect(cue?.outcome_start_tick).toBe(64);
    expect(cue?.facts
      .filter((fact) => fact.availability === "DECISION")
      .every((fact) => fact.available_at_tick <= cue.decision_tick)).toBe(true);

    let session = createCoachingSession(bundle.review_plan, "early-cue-session");
    session = reduceCoachingSession(bundle.review_plan, session, { type: "START" });
    expect(session).toMatchObject({ phase: "PLAYING", current_tick: 64 });
  });

  it("paces a full match to at most 50 teaching stops and spreads them across the timeline", () => {
    const base = replayFixture();
    const source = base.rounds[0];
    const rounds = Array.from({ length: 60 }, (_, index) => {
      const offset = index * 1_000;
      return {
        ...source,
        number: index + 1,
        freezeStartTick: source.freezeStartTick + offset,
        startTick: source.startTick + offset,
        decidedTick: source.decidedTick + offset,
        endTick: source.endTick + offset,
        postEndTick: source.postEndTick + offset,
        scoreT: index,
        frames: source.frames.map((frame) => ({ ...frame, tick: frame.tick + offset })),
        events: source.events.map((event) => ({ ...event, tick: event.tick + offset })),
      };
    });
    const bundle = buildCs2dAnalysisBundle({
      replay: { ...base, rounds },
      selectedSteamId: "p-t1",
      demoId: "paced-full-match"
    });
    expect(bundle.review_plan.cues.length).toBeGreaterThan(0);
    expect(bundle.review_plan.cues.length).toBeLessThanOrEqual(50);
    expect(bundle.review_plan.segments.some((segment) => segment.mode === "SKIP")).toBe(true);
    expect(bundle.review_plan.cues[0].decision_tick).toBeLessThan(1_000);
    expect(bundle.review_plan.segments.at(-1)?.end_tick).toBe(59_760);
    expect(bundle.review_plan.segments.some((segment) => segment.start_tick >= 59_000)).toBe(true);
    expect(bundle.review_plan.cues.every((cue) => cue.assessment?.kind === "INSUFFICIENT_EVIDENCE")).toBe(true);
  });

  it("derives actionable coaching context only from the decision-time player state", () => {
    const replay = replayFixture();
    const frames = replay.rounds[0].frames.map((frame) => ({
      ...frame,
      players: frame.players.map((current) => frame.tick <= 448
        ? { ...current, weapon: "Smoke", grenades: ["Smoke", "Flash"] }
        : current)
    }));
    const bundle = buildCs2dAnalysisBundle({
      replay: { ...replay, rounds: [{ ...replay.rounds[0], frames }, replay.rounds[1]] },
      selectedSteamId: "p-t1",
      demoId: "decision-context"
    });
    expect(bundle.review_plan.cues[0].assessment?.kind).toBe("INSUFFICIENT_EVIDENCE");
    expect(bundle.review_plan.cues[0].advice).toEqual([]);
    expect(bundle.review_plan.cues[0].facts[0].text).toContain("你在连接");
    expect(bundle.review_plan.cues[0].facts[0].text).toContain("有 2 颗道具");
    expect(bundle.review_plan.cues[0].question).not.toMatch(/被击杀|随后|最终/);
  });

  it("uses concrete Mirage callouts and player-facing CS actions", () => {
    const replay = replayFixture();
    const frames = replay.rounds[0].frames.map((frame) => ({
      ...frame,
      players: frame.players.map((current) => frame.tick <= 448
        ? {
            ...current,
            lastPlaceName: "Catwalk",
            weapon: "AK-47",
            money: 1_200,
            equipValue: 1_500,
            armor: 0,
            helmet: false,
            grenades: []
          }
        : current)
    }));
    const bundle = buildCs2dAnalysisBundle({
      replay: { ...replay, rounds: [{ ...replay.rounds[0], frames }, replay.rounds[1]] },
      selectedSteamId: "p-t1",
      demoId: "player-language"
    });
    const cue = bundle.review_plan.cues[0];
    const copy = JSON.stringify({ title: cue.title, question: cue.question, facts: cue.facts, advice: cue.advice });
    expect(copy).toMatch(/B小/);
    expect(copy).toMatch(/没甲/);
    expect(copy).toMatch(/证据不足|无法确认/);
    expect(cue.advice).toEqual([]);
    expect(copy).not.toMatch(/让.*队友.*先|跟.*补枪|贪枪|主动接战|留在.*枪线/);
    expect(copy).not.toMatch(/空间控制|资源关系|风险暴露|决策窗口|接空间/);
  });

  it("keeps freeze skips compatible with Session auto-consumption", () => {
    const bundle = buildCs2dAnalysisBundle({ replay: replayFixture(), selectedSteamId: "p-t1", demoId: "demo-fixture" });
    const session = createCoachingSession(bundle.review_plan, "session-cs2d");
    const started = reduceCoachingSession(bundle.review_plan, session, { type: "START" });
    expect(started.user_events[1]).toMatchObject({ type: "SEGMENT_SKIPPED", detail: "AUTO_FREEZE_TIME" });
    expect(started.current_tick).toBe(64);
  });

  it("keeps decision evidence before reveal and excludes outcome details from decision facts", () => {
    const bundle = buildCs2dAnalysisBundle({ replay: replayFixture(), selectedSteamId: "p-t1", demoId: "demo-fixture" });
    expect(bundle.review_plan.cues.length).toBeGreaterThan(0);
    for (const cue of bundle.review_plan.cues) {
      expect(cue.decision_tick).toBeLessThan(cue.reveal_tick);
      expect(cue.outcome_start_tick).toBe(cue.decision_tick);
      expect(cue.outcome_start_tick).toBeLessThan(cue.reveal_tick);
      const outcomeFacts = cue.facts.filter((fact) => fact.availability === "OUTCOME");
      expect(outcomeFacts).toHaveLength(1);
      for (const fact of outcomeFacts) {
        expect(fact.available_at_tick).toBeGreaterThanOrEqual(cue.reveal_tick);
        expect(cue.observable_fact_refs).not.toContain(fact.id);
      }
      for (const fact of cue.facts) {
        if (fact.availability === "DECISION") {
          expect(fact.text).not.toMatch(/被击杀|死亡|结果|随后|最终/);
        }
        if (cue.observable_fact_refs.includes(fact.id)) {
          expect(fact.availability).toBe("DECISION");
          expect(fact.available_at_tick).toBeLessThanOrEqual(cue.decision_tick);
        }
      }
      expect(cue.question).not.toMatch(/被击杀|死亡|随后|最终/);
      expect(JSON.stringify({
        title: cue.title,
        question: cue.question,
        limitations: cue.limitations,
        reason: bundle.review_plan.segments.find((segment) => segment.id === cue.segment_id)?.reason_code
      })).not.toMatch(/SIGNAL_|KILL|DEATH|BOMB|UTILITY|HP_CHANGE|取得优势|击杀|阵亡/i);
      expect(cue.annotations.every((annotation) => annotation.coordinate_space === "WORLD")).toBe(true);
    }
    expect(bundle.observation_evidence.every((state) => state.at_tick <= (bundle.review_plan.cues.find((cue) => cue.observable_state_id === state.id)?.decision_tick ?? Number.MAX_SAFE_INTEGER))).toBe(true);
  });

  it("uses conservative outcome wording for each supported signal kind", () => {
    const replay = replayFixture();
    const sourceRound = replay.rounds[0];
    const quietRound = {
      ...sourceRound,
      events: [],
      grenadePaths: [],
      frames: sourceRound.frames.map((frame) => ({
        ...frame,
        players: frame.players.map((current) => ({
          ...current,
          health: 100,
          alive: true
        }))
      }))
    };
    const outcomeFactFor = (round: Cs2dReplay["rounds"][number], winProbabilityTimeline?: WinProbabilityTimelineV1) => {
      const bundle = buildCs2dAnalysisBundle({
        replay: { ...replay, rounds: [round, replay.rounds[1]] },
        selectedSteamId: "p-t1",
        demoId: "outcome-fact-kind",
        winProbabilityTimeline
      });
      return bundle.candidate_set.materials.flatMap((material) => material.outcomeFacts)[0];
    };

    const sourceKill = sourceRound.events.find((event) => event.type === "kill");
    const sourceBomb = sourceRound.events.find((event) => event.type === "bomb_planted");
    if (!sourceKill || !sourceBomb) throw new Error("Outcome fixture events are incomplete.");
    const deathFact = outcomeFactFor({
      ...quietRound,
      events: [{ ...sourceKill, attackerSteamId: "p-ct1", victimSteamId: "p-t1" }]
    });
    const killFact = outcomeFactFor({
      ...quietRound,
      events: [{ ...sourceKill, attackerSteamId: "p-t1", victimSteamId: "p-ct1" }]
    }, negativeSelectedSideTimeline(sourceKill.tick));
    const bombFact = outcomeFactFor({ ...quietRound, events: [sourceBomb] });
    const utilityFact = outcomeFactFor({
      ...quietRound,
      grenadePaths: sourceRound.grenadePaths
    });
    const hpFact = outcomeFactFor({
      ...quietRound,
      frames: sourceRound.frames.map((frame) => ({
        ...frame,
        players: frame.players.map((current) => ({
          ...current,
          health: frame.tick < 256 ? 100 : 70,
          alive: true
        }))
      }))
    });

    expect(deathFact?.text).toBe("你随后被击杀。");
    expect(killFact?.text).toBe("你随后完成击杀。");
    expect(hpFact?.text).toBe("你的血量随后下降，伤害来源尚不能确认。");
    expect(utilityFact?.text).toBe("你随后投出了这颗烟雾弹。");
    expect(bombFact?.text).toBe("你随后完成下包。");
  });

  it("keeps decision-side cue content unchanged when a later frame changes", () => {
    const replay = replayFixture();
    const baseline = buildCs2dAnalysisBundle({ replay, selectedSteamId: "p-t1", demoId: "future-boundary" });
    const futureFrame = {
      tick: 600,
      t: 9.375,
      players: [{
        ...state("p-t1", 600, 100, 9_999),
        y: -9_999,
        weapon: "Knife",
        lastPlaceName: "CTSpawn"
      }]
    };
    const changed = buildCs2dAnalysisBundle({
      replay: {
        ...replay,
        rounds: [{ ...replay.rounds[0], frames: [...replay.rounds[0].frames, futureFrame] }, replay.rounds[1]]
      },
      selectedSteamId: "p-t1",
      demoId: "future-boundary"
    });

    expect(changed.review_plan.cues[0]).toEqual(baseline.review_plan.cues[0]);
    expect(changed.observation_evidence[0]).toEqual(baseline.observation_evidence[0]);
  });

  it("does not turn unattributed ShotEvent or aggregate damage into exact selected-player facts", () => {
    const bundle = buildCs2dAnalysisBundle({ replay: replayFixture(), selectedSteamId: "p-t1", demoId: "demo-fixture" });
    expect(bundle.metadata.warnings).toContain("缺少明确 shooterSteamId 的射击保持未归属；已归属射击也不能单独证明再次接触或重复探身。");
    expect(bundle.metadata.warnings).toContain("旧回放缺少逐次hurt流时，只能使用健康采样区间；事件报告伤害也不等于实际HP损失。");
    expect(bundle.metadata.warnings).toContain("GrenadePath.t is rounded to about 0.1s; utility cue boundaries use conservative canonical Frame ticks and never claim an exact throw or landing tick.");
    expect(bundle.match_timeline.match_events?.some((event) => event.event_type === "DAMAGE" && event.fact_confidence === 1)).toBe(false);
    const damage = bundle.match_timeline.match_events?.find((event) => event.event_type === "DAMAGE");
    expect(damage).toMatchObject({ target_player_id: "p-t1" });
    expect(damage?.actor_player_id).toBeUndefined();
  });

  it("excludes cs2d's non-official Round0 without renumbering or guessing a winner", () => {
    const replay = replayFixture();
    const round0 = {
      ...replay.rounds[0],
      number: 0,
      winner: null,
      freezeStartTick: -64,
      startTick: -32,
      decidedTick: -8,
      endTick: -4,
      postEndTick: 0,
      frames: [],
      events: [],
      grenadePaths: []
    } as const;
    const bundle = buildCs2dAnalysisBundle({
      replay: { ...replay, rounds: [round0, ...replay.rounds] },
      selectedSteamId: "p-t1",
      demoId: "round0-demo"
    });
    expect(bundle.match_timeline.rounds.map((round) => round.round_number)).toEqual([1, 2]);
    expect(bundle.metadata.excluded_rounds).toContainEqual(expect.objectContaining({
      source_round_number: 0,
      reason: "NON_OFFICIAL_ROUND_0"
    }));
    expect(bundle.metadata.raw_replay_retained_by_caller).toBe(true);
  });

  it("keeps post-round outcomes out of cue selection and marks the interval explicitly", () => {
    const replay = replayFixture();
    const postRoundKill = {
      type: "kill" as const,
      tick: 720,
      t: 11.25,
      attackerSteamId: "p-t1",
      victimSteamId: "p-ct2",
      assisterSteamId: null,
      assistedFlash: false,
      weapon: "AK-47",
      headshot: false,
      x: 500,
      y: 300,
      z: 64
    };
    const bundle = buildCs2dAnalysisBundle({
      replay: {
        ...replay,
        rounds: [{ ...replay.rounds[0], events: [...replay.rounds[0].events, postRoundKill] }, replay.rounds[1]]
      },
      selectedSteamId: "p-t1",
      demoId: "post-round-demo"
    });
    expect(bundle.review_plan.cues.some((cue) => cue.reveal_tick === 720)).toBe(false);
    expect(bundle.match_timeline.match_events?.some((event) => event.tick === 720)).toBe(false);
    expect(bundle.review_plan.segments).toContainEqual(expect.objectContaining({
      start_tick: 736,
      end_tick: 760,
      reason_code: "POST_ROUND",
      mode: "SKIP"
    }));
  });

  it("keeps one second of legal post-event context for a round-ending death", () => {
    const replay = replayFixture();
    const endingKill = {
      type: "kill" as const,
      tick: 640,
      t: 10,
      attackerSteamId: "p-ct2",
      victimSteamId: "p-t1",
      assisterSteamId: null,
      assistedFlash: false,
      weapon: "AK-47",
      headshot: false,
      x: 500,
      y: 300,
      z: 64
    };
    const quietFrames = replay.rounds[0].frames.map((frame) => ({
      ...frame,
      players: frame.players.map((current) => ({ ...current, health: current.steamId === "p-t1" ? 2 : current.health, alive: current.alive }))
    }));
    const bundle = buildCs2dAnalysisBundle({
      replay: {
        ...replay,
      rounds: [
        { ...replay.rounds[0], frames: quietFrames, events: [endingKill], grenadePaths: [] },
        replay.rounds[1]
      ]
      },
      selectedSteamId: "p-t1",
      demoId: "round-ending-kill",
      winProbabilityTimeline: negativeSelectedSideTimeline(endingKill.tick)
    });
    const cue = bundle.review_plan.cues.find((candidate) => candidate.reveal_tick === endingKill.tick);

    expect(cue).toBeDefined();
    expect(cue!.outcome_end_tick).toBeGreaterThanOrEqual(endingKill.tick + replay.demoTickRate);
    const cueSegment = bundle.review_plan.segments.find((segment) => segment.id === cue!.segment_id);
    expect(cueSegment?.end_tick).toBe(cue!.outcome_end_tick);

    const segments = [...bundle.review_plan.segments].sort((left, right) => left.start_tick - right.start_tick);
    for (let index = 1; index < segments.length; index += 1) {
      expect(segments[index - 1].end_tick).toBe(segments[index].start_tick);
    }
    const postRound = segments.find((segment) => segment.reason_code === "POST_ROUND");
    expect(postRound === undefined || postRound.start_tick >= cue!.outcome_end_tick).toBe(true);
  });

  it("does not create teaching cues from reactions after the round is decided", () => {
    const replay = replayFixture();
    const reactionKill = {
      type: "kill" as const,
      tick: 660,
      t: 10.3,
      attackerSteamId: "p-t1",
      victimSteamId: "p-ct2",
      assisterSteamId: null,
      assistedFlash: false,
      weapon: "AK-47",
      headshot: false,
      x: 500,
      y: 300,
      z: 64
    };
    const bundle = buildCs2dAnalysisBundle({
      replay: {
        ...replay,
        rounds: [{ ...replay.rounds[0], events: [...replay.rounds[0].events, reactionKill] }, replay.rounds[1]]
      },
      selectedSteamId: "p-t1",
      demoId: "reaction-demo"
    });
    expect(bundle.review_plan.cues.some((cue) => cue.reveal_tick === 660)).toBe(false);
    expect(bundle.review_plan.segments).toContainEqual(expect.objectContaining({
      start_tick: 736,
      end_tick: 760,
      reason_code: "POST_ROUND"
    }));
  });

  it("uses [T, CT] score order and advances the winner", () => {
    const bundle = buildCs2dAnalysisBundle({ replay: replayFixture(), selectedSteamId: "p-t1", demoId: "score-demo" });
    expect(bundle.match_timeline.rounds.map((round) => ({ before: round.score_before, after: round.score_after }))).toEqual([
      { before: [0, 0], after: [1, 0] },
      { before: [1, 0], after: [1, 1] }
    ]);
  });

  it("rejects unsupported analysis maps instead of mislabeling them as Mirage", () => {
    expect(() => buildCs2dAnalysisBundle({
      replay: { ...replayFixture(), map: "de_nuke" },
      selectedSteamId: "p-t1",
      demoId: "nuke-demo"
    })).toThrow(/supports de_mirage only/);
  });

  it("deterministically downgrades sparse fields and preserves serialization", () => {
    const replay = replayFixture();
    const sparse: Cs2dReplay = {
      ...replay,
      rounds: [{
        ...replay.rounds[0],
        postEndTick: undefined as unknown as number,
        frames: [{ tick: 64, t: 1, players: [] }],
        events: [],
        grenadePaths: []
      }]
    };
    const first = buildCs2dAnalysisBundle({ replay: sparse, selectedSteamId: "p-t1", demoId: "sparse-demo" });
    const second = buildCs2dAnalysisBundle({ replay: sparse, selectedSteamId: "p-t1", demoId: "sparse-demo" });
    expect(first).toEqual(second);
    expect(first.metadata.warnings.some((warning) => warning.includes("postEndTick"))).toBe(true);
    const serialized = serializeCs2dAnalysisBundle(first);
    expect(deserializeCs2dAnalysisBundle(serialized)).toEqual(first);
    expect(serialized).not.toContain("grenadePaths");
    expect(serialized).not.toContain("raw Replay");
    const withRawReplay = { ...first, rawReplay: replay } as typeof first;
    const whitelisted = serializeCs2dAnalysisBundle(withRawReplay);
    expect(whitelisted).not.toContain("rawReplay");
    expect(() => deserializeCs2dAnalysisBundle(JSON.stringify({ ...first, rawReplay: replay }))).toThrow(/top-level/);
    const complete = buildCs2dAnalysisBundle({ replay, selectedSteamId: "p-t1", demoId: "complete-demo" });
    expect(() => deserializeCs2dAnalysisBundle(JSON.stringify({ ...complete, observation_evidence: [] }))).toThrow(/observable_state_id/);
  });

  it("roundtrips full candidate observations even when the provisional plan selects only a subset", () => {
    const source = replayFixture().rounds[1];
    const rounds = Array.from({ length: 10 }, (_, index) => {
      const shift = index * 1_000;
      return {
        ...source,
        number: index + 1,
        freezeStartTick: source.freezeStartTick + shift,
        startTick: source.startTick + shift,
        decidedTick: source.decidedTick + shift,
        endTick: source.endTick + shift,
        postEndTick: source.postEndTick + shift,
        scoreCt: index,
        scoreT: index,
        frames: source.frames.map((frame) => ({ ...frame, tick: frame.tick + shift, t: frame.t + shift / 64 })),
        events: source.events.map((event) => ({ ...event, tick: event.tick + shift, t: event.t + shift / 64 })),
        grenadePaths: []
      };
    });
    const bundle = buildCs2dAnalysisBundle({ replay: { ...replayFixture(), rounds }, selectedSteamId: "p-t1", demoId: "full-candidate-observation" });
    expect(bundle.candidate_set.candidates.length).toBeGreaterThan(bundle.review_plan.cues.length);
    const serialized = serializeCs2dAnalysisBundle(bundle);
    expect(deserializeCs2dAnalysisBundle(serialized)).toEqual(bundle);
  });

  it("rejects an observation state rebound to another candidate even when the tampered hash is recomputed", () => {
    const bundle = buildCs2dAnalysisBundle({ replay: replayFixture(), selectedSteamId: "p-t1", demoId: "wrong-candidate-observation" });
    expect(bundle.candidate_set.materials.length).toBeGreaterThan(1);
    const materials = [...bundle.candidate_set.materials];
    materials[0] = { ...materials[0], observableStateId: materials[1].observableStateId };
    const candidateSet = {
      ...bundle.candidate_set,
      materials,
      hash: stableFingerprint({
        id: bundle.candidate_set.id,
        version: bundle.candidate_set.version,
        demoId: bundle.candidate_set.demoId,
        playerId: bundle.candidate_set.playerId,
        status: bundle.candidate_set.status,
        failureReason: bundle.candidate_set.failureReason,
        generationManifest: bundle.candidate_set.generationManifest,
        candidates: bundle.candidate_set.candidates,
        materials,
        limitations: bundle.candidate_set.limitations
      })
    };
    const reviewPlan = {
      ...bundle.review_plan,
      candidate_set_hash: candidateSet.hash,
      director_decision_set: bundle.review_plan.director_decision_set
        ? { ...bundle.review_plan.director_decision_set, candidateSetHash: candidateSet.hash }
        : undefined
    };
    expect(() => deserializeCs2dAnalysisBundle(JSON.stringify({ ...bundle, candidate_set: candidateSet, review_plan: reviewPlan }))).toThrow(/not bound to its CandidateSet material/);
  });
  it("nominates independent model windows with exactly one compact preceding snapshot and no fabricated Demo action", () => {
    const source = replayFixture();
    const current = { ...source.rounds[0], events: [], grenadePaths: [], frames: source.rounds[0].frames.map((frame) => ({ ...frame, players: frame.players.map((player) => ({ ...player, health: player.steamId === "p-t1" ? 2 : player.health })) })) };
    const bundle = buildCs2dAnalysisBundle({ replay: { ...source, rounds: [current] }, selectedSteamId: "p-t1", demoId: "independent-snapshot", winProbabilityTimeline: negativeSelectedSideTimeline(400) });
    expect(bundle.candidate_set.candidates).toHaveLength(1);
    expect(bundle.candidate_set.candidates[0].source.kind).toBe("WIN_RATE_DROP");
    const material = bundle.candidate_set.materials[0];
    expect(material.decisionSnapshot?.decisionTick).toBe(352);
    expect(material.decisionSnapshot?.sampledAtTick).toBe(352);
    expect(material.playerActionFacts).toEqual([]);
    expect(material.outcomeFacts).toEqual([]);
    expect(deserializeCs2dAnalysisBundle(serializeCs2dAnalysisBundle(bundle))).toEqual(bundle);
  });

  it("reads existing 1.5.0 bundles without rewriting their snapshot refs or candidate hash", () => {
    const bundle = buildCs2dAnalysisBundle({ replay: replayFixture(), selectedSteamId: "p-t1", demoId: "legacy-public-refs" });
    const legacy = rehashBoundaryFixture({ ...bundle, metadata: { ...bundle.metadata, adapter_version: "cs2d-analysis-adapter/1.5.0" as const }, candidate_set: { ...bundle.candidate_set, materials: bundle.candidate_set.materials.map(material => ({ ...material, decisionSnapshot: { ...material.decisionSnapshot!, selectedPlayer: { ...material.decisionSnapshot!.selectedPlayer, evidenceRefs: ["legacy-raw-frame-source"] } } })) } });
    const restored = deserializeCs2dAnalysisBundle(JSON.stringify(legacy));
    expect(restored.candidate_set.hash).toBe(legacy.candidate_set.hash);
    expect(restored.candidate_set.materials[0]!.decisionSnapshot!.selectedPlayer.evidenceRefs).toEqual(["legacy-raw-frame-source"]);
  });

  it("exposes only explicitly attributed self weapon-fire facts without inferring contact or coordinate ownership", () => {
    const base = replayFixture();
    const baseline = buildCs2dAnalysisBundle({ replay: base, selectedSteamId: "p-t1", demoId: "shot-facts" });
    for (const actor of ["p-t1", "p-ct1", null, undefined]) {
      const replay = { ...base, rounds: base.rounds.map(round => ({ ...round, events: round.events.map(event => event.type === "shot" ? { ...event, shooterSteamId: actor } : event) })) };
      const bundle = buildCs2dAnalysisBundle({ replay, selectedSteamId: "p-t1", demoId: "shot-facts" });
      const shots = bundle.match_timeline.match_events!.filter(event => event.event_type === "WEAPON_FIRE");
      if (actor === "p-t1") {
        expect(shots.length).toBeGreaterThan(0);
        expect(shots.every(event => event.actor_player_id === "p-t1" && !event.target_player_id)).toBe(true);
        expect(JSON.stringify(shots)).not.toMatch(/"x"|"y"|"yaw"|world_position/);
      } else expect(shots).toEqual([]);
      expect(bundle.candidate_set.candidates.length).toBe(baseline.candidate_set.candidates.length);
      expect(bundle.candidate_set.materials.every(material => material.playerActionFacts.every(action => !action.decisionAction))).toBe(true);
      expect(deserializeCs2dAnalysisBundle(serializeCs2dAnalysisBundle(bundle))).toEqual(bundle);
    }
  });

  it("binds public live-player/count snapshot evidence to this candidate's pre-decision facts", () => {
    const bundle = buildCs2dAnalysisBundle({ replay: replayFixture(), selectedSteamId: "p-t1", demoId: "public-bindings" });
    for (const candidate of bundle.candidate_set.candidates) {
      const material = bundle.candidate_set.materials.find(item => item.candidateId === candidate.candidateId)!;
      const allowed = new Set(material.decisionFacts.filter(fact => fact.observed_by_player && fact.available_at_tick <= candidate.decisionTick).map(fact => fact.id));
      for (const value of [material.decisionSnapshot!.selectedPlayer, material.decisionSnapshot!.aliveCounts]) {
        if (!value.value) continue;
        expect(value.evidenceRefs.length).toBeGreaterThan(0);
        expect(value.evidenceRefs.every(ref => allowed.has(ref) && candidate.factRefs.includes(ref))).toBe(true);
      }
      expect(material.playerActionFacts.every(action => action.decisionAction === undefined)).toBe(true);
    }
    expect(deserializeCs2dAnalysisBundle(serializeCs2dAnalysisBundle(bundle))).toEqual(bundle);
  });

  it("fails explicitly above 512 candidate windows instead of truncating the match", () => {
    const source = replayFixture();
    const event = source.rounds[0].events.find((event) => event.type === "kill")!;
    const current = { ...source.rounds[0], events: Array.from({ length: 513 }, () => event), grenadePaths: [] };
    expect(() => buildCs2dAnalysisBundle({ replay: { ...source, rounds: [current] }, selectedSteamId: "p-t1", demoId: "too-many-windows" })).toThrow(/exceed 512.*without truncating/);
  });

  it("enforces the 16 MiB AnalysisBundle boundary on both export and import", () => {
    const bundle = buildCs2dAnalysisBundle({ replay: replayFixture(), selectedSteamId: "p-t1", demoId: "bounded-bundle" });
    const oversized = "x".repeat(16 * 1024 * 1024 + 1);
    expect(() => serializeCs2dAnalysisBundle({ ...bundle, metadata: { ...bundle.metadata, limitations: [oversized] } })).toThrow(/16 MiB/);
    expect(() => deserializeCs2dAnalysisBundle(oversized)).toThrow(/16 MiB/);
    expect(bundle.match_timeline.tracks).toHaveLength(1);
    expect(bundle.match_timeline.player_state_tracks?.every((state) => state.player_id === "p-t1")).toBe(true);
  });

  it("rejects partial trusted context in both new and legacy bundles even with a valid recomputed hash", () => {
    const bundle = buildCs2dAnalysisBundle({ replay: replayFixture(), selectedSteamId: "p-t1", demoId: "partial-context" });
    for (const adapterVersion of ["cs2d-analysis-adapter/1.5.2", "cs2d-analysis-adapter/1.5.1", "cs2d-analysis-adapter/1.5.0", "cs2d-analysis-adapter/1.4.0"] as const) {
      for (const missing of ["decisionSnapshot", "observableContext"] as const) {
        const materials = bundle.candidate_set.materials.map((material, index) => {
          if (index > 0) return material;
          const { [missing]: omitted, ...partial } = material;
          return partial;
        });
        const partial = rehashBoundaryFixture({ ...bundle, metadata: { ...bundle.metadata, adapter_version: adapterVersion }, candidate_set: { ...bundle.candidate_set, materials } });
        expect(() => deserializeCs2dAnalysisBundle(JSON.stringify(partial))).toThrow(/context is incomplete/);
      }
    }
  });

  it("only permits wholly absent context on legacy artifacts and preserves their immutable hash", () => {
    const bundle = buildCs2dAnalysisBundle({ replay: replayFixture(), selectedSteamId: "p-t1", demoId: "legacy-context" });
    const materials = bundle.candidate_set.materials.map(({ decisionSnapshot, observableContext, ...material }) => material);
    const cues = bundle.review_plan.cues.map(({ decisionSnapshot, observableContext, ...cue }) => cue);
    const withoutContext = rehashBoundaryFixture({ ...bundle, candidate_set: { ...bundle.candidate_set, materials }, review_plan: { ...bundle.review_plan, cues } });
    expect(() => deserializeCs2dAnalysisBundle(JSON.stringify(withoutContext))).toThrow(/context is incomplete/);
    const legacy = { ...withoutContext, metadata: { ...withoutContext.metadata, adapter_version: "cs2d-analysis-adapter/1.4.0" as const } };
    expect(deserializeCs2dAnalysisBundle(JSON.stringify(legacy))).toEqual(legacy);
  });

  it("revalidates cue-only public context even though the full snapshot lives in candidate material", () => {
    const bundle = buildCs2dAnalysisBundle({ replay: replayFixture(), selectedSteamId: "p-t1", demoId: "cue-context" });
    const cues = bundle.review_plan.cues.map((cue, index) => index === 0 ? { ...cue,
      observableContext: { ...cue.observableContext!, publicFacts: ["未来隐藏敌人将从 B 区出现。"] } } : cue);
    expect(cues[0].decisionSnapshot).toBeUndefined();
    expect(() => deserializeCs2dAnalysisBundle(JSON.stringify({ ...bundle, review_plan: { ...bundle.review_plan, cues } }))).toThrow(/Cue observable context differs/);
  });

  it("binds an explicit empty observable context when decision player samples are unavailable", () => {
    const replay = replayFixture();
    const sparse = { ...replay, rounds: [{ ...replay.rounds[1], frames: [] }] };
    const bundle = buildCs2dAnalysisBundle({ replay: sparse, selectedSteamId: "p-t1", demoId: "empty-observer-context" });
    expect(bundle.candidate_set.materials.length).toBeGreaterThan(0);
    for (const material of bundle.candidate_set.materials) {
      expect(material.decisionSnapshot?.selectedPlayer.value).toBeNull();
      expect(material.observableContext?.state.claims).toEqual([]);
      expect(material.observableStateId).toBe(material.observableContext?.state.id);
    }
    expect(deserializeCs2dAnalysisBundle(serializeCs2dAnalysisBundle(bundle))).toEqual(bundle);
  });

});

/** Synthetic self path regression, not a parsed Demo or expert judgment. */
function returnAndFireReplay(): Cs2dReplay {
  const base = replayFixture();
  return { ...base, rounds: [{ ...base.rounds[0]!, damage: {}, grenadePaths: [],
    frames: Array.from({ length: 49 }, (_, i) => {
      const tick = 64 + i * 8;
      return { tick, t: tick / 64, players: base.players.map(p => ({
        ...state(p.steamId, tick, ["p-t1", "p-t2", "p-t3", "p-ct1", "p-ct2"].includes(p.steamId) ? 100 : 0),
        x: p.steamId === "p-t1" ? i <= 8 ? i * 8 : Math.max(0, 128 - i * 8) : 5000,
        y: 0, z: 64
      })) };
    }),
    events: [64, 192].map(tick => ({ type: "shot" as const, shooterSteamId: "p-t1", tick, t: tick / 64, x: 99999, y: -99999, yaw: 0 }))
  }] };
}

describe("return-and-fire adapter boundary", () => {
  const buildReturn = (replay: Cs2dReplay) => buildCs2dAnalysisBundle({ replay, selectedSteamId: "p-t1", demoId: "synthetic-return-fire" });
  it("keeps an overlapping win-rate teaching window when shot attribution adds an experimental candidate", () => {
    const replay = returnAndFireReplay();
    const withoutAttribution = { ...replay, rounds: replay.rounds.map(round => ({
      ...round, events: round.events.map(event => event.type === "shot" ? { ...event, shooterSteamId: undefined } : event)
    })) };
    const build = (input: Cs2dReplay) => buildCs2dAnalysisBundle({
      replay: input, selectedSteamId: "p-t1", demoId: "synthetic-return-fire",
      winProbabilityTimeline: negativeSelectedSideTimeline(192)
    });
    const baseline = build(withoutAttribution);
    const attributed = build(replay);
    expect(baseline.review_plan.cues).toHaveLength(1);
    expect(attributed.candidate_set.candidates.some(candidate => candidate.source.kind === "RETURN_AND_FIRE")).toBe(true);
    expect(attributed.candidate_set.candidates.some(candidate => candidate.source.kind === "WIN_RATE_DROP")).toBe(true);
    expect(attributed.review_plan.cues).toEqual(baseline.review_plan.cues);
    expect(attributed.review_plan.segments).toEqual(baseline.review_plan.segments);
  });
  it("binds sampled self movement and explicit fire as an action, independently of outcome frames", () => {
    const before = buildReturn(returnAndFireReplay());
    const candidate = before.candidate_set.candidates.find(c => c.source.kind === "RETURN_AND_FIRE")!;
    expect(candidate).toBeDefined();
    const material = before.candidate_set.materials.find(m => m.candidateId === candidate.candidateId)!;
    expect(material.playerActionFacts).toHaveLength(1);
    expect(material.playerActionFacts[0]).toMatchObject({ actorPlayerId: "p-t1", availableAtTick: 192, decisionAction: { version: "decision-action.v1", kind: "RETURN_AND_FIRE", startTick: 128, endTick: 192, priorShotTick: 64, source: "SELF_MOVEMENT_FIRE_V1" } });
    expect(candidate.actionRefs).toEqual([material.playerActionFacts[0]!.id]);
    expect(material.outcomeFacts).toHaveLength(1);
    expect(material.outcomeFacts[0]).toMatchObject({ outcomeKind: "OTHER", availableAtTick: 448 });
    expect(material.outcomeFacts[0]!.text).toContain("存活、100 HP");
    const input = returnAndFireReplay();
    const after = buildReturn({ ...input, rounds: input.rounds.map(r => ({ ...r, winner: "CT", frames: r.frames.map(f => ({ ...f, players: f.players.map(p => f.tick > 192 ? { ...p, health: 0, alive: false } : p) })) })) });
    const changed = after.candidate_set.materials.find(m => m.candidateId === candidate.candidateId)!;
    expect(changed.playerActionFacts).toEqual(material.playerActionFacts);
    expect(changed.decisionFacts).toEqual(material.decisionFacts);
    expect(changed.observableContext).toEqual(material.observableContext);
    expect(changed.outcomeFacts[0]!.text).toContain("阵亡、0 HP");
    expect(serializeCs2dAnalysisBundle(before)).toContain("RETURN_AND_FIRE");
    expect(deserializeCs2dAnalysisBundle(serializeCs2dAnalysisBundle(before)).candidate_set.hash).toBe(before.candidate_set.hash);
  });
  it("does not nominate old, unknown or other-actor shots, even when tracer positions match", () => {
    for (const actor of [undefined, null, "p-t2"]) {
      const input = returnAndFireReplay();
      const bundle = buildReturn({ ...input, rounds: input.rounds.map(r => ({ ...r, events: r.events.map(e => e.type === "shot" ? { ...e, shooterSteamId: actor, x: 0, y: 0 } : e) })) });
      expect(bundle.candidate_set.candidates.some(c => c.source.kind === "RETURN_AND_FIRE")).toBe(false);
    }
  });
  it("preserves the action when no outcome sample exists instead of inventing an outcome", () => {
    const input = returnAndFireReplay();
    const bundle = buildReturn({ ...input, rounds: input.rounds.map(r => ({ ...r, frames: r.frames.filter(f => f.tick < 192) })) });
    const candidate = bundle.candidate_set.candidates.find(c => c.source.kind === "RETURN_AND_FIRE")!;
    const material = bundle.candidate_set.materials.find(m => m.candidateId === candidate.candidateId)!;
    expect(material.playerActionFacts[0]!.decisionAction?.kind).toBe("RETURN_AND_FIRE");
    expect(material.outcomeFacts).toEqual([]); expect(candidate.outcomeRefs).toEqual([]);
  });
  it("limits nomination to the public live-round phase", () => {
    const input = returnAndFireReplay();
    const bundle = buildReturn({ ...input, rounds: input.rounds.map(r => ({ ...r, decidedTick: 180 })) });
    expect(bundle.candidate_set.candidates.some(c => c.source.kind === "RETURN_AND_FIRE")).toBe(false);
  });
  it.each(["cs2d-analysis-adapter/1.5.2", "cs2d-analysis-adapter/1.6.0", "cs2d-analysis-adapter/1.6.1", "cs2d-analysis-adapter/1.7.0"] as const)("continues reading %s history without changing saved material", (version) => {
    const bundle = buildCs2dAnalysisBundle({ replay: replayFixture(), selectedSteamId: "p-t1", demoId: "old-1.5.2" });
    const old = { ...bundle, metadata: { ...bundle.metadata, adapter_version: version } };
    const restored = deserializeCs2dAnalysisBundle(JSON.stringify(old));
    expect(restored).toEqual(old); expect(restored.candidate_set.hash).toBe(old.candidate_set.hash);
  });
});

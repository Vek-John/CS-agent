import type { Cs2dReplay } from "./index";
import { describe, expect, it } from "vitest";
import {
  CS2D_SOURCE,
  buildCs2dAnalysisBundle,
  deserializeCs2dAnalysisBundle,
  serializeCs2dAnalysisBundle
} from "./index";
import { createCoachingSession, reduceCoachingSession } from "@cs-coach/session";

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
  return {
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
}

describe("cs2d analysis adapter", () => {
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
    expect(segments.some((segment) => segment.reason_code === "FREEZE_TIME")).toBe(true);
    expect(segments.some((segment) => segment.reason_code === "INTER_ROUND_GAP")).toBe(true);
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
      for (const fact of cue.facts) {
        if (cue.observable_fact_refs.includes(fact.id)) {
          expect(fact.availability).toBe("DECISION");
          expect(fact.available_at_tick).toBeLessThanOrEqual(cue.decision_tick);
        }
        expect(fact.text).not.toMatch(/被击杀|死亡|结果|随后|最终/);
      }
      expect(cue.question).not.toMatch(/被击杀|死亡|结果|随后|最终/);
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

  it("does not turn ShotEvent or aggregate damage into exact selected-player facts", () => {
    const bundle = buildCs2dAnalysisBundle({ replay: replayFixture(), selectedSteamId: "p-t1", demoId: "demo-fixture" });
    expect(bundle.metadata.warnings).toContain("cs2d ShotEvent 没有 shooterSteamId；适配层不把射击归因到任何玩家，等待 parser 扩展。");
    expect(bundle.metadata.warnings).toContain("当前 cs2d GameEvent 没有 HurtEvent；Round.damage 只有回合聚合，不能伪装成逐 tick 受击。");
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
      start_tick: 640,
      end_tick: 760,
      reason_code: "POST_ROUND",
      mode: "SKIP"
    }));
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
      start_tick: 640,
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
  });
});

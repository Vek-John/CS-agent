import { describe, expect, it } from "vitest";
import { createSyntheticMirageTimeline } from "@cs-coach/demo-domain";
import { createFixtureReviewPlan } from "@cs-coach/review-planner";
import { PLAYBACK_BRIDGE_CHANNEL, type ReviewPlan } from "@cs-coach/contracts";
import { createOutcomeCompletionGate, completeOutcomeGate } from "@cs-coach/session";
import {
  acceptedPlaybackEvent,
  canBeginManualCueVisit,
  cuePresentedActionForTerminal,
  analysisEventMatchesSelectedPlayer,
  adjacentRoundIndex,
  coachAgentEntryMode,
  coachingCueProgress,
  cs2dHostConfig,
  HOST_SPEED_OPTIONS,
  hostCoachingCueSurface,
  nearestCoachingCue,
  playbackCommandMessage,
  playbackPositionLabel,
  reviewPositionAtTick,
  reviewSegmentLabel,
  reviewSegmentTone,
  seekCanonicalBySeconds,
  teachingDiagnosticsEnabled,
  timelinePercent,
  timelineRange
} from "./cs2d-playback-host";

const event = {
  channel: PLAYBACK_BRIDGE_CHANNEL,
  direction: "event",
  payload: {
    type: "PLAYBACK_STATE",
    roundIndex: 0,
    canonicalTick: 640,
    playing: false,
    speed: 1
  }
} as const;

describe("cs2d localhost host boundary", () => {
  it("uses the full Coach Agent by default and keeps only Stage 2 as an explicit harness", () => {
    expect(coachAgentEntryMode("")).toBe("STAGE3");
    expect(coachAgentEntryMode("?coachAgent=stage3")).toBe("STAGE3");
    expect(coachAgentEntryMode("?coachAgent=off")).toBe("STAGE3");
    expect(coachAgentEntryMode("?coachAgent=stage2")).toBe("STAGE2");
  });

  it("keeps teaching diagnosis independently reversible", () => {
    expect(teachingDiagnosticsEnabled("", undefined)).toBe(true);
    expect(teachingDiagnosticsEnabled("?teachingDiagnostics=off", "on")).toBe(false);
    expect(teachingDiagnosticsEnabled("?teachingDiagnostics=on", "off")).toBe(true);
    expect(teachingDiagnosticsEnabled("", "false")).toBe(false);
  });

  it("filters stale analysis events by the current selected player", () => {
    expect(analysisEventMatchesSelectedPlayer("player-new", "player-old")).toBe(false);
    expect(analysisEventMatchesSelectedPlayer("player-new", "player-new")).toBe(true);
    expect(analysisEventMatchesSelectedPlayer(undefined, "player-new")).toBe(false);
  });

  it("selects the nearest frozen cue with a stable ahead-first tie break", () => {
    const plan = createFixtureReviewPlan(createSyntheticMirageTimeline());
    const first = plan.cues[0]!;
    const second = plan.cues[1]!;
    expect(nearestCoachingCue(plan, first.decision_tick)?.cue.id).toBe(first.id);
    expect(nearestCoachingCue(plan, (first.decision_tick + second.decision_tick) / 2)?.cue.id).toBe(second.id);
  });

  it("keeps PENDING manual cues inert and maps only matching terminals to CUE_PRESENTED", () => {
    expect(canBeginManualCueVisit("PENDING", true, false)).toBe(false);
    expect(canBeginManualCueVisit("READY", true, false)).toBe(true);
    expect(canBeginManualCueVisit("FALLBACK", true, false)).toBe(true);
    const base = { current_cue_id: "cue-4", presented_cue_ids: [] as string[] };
    expect(cuePresentedActionForTerminal(base, { status: "COMPLETED", source: "DEFAULT", cueId: "cue-4" }))
      .toEqual({ type: "CUE_PRESENTED", cueId: "cue-4" });
    expect(cuePresentedActionForTerminal({ ...base, manual_cue_visit: { visit_id: "visit-4", cue_id: "cue-4" } }, { status: "COMPLETED", source: "MANUAL", cueId: "cue-4", visitId: "visit-4" }))
      .toEqual({ type: "CUE_PRESENTED", cueId: "cue-4", visitId: "visit-4" });
    expect(cuePresentedActionForTerminal({ ...base, manual_cue_visit: { visit_id: "visit-4", cue_id: "cue-4" } }, { status: "COMPLETED", source: "MANUAL", cueId: "cue-4", visitId: "old-visit" }))
      .toBeUndefined();
  });

  it("keeps the Host coaching bands locked until the full outcome is paused", () => {
    const cue = createFixtureReviewPlan(createSyntheticMirageTimeline()).cues[0];

    expect(hostCoachingCueSurface(cue, "REVEALING", false)).toBeUndefined();
    expect(hostCoachingCueSurface(cue, "PAUSED_FOR_COACHING", false)).toBeUndefined();
    expect(hostCoachingCueSurface(cue, "PAUSED_FOR_COACHING", true)?.outcomeFacts.map((fact) => fact.id))
      .toEqual(["fact-r2-outcome"]);
  });

  it("does not synthesize a five-field body when the prepared bundle is absent", () => {
    const cue = createFixtureReviewPlan(createSyntheticMirageTimeline()).cues[0];
    const gate = completeOutcomeGate(createOutcomeCompletionGate(cue), cue.outcome_end_tick);
    expect(hostCoachingCueSurface(cue, "PAUSED_FOR_COACHING", gate)).toBeUndefined();
    const prepared = {
      cueId: cue.id,
      candidateId: "candidate-fixture",
      primaryFocusCode: "SURVIVE_CONTACT",
      currentSituation: { text: "情况", refs: ["fact-r2-4v3"] },
      playerAction: { text: "动作", refs: ["action-r2"] },
      coreIssue: { text: "问题", refs: ["fact-r2-4v3", "action-r2"] },
      betterPlay: { text: "建议", refs: ["advice-r2-reset"] },
      outcomeImpact: { text: "结果", refs: ["fact-r2-outcome"] }
    } as const;
    expect(hostCoachingCueSurface(cue, "PAUSED_FOR_COACHING", gate, prepared)?.narration).toEqual(prepared);
  });

  it("normalizes the host flag and origin", () => {
    expect(cs2dHostConfig("http://localhost:5174/path?x=1", "http://localhost:3000/review")).toEqual({
      url: "http://localhost:5174/path?x=1&host=1&parentOrigin=http%3A%2F%2Flocalhost%3A3000",
      origin: "http://localhost:5174"
    });
    expect(() => cs2dHostConfig("file:///tmp/index.html")).toThrow(/http/);
    expect(() => cs2dHostConfig(undefined, "file:///tmp/parent.html")).toThrow(/parent origin/);
    expect(() => cs2dHostConfig("https://replay.example.com/")).toThrow(/localhost/);
  });
  it("uses the same-origin Cloudflare viewer path in production", () => {
    expect(cs2dHostConfig(undefined, "https://coach.example.test/review", "cloudflare")).toEqual({
      url: "/cs2d/?host=1",
      origin: "https://coach.example.test"
    });
    expect(() => cs2dHostConfig("https://viewer.example.test/", "https://coach.example.test", "cloudflare"))
      .toThrow(/same-origin/);
  });
  it("accepts Wrangler's runtime deploy target", () => {
    const previousPublic = process.env.NEXT_PUBLIC_DEPLOY_TARGET;
    const previousRuntime = process.env.DEPLOY_TARGET;
    delete process.env.NEXT_PUBLIC_DEPLOY_TARGET;
    process.env.DEPLOY_TARGET = "cloudflare";
    try {
      expect(cs2dHostConfig(undefined, "https://coach.example.test/review")).toEqual({
        url: "/cs2d/?host=1",
        origin: "https://coach.example.test"
      });
    } finally {
      if (previousPublic === undefined) delete process.env.NEXT_PUBLIC_DEPLOY_TARGET;
      else process.env.NEXT_PUBLIC_DEPLOY_TARGET = previousPublic;
      if (previousRuntime === undefined) delete process.env.DEPLOY_TARGET;
      else process.env.DEPLOY_TARGET = previousRuntime;
    }
  });
  it("isolates the localhost viewer authority from the IPv4 app cookie host", () => {
    expect(cs2dHostConfig("http://localhost:51234/", "http://127.0.0.1:41234/desktop", "desktop")).toEqual({
      url: "http://localhost:51234/?host=1&parentOrigin=http%3A%2F%2F127.0.0.1%3A41234",
      origin: "http://localhost:51234"
    });
    const desktop = cs2dHostConfig("http://localhost:51234/", "http://127.0.0.1:41234", "desktop");
    expect(new URL(desktop.url).searchParams.get("parentOrigin")).toBe("http://127.0.0.1:41234");
    expect(desktop.url).not.toMatch(/token|cs_agent_runtime|session/i);
    expect(() => cs2dHostConfig(undefined, "http://127.0.0.1:41234", "desktop")).toThrow(/requires/);
    expect(() => cs2dHostConfig("http://127.0.0.1:51234/", "http://127.0.0.1:41234", "desktop")).toThrow(/localhost viewer/);
    expect(() => cs2dHostConfig("http://[::1]:51234/", "http://127.0.0.1:41234", "desktop")).toThrow(/localhost viewer/);
    expect(() => cs2dHostConfig("http://localhost:51234/", "http://[::1]:41234", "desktop")).toThrow(/IPv4 app/);
    expect(() => cs2dHostConfig("http://localhost:51234/cs2d", "http://127.0.0.1:41234", "desktop")).toThrow(/exact/);
  });
  it("requires both iframe source and exact origin", () => {
    expect(acceptedPlaybackEvent({ data: event, eventOrigin: "http://localhost:5174", expectedOrigin: "http://localhost:5174", sourceMatches: true })).toEqual(event);
    expect(acceptedPlaybackEvent({ data: event, eventOrigin: "http://127.0.0.1:5174", expectedOrigin: "http://localhost:5174", sourceMatches: true })).toBeUndefined();
    expect(acceptedPlaybackEvent({ data: event, eventOrigin: "http://localhost:5174", expectedOrigin: "http://localhost:5174", sourceMatches: false })).toBeUndefined();
    expect(acceptedPlaybackEvent({ data: event, eventOrigin: "http://evil.example", expectedOrigin: "http://127.0.0.1:51234", sourceMatches: true })).toBeUndefined();
    expect(playbackCommandMessage({ type: "play" })).toEqual({ channel: PLAYBACK_BRIDGE_CHANNEL, direction: "command", payload: { type: "play" } });
  });


  it("maps bridge position to round time without exposing canonical coordinates", () => {
    const replay = {
      type: "REPLAY_READY",
      schemaVersion: "cs2d-replay-ready.v1",
      map: "de_mirage",
      tickRate: 64,
      startCanonicalTick: 100,
      endCanonicalTick: 5000,
      roundCount: 2,
      rounds: [
        { roundIndex: 0, roundNumber: 1, startCanonicalTick: 100, endCanonicalTick: 2500 },
        { roundIndex: 1, roundNumber: 2, startCanonicalTick: 2600, endCanonicalTick: 5000 }
      ],
      players: [{ playerId: "p1", displayName: "Player", startSide: "T" }],
      freezeSkipped: true
    } as const;
    expect(playbackPositionLabel({ type: "PLAYBACK_STATE", roundIndex: 1, canonicalTick: 2920, playing: false, speed: 1 }, replay)).toBe("第 2 回合 · 0:05");
    expect(playbackPositionLabel(undefined, replay)).toBe("—");
  });
  it("maps a manual seek to the current round and ReviewPlan segment", () => {
    const replay = {
      type: "REPLAY_READY",
      schemaVersion: "cs2d-replay-ready.v1",
      map: "de_mirage",
      tickRate: 64,
      startCanonicalTick: 100,
      endCanonicalTick: 5000,
      roundCount: 2,
      rounds: [
        { roundIndex: 0, roundNumber: 1, startCanonicalTick: 100, endCanonicalTick: 2500 },
        { roundIndex: 1, roundNumber: 2, startCanonicalTick: 2600, endCanonicalTick: 5000 }
      ],
      players: [{ playerId: "p1", displayName: "Player", startSide: "T" }],
      freezeSkipped: true
    } as const;
    const plan = {
      id: "plan-1",
      segments: [{
        id: "segment-2", round_number: 2, start_tick: 2600, end_tick: 5000, mode: "WATCH",
        reason_code: "ORDINARY_PLAY", display_reason: "普通比赛内容", playback_speed: 1, cue_ids: [], expandable: false
      }],
      cues: [], habits: [], generated_at: "now", generation_manifest: {}
    } as never;
    const boundary = reviewPositionAtTick({ type: "PLAYBACK_STATE", roundIndex: 1, canonicalTick: 2500, playing: false, speed: 1 }, replay, plan);
    expect(boundary.roundLabel).toBe("比赛位置");
    const position = reviewPositionAtTick({ type: "PLAYBACK_STATE", roundIndex: 1, canonicalTick: 3000, playing: false, speed: 1 }, replay, plan);
    expect(position.roundLabel).toBe("第 2 回合");
    expect(position.segment?.display_reason).toBe("普通比赛内容");
  });

  it("sends compact command envelopes only", () => {
    const message = playbackCommandMessage({ type: "seekCanonicalTick", canonicalTick: 4096 });
    expect(message).toEqual({ channel: PLAYBACK_BRIDGE_CHANNEL, direction: "command", payload: { type: "seekCanonicalTick", canonicalTick: 4096 } });
    expect(JSON.stringify(message)).not.toMatch(/replay|frames|events/i);
  });

  it("maps ReviewPlan segments onto a bounded, player-facing timeline", () => {
    const segment = {
      id: "coach-1",
      round_number: 3,
      start_tick: 200,
      end_tick: 300,
      mode: "DEEP_DIVE",
      reason_code: "COACH_DECISION_POINT",
      display_reason: "关键接触前暂停",
      playback_speed: 1,
      cue_ids: ["cue-1"],
      expandable: false
    } satisfies ReviewPlan["segments"][number];

    expect(reviewSegmentTone(segment.mode)).toBe("coach");
    expect(reviewSegmentTone("HABIT_CHECK")).toBe("coach");
    expect(reviewSegmentTone("SKIP")).toBe("skip");
    expect(reviewSegmentTone("BRIEF")).toBe("neutral");
    expect(reviewSegmentLabel(segment)).toBe("深入讲解");
    expect(reviewSegmentLabel({ ...segment, mode: "SKIP" })).toBe("低价值片段");
    expect(timelinePercent(250, 100, 500)).toBe(37.5);
    expect(timelinePercent(-10, 0, 100)).toBe(0);
    expect(timelinePercent(120, 0, 100)).toBe(100);
    expect(timelinePercent(10, 10, 10)).toBe(0);
  });

  it("counts only routed coaching cues in the coach progress badge", () => {
    const fixture = createFixtureReviewPlan(createSyntheticMirageTimeline());
    const [firstCue, secondCue] = fixture.cues;
    const thirdCue = { ...secondCue, id: "cue-third" };
    const segment = fixture.segments[0];
    const plan = {
      ...fixture,
      cues: [firstCue, secondCue, thirdCue],
      segments: [
        { ...segment, id: "ordinary-1", mode: "BRIEF", cue_ids: [] },
        { ...segment, id: "coach-1", mode: "DEEP_DIVE", cue_ids: [firstCue.id] },
        { ...segment, id: "skip-1", mode: "SKIP", cue_ids: [] },
        { ...segment, id: "coach-2", mode: "HABIT_CHECK", cue_ids: [secondCue.id] },
        { ...segment, id: "coach-3", mode: "DEEP_DIVE", cue_ids: [thirdCue.id] },
      ]
    } satisfies ReviewPlan;

    expect(coachingCueProgress(plan, 0)).toEqual({ current: 1, total: 3 });
    expect(coachingCueProgress(plan, 1, firstCue.id)).toEqual({ current: 1, total: 3 });
    expect(coachingCueProgress(plan, 2)).toEqual({ current: 2, total: 3 });
    expect(coachingCueProgress(plan, 3, secondCue.id)).toEqual({ current: 2, total: 3 });
    expect(coachingCueProgress(plan, plan.segments.length)).toEqual({ current: 3, total: 3 });
  });

  it("maps round and segment durations to proportional timeline ranges", () => {
    expect(timelineRange(100, 300, 100, 900)).toEqual({ leftPercent: 0, widthPercent: 25 });
    expect(timelineRange(300, 700, 100, 900)).toEqual({ leftPercent: 25, widthPercent: 50 });
    expect(timelineRange(0, 1000, 100, 900)).toEqual({ leftPercent: 0, widthPercent: 100 });
  });

  it("clamps fifteen-second seeks to the parsed match bounds", () => {
    expect(seekCanonicalBySeconds(640, -15, 64, 100, 5000)).toBe(100);
    expect(seekCanonicalBySeconds(4900, 15, 64, 100, 5000)).toBe(5000);
    expect(seekCanonicalBySeconds(640, 15, 64, 100, 5000)).toBe(1600);
  });

  it("clamps adjacent round navigation without producing invalid indexes", () => {
    expect(adjacentRoundIndex(0, -1, 9)).toBe(0);
    expect(adjacentRoundIndex(8, 1, 9)).toBe(8);
    expect(adjacentRoundIndex(4, -1, 9)).toBe(3);
    expect(adjacentRoundIndex(0, 1, 0)).toBe(-1);
  });

  it("exposes the complete host speed scale", () => {
    expect(HOST_SPEED_OPTIONS).toEqual([0.25, 0.5, 1, 2, 4, 8]);
  });
});

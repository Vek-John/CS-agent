import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { MatchTimeline, ReviewPlan } from "@cs-coach/contracts";
import { describe, expect, it } from "vitest";
import { assertValidReviewPlan } from "./index";

interface GeneratedBundle {
  match_timeline: MatchTimeline;
  events: Array<{ id: string; tick: number }>;
  observable_states: Array<{
    at_tick: number;
    observer_player_id: string;
    claims: Array<{
      source_type: string;
      subject_ref?: string;
      subject_resolution: string;
      spatial_estimate: { type: string };
      available_from_tick: number;
      evidence_tick: number;
      expires_at_tick?: number;
    }>;
  }>;
  review_plan: ReviewPlan;
}

function readGeneratedBundle(): GeneratedBundle {
  const path = fileURLToPath(
    new URL("../../../apps/web/public/generated-data/test_demo.replay.json", import.meta.url)
  );
  return JSON.parse(readFileSync(path, "utf8")) as GeneratedBundle;
}

describe("generated parsed Demo ReviewPlan", () => {
  it("validates complete coverage and canonical decision/outcome boundaries", () => {
    const bundle = readGeneratedBundle();
    const plan = assertValidReviewPlan(bundle.match_timeline, bundle.review_plan);

    expect(plan.status).toBe("COMPLETE");
    expect(plan.cues.length).toBeGreaterThanOrEqual(4);
    expect(plan.habit_clusters.some((cluster) => cluster.cue_ids.length >= 2)).toBe(true);

    const sorted = [...plan.segments].sort((a, b) => a.start_tick - b.start_tick);
    expect(sorted[0]?.start_tick).toBe(bundle.match_timeline.start_tick);
    expect(sorted.at(-1)?.end_tick).toBe(bundle.match_timeline.end_tick);
    for (const [index, segment] of sorted.entries()) {
      expect(segment.start_tick).toBeGreaterThanOrEqual(bundle.match_timeline.start_tick);
      expect(segment.end_tick).toBeLessThanOrEqual(bundle.match_timeline.end_tick);
      if (index > 0) expect(sorted[index - 1]?.end_tick).toBe(segment.start_tick);
    }
    for (const cue of plan.cues) {
      expect(cue.decision_tick).toBeLessThan(cue.reveal_tick);
      expect(cue.outcome_start_tick).toBeGreaterThanOrEqual(cue.decision_tick);
      expect(cue.outcome_start_tick).toBeLessThan(cue.reveal_tick);
      expect(cue.reveal_tick).toBeLessThanOrEqual(cue.outcome_end_tick);
      expect(cue.outcome_start_tick).toBeLessThan(cue.outcome_end_tick);
      expect(cue.outcome_end_tick).toBeLessThanOrEqual(bundle.match_timeline.end_tick);
      expect(cue.annotations.every((annotation) => annotation.coordinate_space === "WORLD")).toBe(true);
      expect(cue.annotations.every((annotation) => !annotation.label.includes("结果区间"))).toBe(true);
    }

    const soundClaims = bundle.observable_states.flatMap((state) =>
      state.claims.filter((claim) => claim.source_type === "FOOTSTEP" || claim.source_type === "GUNSHOT")
    );
    for (const state of bundle.observable_states) {
      expect(state.at_tick).toBeGreaterThanOrEqual(bundle.match_timeline.start_tick);
      expect(state.at_tick).toBeLessThan(bundle.match_timeline.end_tick);
      for (const claim of state.claims) {
        expect(claim.available_from_tick).toBeLessThanOrEqual(state.at_tick);
        expect(claim.evidence_tick).toBeLessThanOrEqual(state.at_tick);
        if (claim.expires_at_tick !== undefined) {
          expect(claim.expires_at_tick).toBeGreaterThan(claim.available_from_tick);
          expect(state.at_tick).toBeLessThan(claim.expires_at_tick);
        }
      }
    }
    expect(soundClaims.length).toBeGreaterThan(0);
    for (const claim of soundClaims) {
      expect(claim.subject_resolution).toBe("UNKNOWN_ACTOR");
      expect(claim.subject_ref).toBeUndefined();
      expect(claim.spatial_estimate.type).not.toBe("EXACT_POINT");
      expect(claim.available_from_tick).toBeLessThanOrEqual(
        bundle.observable_states.find((state) => state.claims.includes(claim))?.at_tick ?? -1
      );
    }

    const outsideEventIds = new Set(
      bundle.events
        .filter(
          (event) =>
            event.tick < bundle.match_timeline.start_tick ||
            event.tick >= bundle.match_timeline.end_tick
        )
        .map((event) => event.id)
    );
    const planEvidenceRefs = new Set(
      plan.cues.flatMap((cue) => cue.evidence.flatMap((evidence) => evidence.fact_refs))
    );
    expect([...outsideEventIds].some((eventId) => planEvidenceRefs.has(eventId))).toBe(false);
  });
});

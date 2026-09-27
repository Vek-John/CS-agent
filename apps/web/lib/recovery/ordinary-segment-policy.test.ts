import { expect, it } from "vitest";
import { buildCs2dAnalysisBundle } from "@cs-coach/cs2d-analysis-adapter";
import { createCoachingSession, reduceCoachingSession } from "@cs-coach/session";
import { emptyCueViewerReplay, twoCueViewerPlayer } from "../../../../tools/cs2d-host/viewer-two-cue-fixture";
import { guidedPlaybackDirective } from "../coaching/cs2d-guided-session";
import { OrdinarySegmentRecoveryPolicy } from "./ordinary-segment-policy";

it("allows a real ordinary round only until its save is confirmed, with independent recovery ownership", () => {
  const plan = buildCs2dAnalysisBundle({ replay: emptyCueViewerReplay(), selectedSteamId: twoCueViewerPlayer, demoId: "policy", demoContentHash: "a".repeat(64) }).review_plan;
  const policy = new OrdinarySegmentRecoveryPolicy();
  let session = createCoachingSession(plan, "policy-session");
  expect(policy.eligible(plan, session, "A")).toBe(false);
  session = reduceCoachingSession(plan, session, { type: "START" });
  const rounds: number[] = [];
  for (let n = 0; n < plan.segments.length; n++) {
    const segment = plan.segments[session.current_segment_index];
    if (!segment) break;
    if (session.phase === "PLAYING") {
      expect(policy.eligible(plan, session, "A")).toBe(!rounds.includes(segment.round_number));
      if (!rounds.includes(segment.round_number)) {
        // An attempted but unconfirmed save must remain retryable.
        expect(policy.eligible(plan, session, "A")).toBe(true);
        policy.confirm(plan, session.current_segment_index, "A"); rounds.push(segment.round_number);
      }
      expect(policy.eligible(plan, session, "A")).toBe(false);
      expect(policy.eligible(plan, session, "B")).toBe(true);
    } else expect(policy.eligible(plan, session, "A")).toBe(false);
    const directive = guidedPlaybackDirective(plan, session);
    session = reduceCoachingSession(plan, session, directive.automaticAction ?? { type: "TICK", tick: segment.end_tick });
  }
  expect(rounds).toEqual([1, 2]);
});

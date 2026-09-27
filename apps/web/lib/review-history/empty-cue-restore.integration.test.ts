import { afterEach, expect, it } from "vitest";
import { getCurrentCue, reduceCoachingSession } from "@cs-coach/session";
import { emptyCueViewerReplay } from "../../../../tools/cs2d-host/viewer-two-cue-fixture";
import { guidedPlaybackDirective } from "../coaching/cs2d-guided-session";
import { cleanupRestoredHistoryFixture, withReopenedTeachingHistory } from "./teaching-history-restore-fixture";

afterEach(cleanupRestoredHistoryFixture);

it("reopens a zero-cue ROUTE_START through SQLite/GET and completes its recovered Session without regeneration", async () => {
  // Two-player synthetic rounds with complete tail samples; no Demo is parsed.
  await withReopenedTeachingHistory({ replay: emptyCueViewerReplay(), expectedCueCount: 0,
    verify: ({ analysis, normalized, recovered, savedNarration }) => {
      expect(analysis.candidate_set.candidates).toEqual([]);
      expect(normalized.candidate_set).toEqual(analysis.candidate_set);
      expect(recovered.plan).toEqual(analysis.review_plan);
      const plan = recovered.plan;
      expect(plan.cues).toEqual([]); expect(plan.segments).toHaveLength(7);
      expect(recovered.routeState.startable).toBe(true);
      expect(recovered.routeState.routeFrozen).toBe(true);
      expect(recovered.routeState.selectedCueCount).toBe(0);
      expect(recovered.routeState.cueOrder).toEqual([]);
      expect(savedNarration).toEqual({}); expect(recovered.narrationByCue).toEqual({});
      expect(recovered.session.phase).toBe("INTRO");
      const original = JSON.stringify(recovered);
      let session = reduceCoachingSession(plan, recovered.session, { type: "START" });
      const played: string[] = [];
      // Only playback reports are synthetic. All automatic skip/advance/finish
      // behavior comes from the actual directive and Session reducer.
      for (let i = 0; i < plan.segments.length && session.phase !== "WRAP_UP"; i++) {
        const index = session.current_segment_index, segment = plan.segments[index];
        expect(segment.cue_ids).toEqual([]); expect(getCurrentCue(plan, session)).toBeUndefined();
        played.push(segment.id);
        const directive = guidedPlaybackDirective(plan, session, normalized.match_timeline.tick_rate);
        if (directive.automaticAction) session = reduceCoachingSession(plan, session, directive.automaticAction);
        else {
          expect(directive.commands).toContainEqual({ type: "play" });
          session = reduceCoachingSession(plan, session, { type: "TICK", tick: segment.end_tick - 1 });
          expect(session.current_segment_index).toBe(index);
          session = reduceCoachingSession(plan, session, { type: "TICK", tick: segment.end_tick });
        }
      }
      const automaticallySkipped = session.user_events.filter(event => event.type === "SEGMENT_SKIPPED" && event.detail === "AUTO_FREEZE_TIME").map(event => event.segment_id);
      expect(new Set([...played, ...automaticallySkipped])).toEqual(new Set(plan.segments.map(segment => segment.id)));
      expect(session.phase).toBe("WRAP_UP");
      expect(session.current_tick).toBe(plan.segments.at(-1)!.end_tick);
      expect(guidedPlaybackDirective(plan, session).commands).toContainEqual({ type: "pause" });
      expect(session.presented_cue_ids).toEqual([]); expect(session.consumed_cue_ids).toEqual([]);
      session = reduceCoachingSession(plan, session, { type: "COMPLETE_SESSION" });
      expect(session.phase).toBe("COMPLETED");
      expect(session.id).toBe(recovered.session.id);
      expect(JSON.stringify(recovered)).toBe(original);
      // The shared fixture checks zero generation/transport and unchanged stored
      // artifacts/head AFTER this callback. Completion here is not a saved checkpoint.
    },
  });
}, 60_000);

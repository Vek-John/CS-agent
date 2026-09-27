import { afterEach, expect, it } from "vitest";
import { getCurrentCue, reduceCoachingSession } from "@cs-coach/session";
import type { Cs2dReplay } from "@cs-coach/cs2d-analysis-adapter";
import { fireReplay, self, shot } from "../../../../libs/cs2d-analysis-adapter/src/window-self-fire-fixtures";
import { buildCoachingCueView, buildThreeStageCoachingView, playerStateAtOrBefore } from "../coaching/cs2d-coaching-view";
import { CurrentCueResourceCache, getBaselineCueAmmo } from "../coaching/current-cue-resource-source";
import { answerGroundedCueQuestion, availableCurrentCueResourceQuestions, buildCurrentCueQuestionContext } from "../coaching/current-cue-questions";
import { cleanupRestoredHistoryFixture, withReopenedTeachingHistory } from "./teaching-history-restore-fixture";

afterEach(cleanupRestoredHistoryFixture);
const question = "弹匣当时还有几发？";
type Mode = "positive" | "zero" | "absent" | "latest-missing" | "same-tick-shot";
function replayFixture(mode: Mode): Cs2dReplay {
  // Small synthetic sample/event coordinates; the header-only managed fixture is never parsed.
  const raw = fireReplay("DEATH", mode === "same-tick-shot" ? [shot(1400), shot(1404)] : [shot(1404)]);
  return { ...raw, rounds: raw.rounds.map(round => ({ ...round, frames: round.frames.map(frame => ({ ...frame,
    players: frame.players.map(player => ({ ...player, weapon: "AK-47", activeWeaponHandle: 114697,
      ...(mode === "absent" ? {} : { ammoSamplingVersion: 2 as const,
        ...(mode === "latest-missing" && frame.tick === 1400 ? {} : { weaponAmmo: {
          source: "SOURCE2_ACTIVE_WEAPON" as const, phase: "TICK_END" as const, version: 2 as const,
          sampledAtTick: frame.tick - 1, weapon: "AK-47", weaponHandle: 114697, clip: mode === "zero" ? 0 : 7,
        } }),
      }),
    })),
  })) })) };
}

it.each(["positive", "zero", "absent", "latest-missing", "same-tick-shot"] as const)("reopens %s ammo via stored control-plane teaching and the recovered Session gate", async mode => {
  await withReopenedTeachingHistory({ replay: replayFixture(mode), verify: ({ analysis, normalized, recovered, savedNarration }) => {
    const plan = recovered.plan, cue = plan.cues[0];
    const originalMaterial = analysis.candidate_set.materials.find(item => item.candidateId === cue.candidate_id)!;
    const material = normalized.candidate_set.materials.find(item => item.candidateId === cue.candidate_id)!;
    expect(material).toEqual(originalMaterial);
    const state = playerStateAtOrBefore(normalized.match_timeline.player_state_tracks ?? [], self, cue.decision_tick)!;
    const originalState = playerStateAtOrBefore(analysis.match_timeline.player_state_tracks ?? [], self, cue.decision_tick)!;
    expect(state.active_item).toEqual(originalState.active_item);
    if (mode === "absent") {
      expect(state.active_item?.ammo_evidence).toBeUndefined();
      expect(state.active_item?.ammo_sampling_version).toBeUndefined();
    }
    if (mode === "latest-missing") {
      expect(state.active_item?.ammo_sampling_version).toBe(2);
      expect(state.active_item?.ammo_evidence).toBeUndefined();
      expect(normalized.match_timeline.player_state_tracks?.some(row => row.tick < state.tick && row.active_item?.ammo_evidence)).toBe(true);
    }
    if (mode === "same-tick-shot") {
      expect(state.active_item?.ammo_evidence?.sampled_at_tick).toBeLessThan(cue.decision_tick);
      expect(normalized.match_timeline.match_events?.some(event => event.event_type === "WEAPON_FIRE" && event.actor_player_id === self && event.tick === cue.decision_tick)).toBe(true);
    }
    const cache = new CurrentCueResourceCache();
    try {
      const before = JSON.stringify(normalized);
      const source = cache.read({ plan, cue, material, timeline: normalized.match_timeline, selectedPlayerId: self });
      const projection = getBaselineCueAmmo(source, plan, cue);
      const questionInput = { plan, generation: 1, diagnosticsEnabled: false, presentableNarration: savedNarration[cue.id],
        busy: false, takenOver: false, resourceSource: source, displayedAmmoText: projection?.text };
      expect(recovered.session.outcome_completion?.status).not.toBe("COMPLETE");
      expect(buildCurrentCueQuestionContext({ ...questionInput, session: recovered.session })).toBeUndefined();
      let session = reduceCoachingSession(plan, recovered.session, { type: "START" });
      let checkedBeforeEnd = false;
      for (let i = 0; i < 30 && session.phase !== "PAUSED_FOR_COACHING"; i++) {
        const active = getCurrentCue(plan, session);
        if (session.phase === "SKIPPING") session = reduceCoachingSession(plan, session, { type: "SKIP_SEGMENT" });
        else if (active) {
          session = reduceCoachingSession(plan, session, { type: "TICK", tick: active.outcome_end_tick - 1 });
          expect(buildCurrentCueQuestionContext({ ...questionInput, session })).toBeUndefined();
          checkedBeforeEnd = true;
          session = reduceCoachingSession(plan, session, { type: "TICK", tick: active.outcome_end_tick });
        } else session = reduceCoachingSession(plan, session, { type: "ADVANCE_SEGMENT" });
      }
      expect(checkedBeforeEnd).toBe(true);
      expect(session.phase).toBe("PAUSED_FOR_COACHING"); expect(session.current_cue_id).toBe(cue.id);
      expect(session.outcome_completion).toMatchObject({ cueId: cue.id, status: "COMPLETE", outcomeEndTick: cue.outcome_end_tick });
      const view = buildThreeStageCoachingView({ narration: savedNarration[cue.id], cue, baselineAmmo: projection, decisionState: state,
        semantics: { ...material, ...cue }, decisionTick: cue.decision_tick, decisionFacts: buildCoachingCueView(cue, false).decisionFacts, outcomeFacts: [] });
      const context = buildCurrentCueQuestionContext({ ...questionInput, session, displayedAmmoText: view.currentState.priorWeaponAmmo?.text });
      expect(context).toBeDefined();
      const answer = answerGroundedCueQuestion(context!, question);
      const known = mode === "positive" || mode === "zero";
      if (known) {
        const clip = mode === "zero" ? 0 : 7;
        expect(state.active_item?.ammo_evidence?.sampled_at_tick).toBeLessThan(cue.decision_tick);
        expect(projection).toMatchObject({ weapon: "AK-47", clip });
        expect(view.currentState.priorWeaponAmmo?.text).toContain(`AK-47 · ${clip} 发`);
        expect(view.currentState.priorWeaponAmmo?.text).toContain("备弹未知");
        expect(answer.items).toEqual([view.currentState.priorWeaponAmmo]);
        expect(answer.source).toContain("当前状态");
        expect(answer.items[0].refs).toEqual([state.active_item!.ammo_evidence!.fact_ref]);
        expect(answer.items[0].refs).not.toEqual(material.decisionSnapshot!.selectedPlayer.evidenceRefs);
        expect(answer.items[0].refs.every(ref => !cue.facts.some(fact => fact.id === ref))).toBe(true);
        expect(availableCurrentCueResourceQuestions(context)).toContain(question);
      } else {
        expect(projection).toBeUndefined(); expect(view.currentState.priorWeaponAmmo).toBeUndefined();
        expect(answer.items).toEqual([]); expect(availableCurrentCueResourceQuestions(context)).not.toContain(question);
      }
      expect(JSON.stringify(normalized)).toBe(before);
    } finally { cache.read(undefined); }
  } });
}, 60_000);

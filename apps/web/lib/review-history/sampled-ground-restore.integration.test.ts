import { afterEach, expect, it } from "vitest";
import { groundSampleText, type GroundSampleEvidence } from "@cs-coach/contracts";
import { fireReplay, self } from "../../../../libs/cs2d-analysis-adapter/src/window-self-fire-fixtures";
import { buildCoachingCueView, buildThreeStageCoachingView, playerStateAtOrBefore } from "../coaching/cs2d-coaching-view";
import { cleanupRestoredHistoryFixture, withReopenedTeachingHistory } from "./teaching-history-restore-fixture";

afterEach(cleanupRestoredHistoryFixture);
const cases = ["FLAG_SET", "FLAG_UNSET", null, "LEGACY_ABSENT"] as const;
it.each(cases)("reopens ground sample %s through stored control-plane teaching without regeneration", async value => {
  const source = fireReplay("DEATH", []);
  // Synthetic sample times only; the managed Demo fixture is header bytes, never parsed.
  const replay = { ...source, rounds: source.rounds.map(round => ({ ...round, frames: round.frames.map(frame => ({ ...frame,
    players: frame.players.map(player => ({ ...player, ...(value === "LEGACY_ABSENT" ? {} : { groundEvidence: {
      version: 1, source: "SOURCE2_PAWN_FLAGS", phase: "TICK_START", sampledAtTick: frame.tick, playerId: player.steamId,
      value: player.alive && player.health > 0 ? value : null,
    } satisfies GroundSampleEvidence }) })) })) })) };
  await withReopenedTeachingHistory({ replay,
    beforeAnalysisSave: value === "FLAG_SET" ? ({ analysis, validate }) => {
      const malformed = structuredClone(analysis);
      const sample = malformed.match_timeline.player_state_tracks!.find(item => item.ground_evidence)!;
      Object.assign(sample.ground_evidence!, { phase: "TICK_END" });
      // Only the timeline test payload is malformed; candidate hashes remain untouched.
      expect(() => validate(malformed)).toThrow("Invalid stored player ground sample.");
      expect(() => validate(analysis)).not.toThrow();
    } : undefined,
    // Explicit compatibility fixture: old 1.12 shape has no ground field anywhere.
    // All candidate/route contents are built and frozen normally; no saved hash is changed.
    transformAnalysis: value === "LEGACY_ABSENT" ? current => {
      expect(JSON.stringify(current)).not.toMatch(/groundEvidence|ground_evidence/);
      return { ...current, metadata: { ...current.metadata, adapter_version: "cs2d-analysis-adapter/1.12.0" } };
    } : undefined,
    verify: ({ analysis, normalized, recovered, savedNarration }) => {
      const cue = recovered.plan.cues[0];
      const state = playerStateAtOrBefore(normalized.match_timeline.player_state_tracks ?? [], self, cue.decision_tick)!;
      const material = normalized.candidate_set.materials.find(item => item.candidateId === cue.candidate_id)!;
      const saved = material.decisionSnapshot!.selectedPlayer.value!.groundEvidence;
      const view = buildThreeStageCoachingView({ narration: savedNarration[cue.id], decisionState: state,
        cue, tickRate: normalized.match_timeline.tick_rate, semantics: { ...material, ...cue }, decisionTick: cue.decision_tick,
        decisionFacts: buildCoachingCueView(cue, false).decisionFacts, outcomeFacts: [] });
      if (value === "LEGACY_ABSENT") {
        expect(normalized.metadata.adapter_version).toBe("cs2d-analysis-adapter/1.12.0");
        expect(state.ground_evidence).toBeUndefined(); expect(saved).toBeUndefined();
        expect(view.currentState.sampledGround).toBeUndefined();
        expect(savedNarration[cue.id].currentSituation.text).not.toContain("地面接触");
      } else {
        expect(state.ground_evidence).toEqual(saved);
        expect(saved).toMatchObject({ value, phase: "TICK_START", sampledAtTick: state.tick, playerId: self });
        expect(view.currentState.sampledGround).toEqual({ text: groundSampleText(value), refs: material.decisionSnapshot!.selectedPlayer.evidenceRefs });
        expect(view.currentState.sampledGround!.refs.length).toBeGreaterThan(0);
        expect(savedNarration[cue.id].currentSituation.text).toContain(groundSampleText(value));
      }
      expect(normalized.candidate_set).toEqual(analysis.candidate_set);
    },
  });
}, 60_000);

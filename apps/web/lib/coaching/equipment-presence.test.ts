import { expect, it } from "vitest";
import { buildCs2dAnalysisBundle, deserializeCs2dAnalysisBundle, serializeCs2dAnalysisBundle } from "@cs-coach/cs2d-analysis-adapter";
import { fireReplay, self } from "../../../../libs/cs2d-analysis-adapter/src/window-self-fire-fixtures";
import { playerStateAtOrBefore, projectArmorChip } from "./cs2d-coaching-view";
import { currentDiagnosisResources, currentDiagnosisWindow } from "./diagnosis-decision-state";

it.each([true, false, undefined])("preserves serialized equipment %s through the actual teaching projections", value => {
  const raw = fireReplay("DEATH");
  // JSON boundary mirrors optional Parser fields. These coordinates are synthetic, not Demo ticks.
  const replay = JSON.parse(JSON.stringify({ ...raw, rounds: raw.rounds.map(round => ({ ...round,
    frames: round.frames.map(frame => ({ ...frame, players: frame.players.map(player => ({ ...player,
      helmet: value, defuser: value,
    })) })),
  })) }));
  const built = buildCs2dAnalysisBundle({ replay, selectedSteamId: self, demoId: "synthetic-equipment-presence" });
  const analysis = deserializeCs2dAnalysisBundle(serializeCs2dAnalysisBundle(built));
  const plan = analysis.review_plan, cue = plan.cues[0];
  const material = analysis.candidate_set.materials.find(item => item.candidateId === cue.candidate_id)!;
  const snapshot = material.decisionSnapshot!;
  const state = playerStateAtOrBefore(analysis.match_timeline.player_state_tracks ?? [], self, cue.decision_tick)!;
  expect(snapshot.selectedPlayer.value?.helmet).toBe(value ?? null);
  expect(snapshot.selectedPlayer.value?.hasDefuseKit).toBe(value ?? null);
  expect(state.missing_fields.includes("helmet")).toBe(value === undefined);
  expect(snapshot.missingFields.includes("helmet")).toBe(value === undefined);
  const origin = { plan, cue, material, timeline: analysis.match_timeline, selectedPlayerId: self };
  expect(currentDiagnosisResources(origin, currentDiagnosisWindow(origin))?.hasHelmet).toBe(value);
  expect(projectArmorChip(state, snapshot).text).toBe(value === true ? "100 头甲" : value === false ? "100 甲" : "100 甲 · 头盔未知");
  // This change does not redefine the legacy timeline's true-only defuse-kit projection.
  expect(state.has_defuse_kit).toBe(value === true ? true : undefined);
  expect(analysis.candidate_set).toEqual(built.candidate_set);
});

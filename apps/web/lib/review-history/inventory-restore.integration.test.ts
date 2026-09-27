import { afterEach, expect, it } from "vitest";
import * as adapter from "@cs-coach/cs2d-analysis-adapter";
import { fireReplay, self } from "../../../../libs/cs2d-analysis-adapter/src/window-self-fire-fixtures";
import { buildCoachingCueView, buildThreeStageCoachingView, playerStateAtOrBefore } from "../coaching/cs2d-coaching-view";
import { buildTeachingDiagnosisInput } from "../coaching/teaching-diagnosis-host";
import { cleanupRestoredHistoryFixture, withReopenedTeachingHistory } from "./teaching-history-restore-fixture";

const cases = [
  { name: "known empty", kinds: [] as string[], version: 1 as const, known: [] as string[] },
  { name: "known Flash", kinds: ["Flash"], version: 1 as const, known: ["Flash"] },
  { name: "known Smoke", kinds: ["Smoke"], version: 1 as const, known: ["Smoke"] },
  { name: "unknown", kinds: undefined, version: 1 as const, known: undefined },
  { name: "invalid kind", kinds: ["not-a-known-grenade"], version: 1 as const, known: undefined },
  { name: "unversioned parser list", kinds: ["Flash"], version: undefined, known: undefined },
];
afterEach(cleanupRestoredHistoryFixture);
it.each(cases)("reopens persisted $name inventory without regenerating teaching", async ({ kinds, version, known }) => {
  const source = fireReplay("DEATH", []);
  const replay: adapter.Cs2dReplay = { ...source, rounds: source.rounds.map(round => ({ ...round,
    frames: round.frames.map(frame => ({ ...frame, players: frame.players.map(player => ({ ...player, grenades: kinds, grenadeInventoryVersion: version })) })),
  })) };
  await withReopenedTeachingHistory({ replay, verify: ({ normalized, recovered, savedNarration }) => {
    const cue = recovered.plan.cues[0];
    const state = playerStateAtOrBefore(normalized.match_timeline.player_state_tracks ?? [], self, cue.decision_tick);
    expect(state).toBeDefined();
    expect(state!.missing_fields.includes("inventory")).toBe(known === undefined);
    expect(state!.missing_fields.includes("inventory.count")).toBe(Boolean(known?.length));
    const material = normalized.candidate_set.materials.find(item => item.candidateId === cue.candidate_id);
    expect(material?.decisionSnapshot?.selectedPlayer.value?.grenades).toEqual(known ?? null);
    const view = buildThreeStageCoachingView({ narration: savedNarration[cue.id], decisionState: state,
      semantics: { ...material, ...cue }, decisionTick: cue.decision_tick,
      decisionFacts: buildCoachingCueView(cue, false).decisionFacts, outcomeFacts: [] });
    const expectedUtility = known?.length === 0 ? ["无道具"]
      : known?.[0] === "Flash" ? ["闪光弹（数量未知）"]
      : known?.[0] === "Smoke" ? ["烟雾弹（数量未知）"] : [];
    expect(view.currentState.chips.filter(chip => chip.kind === "utility").map(chip => chip.text)).toEqual(expectedUtility);
    const diagnostic = buildTeachingDiagnosisInput({ plan: recovered.plan, cue, material, timeline: normalized.match_timeline, selectedPlayerId: self },
      { cueId: cue.id, selectedGoal: "OTHER", response: "ANSWERED", source: "USER", limitations: [] });
    expect(diagnostic.decisionResources?.health).toBe(state!.health);
    expect(diagnostic.decisionResources?.evidenceRefs.length).toBeGreaterThan(0);
    expect(diagnostic.decisionResources?.utilityCount).toBe(known?.length === 0 ? 0 : undefined);
  } });
}, 60_000);

import { expect, it } from "vitest";
import { buildCs2dAnalysisBundle, deserializeCs2dAnalysisBundle, type Cs2dReplay } from "@cs-coach/cs2d-analysis-adapter";
import { fireReplay, self } from "../../../../libs/cs2d-analysis-adapter/src/window-self-fire-fixtures";
import { normalizeWeaponAmmo, type Cs2dWeaponAmmo } from "../../../../libs/cs2d-analysis-adapter/src/weapon-ammo";
import { buildTeachingDiagnosisInput, runTeachingDiagnosis, buildTeachingDiagnosisSubmissionEvent } from "./teaching-diagnosis-host";
import { createFixtureReviewPlan } from "@cs-coach/review-planner";
import { createSyntheticMirageTimeline } from "@cs-coach/demo-domain";
import { decisionSnapshotFixture } from "../../../../libs/review-planner/src/teaching-gate-fixtures";
import { fixtureIdentity } from "../../../../libs/coach-agent/src/test-fixtures";
import { createRemoteCoachAgentDispatchEnvelope, parseRemoteCoachAgentDispatchEnvelope, createCoachAgentRuntime } from "@cs-coach/coach-agent";

const sample = (tick: number, clip = 7): Cs2dWeaponAmmo => ({ source: "SOURCE2_ACTIVE_WEAPON", phase: "TICK_END", sampledAtTick: tick, weapon: "AK-47", weaponHandle: 114697, clip });
function context() {
  const timeline = createSyntheticMirageTimeline(); const plan = createFixtureReviewPlan(timeline); const cue = plan.cues[0];
  const tick = cue.decision_tick - 1;
  const snapshot = decisionSnapshotFixture(cue.decision_tick, "start-state");
  snapshot.selectedPlayerId = timeline.selected_player_id; snapshot.roundNumber = 2; snapshot.sampledAtTick = tick;
  snapshot.selectedPlayer.value = { ...snapshot.selectedPlayer.value!, weapon: "AK-47", alive: true, health: 100, armor: 100, helmet: true, side: "T" };
  const state = { player_id: timeline.selected_player_id, tick, side: "T" as const, world_position: { x: 0, y: 0, z: 0 }, yaw: 0, pitch: 0, alive: true, health: 100, armor: 100, has_helmet: true, inventory: [], fact_refs: ["start-state"], missing_fields: [],
    active_item: { item_id: "AK-47", item_class: "WEAPON", entity_handle: 114697, ...normalizeWeaponAmmo(sample(tick), "AK-47", tick, "start-state", true) } };
  const material = { candidateId: "candidate", decisionSnapshot: snapshot, decisionFacts: cue.facts.filter(f => f.availability === "DECISION"), playerActionFacts: [], outcomeFacts: [], inferences: [], advice: [], evidence: [], limitations: [] };
  return { plan, cue, material, timeline: { ...timeline, player_state_tracks: [state], match_events: [] }, selectedPlayerId: timeline.selected_player_id };
}
const reflection = (cueId: string) => ({ cueId, selectedGoal: "OTHER" as const, response: "ANSWERED" as const, source: "USER" as const, limitations: [] });

it("normalizes optional parser clip provenance without reserve or changing legacy analysis", () => {
  const raw = fireReplay("DEATH");
  const replay: Cs2dReplay = { ...raw, rounds: raw.rounds.map(r => ({ ...r, frames: r.frames.map(f => ({ ...f, players: f.players.map(p => ({ ...p, weapon: "AK-47", activeWeaponHandle: 114697, weaponAmmo: sample(f.tick) })) })) })) };
  const bundle = buildCs2dAnalysisBundle({ replay, selectedSteamId: self, demoId: "ammo-fixture" });
  const state = bundle.match_timeline.player_state_tracks![0];
  expect(state.active_item).toMatchObject({ ammo_clip: 7, ammo_evidence: { sampled_at_tick: state.tick, phase: "TICK_END", fact_ref: `${state.fact_refs[0]}-weapon-ammo-end` } });
  expect(state.active_item).not.toHaveProperty("ammo_reserve");
  expect(deserializeCs2dAnalysisBundle(JSON.stringify(bundle)).match_timeline.player_state_tracks![0]).toEqual(state);
  const legacy = buildCs2dAnalysisBundle({ replay: raw, selectedSteamId: self, demoId: "legacy" });
  expect(legacy.match_timeline.player_state_tracks![0].active_item).not.toHaveProperty("ammo_clip");
});

it.each([undefined, { ...sample(100), clip: -1 }, { ...sample(100), clip: 0.5 }, { ...sample(100), clip: 256 }, { ...sample(100), weaponHandle: 0xffffff }, { ...sample(100), sampledAtTick: 101 }, { ...sample(100), weapon: "M4A4" }])("rejects absent or mismatched source ammo %j", raw => {
  expect(normalizeWeaponAmmo(raw, "AK-47", 100, "frame", true)).toEqual({});
});
it("keeps known zero distinct from missing and excludes dead/non-firearm sources", () => {
  expect(normalizeWeaponAmmo(sample(100, 0), "AK-47", 100, "frame", true).ammo_clip).toBe(0);
  expect(normalizeWeaponAmmo(sample(100), "AK-47", 100, "frame", false)).toEqual({});
  for (const weapon of ["Faca", "Smoke", "C4", "Zeus x27", "UNKNOWN"]) expect(normalizeWeaponAmmo({ ...sample(100), weapon }, weapon, 100, "frame", true)).toEqual({});
});

it.each(["same-tick", "future", "stale", "weapon", "snapshot-weapon", "entity", "player", "round", "shot", "reload", "pickup", "drop", "missing", "dead"])("keeps ammo unknown for %s", reason => {
  const c = context(); const state = c.timeline.player_state_tracks[0];
  if (reason === "same-tick") { state.tick = c.cue.decision_tick; state.active_item.ammo_evidence!.sampled_at_tick = state.tick; c.material.decisionSnapshot.sampledAtTick = state.tick; }
  if (reason === "future") state.active_item.ammo_evidence!.sampled_at_tick++;
  if (reason === "stale") state.tick -= c.timeline.tick_rate;
  if (reason === "weapon") state.active_item.item_id = "M4A4";
  if (reason === "snapshot-weapon") c.material.decisionSnapshot.selectedPlayer.value!.weapon = null;
  if (reason === "entity") state.active_item.entity_handle++;
  if (reason === "player") state.player_id = "other";
  if (reason === "round") c.material.decisionSnapshot.roundNumber = 99;
  if (["shot", "reload", "pickup", "drop"].includes(reason)) c.timeline.match_events = [{ id: "change", tick: c.cue.decision_tick, event_type: reason === "shot" ? "WEAPON_FIRE" : reason === "reload" ? "RELOAD" : reason === "pickup" ? "ITEM_PICKUP" : "ITEM_DROP", actor_player_id: c.selectedPlayerId, payload: {}, source_parser_event: "fixture", fact_confidence: 1, fact_refs: [], missing_fields: [] }] as never;
  if (reason === "missing") delete state.active_item.ammo_evidence;
  if (reason === "dead") state.alive = false;
  expect(buildTeachingDiagnosisInput(c, reflection(c.cue.id)).decisionResources?.weaponAmmo).toBeUndefined();
});

it("delivers the same independently referenced recent clip to local and strict Graph teaching without changing verdict", async () => {
  const c = context(); const r = reflection(c.cue.id);
  const event = buildTeachingDiagnosisSubmissionEvent(c, r, { eventType: "SUBMIT_REFLECTION", eventId: "ammo", identity: { ...fixtureIdentity, selectedPlayerId: c.selectedPlayerId } });
  expect(event.input.decisionResources?.weaponAmmo).toEqual({ weapon: "AK-47", clip: 7, evidenceRefs: ["start-state-weapon-ammo-end"] });
  expect(JSON.stringify(event.input.decisionResources?.weaponAmmo)).not.toMatch(/sampled_at_tick|weapon_handle|player_id/);
  const envelope = parseRemoteCoachAgentDispatchEnvelope(JSON.parse(JSON.stringify(createRemoteCoachAgentDispatchEnvelope(event))));
  const graph = await createCoachAgentRuntime({ checkpoint: "memory" }).dispatch(envelope.event);
  const local = runTeachingDiagnosis(c, r);
  const baselineContext = structuredClone(c); delete baselineContext.timeline.player_state_tracks[0].active_item.ammo_evidence;
  const baseline = runTeachingDiagnosis(baselineContext, r);
  for (const result of [local.cueCase.diagnosticResult, graph.state.cueCases[c.cue.id]?.diagnosticResult]) {
    expect(result?.measurements.find(m => m.id.endsWith("weapon-clip"))).toMatchObject({ value: 7, evidenceRefs: ["start-state-weapon-ammo-end"] });
    expect(result?.explanation).toContain("决策前最近记录为 7 发");
    expect(result?.explanation).toContain("不能当作决策瞬间精确余量");
    expect(result?.status).toBe(baseline.cueCase.diagnosticResult?.status);
  }
  expect(local.cueCase.verdict).toEqual(baseline.cueCase.verdict);
  expect(local.cueCase.transferRule).toEqual(baseline.cueCase.transferRule);
});

it("never exposes same-tick clip through generic or legacy-rich resource projection", async () => {
  const { projectDecisionResources } = await import("@cs-coach/coach-agent/client");
  const c = context(); const state = c.timeline.player_state_tracks[0];
  expect(projectDecisionResources(state).weaponAmmo).toBeUndefined();
  expect(projectDecisionResources(state, state.tick).weaponAmmo).toBeUndefined();
  expect(projectDecisionResources(state, state.tick + 1).weaponAmmo?.clip).toBe(7);
});

it.each([0, 30])("keeps a %s-round clip from changing risk verdict, advice, or legacy rich behavior", async clip => {
  const { diagnoseTeachingCue } = await import("@cs-coach/coach-agent/client");
  const c = context(); c.timeline.player_state_tracks[0].active_item.ammo_clip = clip;
  const r = reflection(c.cue.id); const input = buildTeachingDiagnosisInput(c, r);
  const withAmmo = runTeachingDiagnosis(c, r);
  const legacy = { ...input, decisionState: c.timeline.player_state_tracks[0] };
  delete legacy.decisionResources;
  const noAmmo = diagnoseTeachingCue(legacy);
  expect(noAmmo.cueCase.diagnosticResult?.measurements.some(m => m.id.endsWith("weapon-clip"))).toBe(false);
  expect(withAmmo.cueCase.verdict).toEqual(noAmmo.cueCase.verdict);
  expect(withAmmo.cueCase.transferRule).toEqual(noAmmo.cueCase.transferRule);
});

it.each(["same", "replaced", "missing", "duplicate-prior"])("uses independent prior clip with current frame identity: %s", binding => {
  const c = context(); const prior = c.timeline.player_state_tracks[0];
  const current = structuredClone(prior); current.tick = c.cue.decision_tick;
  current.active_item.ammo_clip = 30;
  current.active_item.ammo_evidence!.sampled_at_tick = current.tick;
  current.active_item.ammo_evidence!.fact_ref = "current-end-must-not-leak";
  if (binding === "replaced") current.active_item.entity_handle++;
  if (binding === "missing") delete (current.active_item as { entity_handle?: number }).entity_handle;
  c.material.decisionSnapshot.sampledAtTick = current.tick;
  c.timeline.player_state_tracks = [prior, current, ...(binding === "duplicate-prior" ? [structuredClone(prior)] : [])];
  const ammo = buildTeachingDiagnosisInput(c, reflection(c.cue.id)).decisionResources?.weaponAmmo;
  if (binding === "same") expect(ammo).toEqual({ weapon: "AK-47", clip: 7, evidenceRefs: ["start-state-weapon-ammo-end"] });
  else expect(ammo).toBeUndefined();
});

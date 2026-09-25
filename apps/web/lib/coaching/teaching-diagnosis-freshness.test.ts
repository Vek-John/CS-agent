import { describe, expect, it } from "vitest";
import type { PlayerStateSample, UserReflection } from "@cs-coach/contracts";
import { createSyntheticMirageTimeline } from "@cs-coach/demo-domain";
import { createFixtureReviewPlan } from "@cs-coach/review-planner";
import { buildTeachingDiagnosisInput, runTeachingDiagnosis, type TeachingDiagnosisHostContext } from "./teaching-diagnosis-host";

// Synthetic timeline boundaries, not observed Demo ticks.
function fixture(decisionTick = 2000, roundNumber = 2) {
  const timeline = structuredClone(createSyntheticMirageTimeline());
  const plan = structuredClone(createFixtureReviewPlan(timeline));
  const cue = { ...plan.cues[0], decision_tick: decisionTick };
  plan.segments.find(segment => segment.id === cue.segment_id)!.round_number = roundNumber;
  const state: PlayerStateSample = { player_id: timeline.selected_player_id, tick: decisionTick, side: "T", world_position: { x: 0, y: 0, z: 0 }, yaw: 0, pitch: 0, alive: true, health: 100, armor: 100, has_helmet: true, money: 4000, equipment_value: 4000, inventory: [{ item_id: "flash", item_class: "UTILITY", count: 2 }], fact_refs: ["resource-source"], missing_fields: [] };
  const context: TeachingDiagnosisHostContext = { plan, cue, timeline: { ...timeline, player_state_tracks: [state] }, selectedPlayerId: timeline.selected_player_id };
  const reflection: UserReflection = { cueId: cue.id, selectedGoal: "OTHER", response: "ANSWERED", source: "USER", limitations: [] };
  return { context, reflection, state };
}

describe("decision-time resource freshness through the production Host", () => {
  it.each(["stale", "previous-round"])("does not diagnose %s resource samples as current", kind => {
    const { context, reflection, state } = kind === "stale" ? fixture() : fixture(1601, 2);
    state.tick = kind === "stale" ? 1967 : 1599;
    const output = runTeachingDiagnosis(context, reflection);
    expect(output.cueCase.diagnosticResult?.measurements).toEqual([]);
    expect(output.cueCase.diagnosticResult?.status).toBe("UNVERIFIABLE");
    expect(buildTeachingDiagnosisInput(context, reflection).decisionState).toBeUndefined();
    expect(buildTeachingDiagnosisInput(context, reflection).decisionResources).toBeUndefined();
  });
});

it.each([
  { name: "same tick", sample: 2000, known: true },
  { name: "inclusive half second", sample: 1968, known: true },
  { name: "one tick too old", sample: 1967, known: false },
  { name: "future only", sample: 2001, known: false },
  { name: "NaN", sample: NaN, known: false },
  { name: "fractional", sample: 1999.5, known: false },
  { name: "negative", sample: -1, known: false },
])("uses current resource measurements only at valid sample times: $name", ({ sample, known }) => {
  const { context, reflection, state } = fixture();
  state.tick = sample;
  const output = runTeachingDiagnosis(context, reflection);
  expect(output.cueCase.diagnosticResult?.measurements.find(m => m.label === "决策时血量")?.value).toBe(known ? 100 : undefined);
  expect(buildTeachingDiagnosisInput(context, reflection).decisionResources?.health).toBe(known ? 100 : undefined);
  expect(buildTeachingDiagnosisInput(context, reflection).decisionState).toBeUndefined();
});

it("finds the latest preceding sample in unordered data without using future state", () => {
  const { context, reflection, state } = fixture();
  context.timeline!.player_state_tracks = [{ ...state, tick: 2001, health: 1 }, { ...state, tick: 1968, health: 80 }, { ...state, tick: 1980, health: 90 }, { ...state, player_id: "other", tick: 1999, health: 2 }];
  expect(runTeachingDiagnosis(context, reflection).cueCase.diagnosticResult?.measurements.find(m => m.label === "决策时血量")?.value).toBe(90);
});

it.each([0, -1, NaN, Infinity, 64.5])("does not assign an age with invalid tick rate %s", tickRate => {
  const { context, reflection } = fixture();
  context.timeline!.tick_rate = tickRate;
  expect(runTeachingDiagnosis(context, reflection).cueCase.diagnosticResult?.measurements).toEqual([]);
});

it.each([NaN, 2000.5, -1])("rejects invalid decision tick %s", decisionTick => {
  const { context, reflection } = fixture();
  context.cue.decision_tick = decisionTick;
  expect(buildTeachingDiagnosisInput(context, reflection).decisionState).toBeUndefined();
  expect(runTeachingDiagnosis(context, reflection).cueCase.diagnosticResult?.measurements).toEqual([]);
});

it("includes this round's freeze time but rejects the previous round and an unknown round", () => {
  const { context, reflection, state } = fixture(1610);
  state.tick = 1600;
  expect(runTeachingDiagnosis(context, reflection).cueCase.diagnosticResult?.measurements.find(m => m.label === "决策时血量")?.value).toBe(100);
  state.tick = 1599;
  expect(runTeachingDiagnosis(context, reflection).cueCase.diagnosticResult?.measurements).toEqual([]);
  state.tick = 1610;
  context.timeline!.rounds = [];
  expect(runTeachingDiagnosis(context, reflection).cueCase.diagnosticResult?.measurements).toEqual([]);
});

it.each(["missing-segment", "wrong-round", "overlap", "invalid-freeze", "round-end", "wrong-player"])("rejects ambiguous or mismatched decision identity: %s", kind => {
  const { context, reflection } = fixture();
  if (kind === "missing-segment") context.cue.segment_id = "absent";
  if (kind === "wrong-round") context.plan.segments.find(s => s.id === context.cue.segment_id)!.round_number = 1;
  if (kind === "overlap") context.timeline!.rounds.push({ ...context.timeline!.rounds[1] });
  if (kind === "invalid-freeze") context.timeline!.rounds[1].freeze_end_tick = NaN;
  if (kind === "round-end") context.cue.decision_tick = 3200;
  if (kind === "wrong-player") context.timeline!.selected_player_id = "other";
  expect(runTeachingDiagnosis(context, reflection).cueCase.diagnosticResult?.measurements).toEqual([]);
});

it.each(["dead", "zero-alive", "duplicate", "death-after-sample"])("does not revive or fabricate current resources: %s", kind => {
  const { context, reflection, state } = fixture();
  if (kind === "dead") state.alive = false;
  if (kind === "zero-alive") state.health = 0;
  if (kind === "duplicate") context.timeline!.player_state_tracks = [state, { ...state, health: 1 }];
  if (kind === "death-after-sample") {
    state.tick = 1990;
    context.timeline!.match_events = [{ id: "self-death", tick: 1995, event_type: "PLAYER_DEATH", target_player_id: context.selectedPlayerId, payload: {}, fact_confidence: 1, fact_refs: [], source_parser_event: "synthetic-death", missing_fields: [] }];
  }
  expect(runTeachingDiagnosis(context, reflection).cueCase.diagnosticResult?.measurements).toEqual([]);
  expect(buildTeachingDiagnosisInput(context, reflection).decisionState).toBeUndefined();
});

it("omits unknown optional values and keeps only the sample's own resource references", () => {
  const { context, reflection, state } = fixture();
  state.missing_fields = ["money", "equipment_value", "inventory"];
  const packet = buildTeachingDiagnosisInput(context, reflection);
  expect(packet.decisionResources).toMatchObject({ evidenceRefs: ["resource-source"] });
  for (const key of ["money", "equipmentValue", "utilityCount"]) expect(packet.decisionResources).not.toHaveProperty(key);
  for (const measurement of runTeachingDiagnosis(context, reflection).cueCase.diagnosticResult!.measurements) expect(measurement.evidenceRefs).toEqual(["resource-source"]);
});

async function bindRoster(context: TeachingDiagnosisHostContext) {
  const { decisionSnapshotFixture } = await import("../../../../libs/review-planner/src/teaching-gate-fixtures");
  const snapshot = decisionSnapshotFixture(context.cue.decision_tick, "roster-source");
  snapshot.selectedPlayerId = context.selectedPlayerId;
  snapshot.roundNumber = 2;
  context.cue.decisionSnapshot = snapshot;
  return snapshot;
}

it.each(["stale", "absent"])("preserves independently fresh zero-teammate evidence with %s self resources", async kind => {
  const { context, reflection, state } = fixture();
  state.tick = 1900;
  if (kind === "absent") context.timeline!.player_state_tracks = [];
  await bindRoster(context);
  reflection.selectedGoal = "TRADE";
  const packet = buildTeachingDiagnosisInput(context, reflection);
  expect(packet.decisionResources).toBeUndefined();
  expect(packet.decisionState).toBeUndefined();
  expect(packet.decisionRoster).toEqual({ aliveTeammates: 0, evidenceRefs: ["roster-source"] });
  const result = runTeachingDiagnosis(context, reflection).cueCase.diagnosticResult!;
  expect(result.status).toBe("CONTRADICTED");
  expect(runTeachingDiagnosis(context, reflection).cueCase.verdict?.type).toBe("INCONCLUSIVE");
  expect(runTeachingDiagnosis(context, reflection).cueCase.transferRule?.do).toContain("无法再与队友配合");
  expect(result.measurements[0]).toMatchObject({ value: 0, evidenceRefs: ["roster-source"] });
});

it.each(["wrong-player", "wrong-round", "wrong-decision", "future", "stale", "null-time", "missing-fresh", "missing-roster", "hidden", "unknown-alive", "unknown-side", "missing-side"])("does not borrow invalid public roster: %s", async kind => {
  const { context, reflection, state } = fixture();
  state.tick = 1900;
  const snapshot = await bindRoster(context);
  if (kind === "wrong-player") snapshot.selectedPlayerId = "other";
  if (kind === "wrong-round") snapshot.roundNumber = 1;
  if (kind === "wrong-decision") snapshot.decisionTick = 1999;
  if (kind === "future") snapshot.sampledAtTick = 2001;
  if (kind === "stale") snapshot.sampledAtTick = 1967;
  if (kind === "null-time") snapshot.sampledAtTick = null;
  if (kind === "missing-fresh") snapshot.missingFields = ["fresh_player_state"];
  if (kind === "missing-roster") snapshot.missingFields = ["complete_current_roster"];
  if (kind === "hidden") snapshot.aliveCounts.boundary = "GROUND_TRUTH";
  if (kind === "unknown-alive") snapshot.selectedPlayer.value!.alive = null;
  if (kind === "unknown-side") snapshot.selectedPlayer.value!.side = null;
  if (kind === "missing-side") snapshot.missingFields = ["current_side"];
  reflection.selectedGoal = "TRADE";
  expect(buildTeachingDiagnosisInput(context, reflection).decisionRoster).toBeUndefined();
  expect(runTeachingDiagnosis(context, reflection).cueCase.diagnosticResult?.status).toBe("UNVERIFIABLE");
});

it("honors snapshot missing information instead of recovering the same field from normalized defaults", async () => {
  const { context, reflection } = fixture();
  const snapshot = await bindRoster(context);
  snapshot.missingFields = ["health"];
  const packet = buildTeachingDiagnosisInput(context, reflection);
  expect(packet.decisionState).toBeUndefined();
  expect(packet.decisionResources?.health).toBeUndefined();
  expect(packet.decisionResources?.armor).toBe(100);
});

it.each(["fresh", "partial", "low-partial", "all-unknown", "known-false", "stale", "independent-roster", "invalid-roster"])("keeps Host rich, compact Graph and API consistent for %s", async kind => {
  const { buildTeachingDiagnosisSubmissionEvent } = await import("./teaching-diagnosis-host");
  const { createCoachAgentRuntime, createRemoteCoachAgentDispatchEnvelope, parseRemoteCoachAgentDispatchEnvelope } = await import("@cs-coach/coach-agent");
  const { fixtureIdentity } = await import("../../../../libs/coach-agent/src/test-fixtures");
  const { POST } = await import("../../app/api/coaching/diagnose/route");
  const { context, reflection, state } = fixture();
  context.cue.facts.push({ id: "current-legal-fact", text: "可验证的决策事实。", availability: "DECISION", available_at_tick: 1990, source: "DEMO", observed_by_player: true });
  context.cue.observable_fact_refs.push("current-legal-fact");
  if (["stale", "independent-roster", "invalid-roster"].includes(kind)) state.tick = 1900;
  if (kind === "partial") {
    state.health = 70; state.armor = 80; state.has_helmet = false;
    const snapshot = await bindRoster(context);
    snapshot.selectedPlayer.value!.health = 70; snapshot.selectedPlayer.value!.armor = 80; snapshot.selectedPlayer.value!.helmet = null;
  }
  if (kind === "all-unknown") state.missing_fields = ["health", "armor", "helmet", "money", "equipment_value", "inventory"];
  if (kind === "low-partial") { state.health = 30; state.missing_fields = ["armor", "helmet", "money", "equipment_value", "inventory"]; }
  if (kind === "known-false") state.has_helmet = false;
  if (kind.includes("roster")) {
    reflection.selectedGoal = "TRADE";
    const snapshot = await bindRoster(context);
    if (kind === "invalid-roster") snapshot.sampledAtTick = 2001;
  }
  const event = buildTeachingDiagnosisSubmissionEvent(context, reflection, { eventType: "SUBMIT_REFLECTION", eventId: "freshness-reflection", identity: { ...fixtureIdentity, selectedPlayerId: context.selectedPlayerId } });
  expect(event.input).not.toHaveProperty("decisionState");
  if (["stale", "independent-roster", "invalid-roster"].includes(kind)) expect(event.input).not.toHaveProperty("decisionResources");
  if (kind === "partial") expect(event.input.decisionResources).toMatchObject({ health: 70, armor: 80 });
  if (kind === "partial" || kind === "all-unknown") expect(event.input.decisionResources).not.toHaveProperty("hasHelmet");
  expect(event.input.decisionFacts.map(f => f.id)).toContain("current-legal-fact");
  expect(JSON.stringify({ resources: event.input.decisionResources, roster: event.input.decisionRoster })).not.toMatch(/player_id|tick|position|inventory/);
  const envelope = parseRemoteCoachAgentDispatchEnvelope(JSON.parse(JSON.stringify(createRemoteCoachAgentDispatchEnvelope(event))));
  const runtime = createCoachAgentRuntime({ checkpoint: "memory" });
  const graph = await runtime.dispatch(envelope.event);
  const local = runTeachingDiagnosis(context, reflection);
  const response = await POST(new Request("http://localhost/api/coaching/diagnose", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ mode: "START", outcomeGateStatus: "COMPLETE", input: { ...event.input, reflection } }) }));
  const remote = await response.json();
  expect(remote.status).toBe("SUCCEEDED");
  expect(graph.status).toBe("COMPLETED");
  for (const cueCase of [graph.state.cueCases[context.cue.id], remote.cueCase]) {
    expect(cueCase?.diagnosticResult).toEqual(local.cueCase.diagnosticResult);
    expect(cueCase?.verdict).toEqual(local.cueCase.verdict);
    expect(cueCase?.transferRule).toEqual(local.cueCase.transferRule);
  }
  if (kind === "fresh") for (const measurement of local.cueCase.diagnosticResult!.measurements) expect(measurement.evidenceRefs).toEqual(["resource-source"]);
  const duplicate = await runtime.dispatch(envelope.event);
  expect(duplicate.state.trace).toEqual(graph.state.trace);
});

it.each(["OTHER", "TRADE"] as const)("keeps missing-resource limitations bounded for %s", goal => {
  const { context, reflection, state } = fixture();
  state.tick = 1900;
  reflection.selectedGoal = goal;
  context.cue.limitations = Array.from({ length: 12 }, (_, i) => `existing limitation ${i}`);
  expect(runTeachingDiagnosis(context, reflection).cueCase.diagnosticResult?.limitations.length).toBeLessThanOrEqual(12);
});

it.each(["wrong-player", "wrong-round", "future", "missing-time"])("does not use a fresh raw frame to bypass snapshot %s", async kind => {
  const { context, reflection } = fixture();
  const snapshot = await bindRoster(context);
  if (kind === "wrong-player") snapshot.selectedPlayerId = "other";
  if (kind === "wrong-round") snapshot.roundNumber = 1;
  if (kind === "future") snapshot.sampledAtTick = 2001;
  if (kind === "missing-time") snapshot.sampledAtTick = null;
  expect(buildTeachingDiagnosisInput(context, reflection).decisionState).toBeUndefined();
  expect(runTeachingDiagnosis(context, reflection).cueCase.diagnosticResult?.measurements).toEqual([]);
});

it("uses the existing ceil(tickRate / 2) discrete age boundary", () => {
  const { context, reflection, state } = fixture();
  context.timeline!.tick_rate = 65;
  state.tick = 1967;
  expect(buildTeachingDiagnosisInput(context, reflection).decisionResources?.health).toBe(100);
  state.tick = 1966;
  expect(buildTeachingDiagnosisInput(context, reflection).decisionResources).toBeUndefined();
});

it("renders missing current resources without old measurements and keeps the continue control", async () => {
  const { createElement } = await import("react");
  const { renderToStaticMarkup } = await import("react-dom/server");
  const { TeachingDiagnosisPanel } = await import("../../components/playback/teaching-diagnosis-panel");
  const { context, reflection, state } = fixture();
  state.tick = 1900;
  const output = runTeachingDiagnosis(context, reflection);
  const html = renderToStaticMarkup(createElement(TeachingDiagnosisPanel, { cue: context.cue, decisionFacts: [], cueCase: output.cueCase, hasTrustedDecisionContext: true, onSubmit() {}, onSkip() {}, onConfirm() {}, onDisagree() {} }));
  expect(html).toContain("足够新的本人资源");
  expect(html).not.toContain("决策时血量</b>");
  expect(html).not.toContain("决策时道具数量</b>");
  expect(html).toContain("懂了，继续");
});

it.each(["GET_INFO", "DELAY"] as const)("does not overflow bounded limitations when resources are missing for %s", goal => {
  const { context, reflection, state } = fixture();
  state.tick = 1900;
  reflection.selectedGoal = goal;
  context.cue.limitations = Array.from({ length: 10 }, (_, i) => `existing limitation ${i}`);
  expect(runTeachingDiagnosis(context, reflection).cueCase.diagnosticResult?.limitations.length).toBeLessThanOrEqual(12);
});

it.each(["missing", "null"])("keeps current 70HP/80 armor when helmet is %s", async kind => {
  const { context, reflection, state } = fixture();
  state.health = 70; state.armor = 80; state.has_helmet = false;
  const snapshot = await bindRoster(context);
  snapshot.selectedPlayer.value!.health = 70;
  snapshot.selectedPlayer.value!.armor = 80;
  snapshot.selectedPlayer.value!.helmet = null;
  if (kind === "missing") { snapshot.missingFields = ["helmet"]; state.missing_fields = ["helmet"]; }
  const output = runTeachingDiagnosis(context, reflection);
  const result = output.cueCase.diagnosticResult!;
  expect(result.measurements.find(m => m.label === "决策时血量")?.value).toBe(70);
  expect(result.measurements.find(m => m.label === "决策时护甲")?.value).toBe(80);
  expect(result.status).toBe("UNVERIFIABLE");
  expect(result.explanation).not.toMatch(/无头盔|没头盔|资源并未落入/);
  expect(buildTeachingDiagnosisInput(context, reflection).decisionState).toBeUndefined();
});

it.each(["missing-health", "invalid-health", "invalid-armor", "unknown-helmet", "bad-inventory", "latest-partial"])("preserves independent current fields for %s", kind => {
  const { context, reflection, state } = fixture();
  if (kind === "missing-health") state.missing_fields = ["health"];
  if (kind === "invalid-health") state.health = NaN;
  if (kind === "invalid-armor") state.armor = 101;
  if (kind === "unknown-helmet") (state as unknown as Record<string, unknown>).has_helmet = null;
  if (kind === "bad-inventory") state.inventory = [{ item_id: "flash", item_class: "UTILITY", count: -1 }];
  if (kind === "latest-partial") context.timeline!.player_state_tracks = [{ ...state, tick: 1990 }, { ...state, health: NaN }];
  const packet = buildTeachingDiagnosisInput(context, reflection);
  expect(packet.decisionState).toBeUndefined();
  expect(packet.decisionResources?.evidenceRefs).toEqual(["resource-source"]);
  const healthUnknown = ["missing-health", "invalid-health", "latest-partial"].includes(kind);
  expect(packet.decisionResources?.health).toBe(healthUnknown ? undefined : 100);
  expect(packet.decisionResources?.armor).toBe(kind === "invalid-armor" ? undefined : 100);
  expect(packet.decisionResources?.hasHelmet).toBe(kind === "unknown-helmet" ? undefined : true);
  expect(packet.decisionResources?.utilityCount).toBe(kind === "bad-inventory" ? undefined : 2);
  const result = runTeachingDiagnosis(context, reflection).cueCase.diagnosticResult!;
  expect(result.status).toBe(kind === "bad-inventory" ? "SUPPORTED" : "UNVERIFIABLE");
  expect(result.explanation).not.toMatch(/undefined|NaN|无头盔/);
});

it("does not substitute raw defaults for snapshot unknowns or inconsistent field values", async () => {
  const { context, reflection, state } = fixture();
  const snapshot = await bindRoster(context);
  snapshot.selectedPlayer.value!.health = 90; // Raw 100 disagrees at the same sample.
  snapshot.selectedPlayer.value!.armor = 100;
  snapshot.selectedPlayer.value!.helmet = null; // Raw true must not fill this.
  const resources = buildTeachingDiagnosisInput(context, reflection).decisionResources!;
  expect(resources.health).toBeUndefined();
  expect(resources.hasHelmet).toBeUndefined();
  expect(resources.armor).toBe(100);
  expect(state.health).toBe(100); // No source mutation.
});


it("renders known partial values and helmet unknown without changing the continue control", async () => {
  const { createElement } = await import("react");
  const { renderToStaticMarkup } = await import("react-dom/server");
  const { TeachingDiagnosisPanel } = await import("../../components/playback/teaching-diagnosis-panel");
  const { context, reflection, state } = fixture();
  state.health = 70; state.armor = 80; state.has_helmet = false; state.missing_fields = ["helmet"];
  const result = runTeachingDiagnosis(context, reflection);
  const html = renderToStaticMarkup(createElement(TeachingDiagnosisPanel, { cue: context.cue, decisionFacts: [], cueCase: result.cueCase, hasTrustedDecisionContext: true, onSubmit() {}, onSkip() {}, onConfirm() {}, onDisagree() {} }));
  expect(html).toContain("70HP");
  expect(html).toContain("80甲");
  expect(html).toContain("头盔未知");
  expect(html).not.toMatch(/无头盔|没头盔/);
  expect(html).toContain("懂了，继续");
});

it.each([false, true])("preserves the known-zero death gate without treating a missing HP default as death (missing=%s)", async missing => {
  const { context, reflection, state } = fixture();
  state.health = 0;
  if (missing) state.missing_fields = ["health"];
  const snapshot = await bindRoster(context);
  snapshot.selectedPlayer.value!.health = 70;
  const resources = buildTeachingDiagnosisInput(context, reflection).decisionResources;
  if (missing) {
    expect(resources?.health).toBeUndefined();
    expect(resources?.armor).toBe(100);
  } else {
    expect(resources).toBeUndefined();
    expect(runTeachingDiagnosis(context, reflection).cueCase.diagnosticResult?.measurements).toEqual([]);
  }
});

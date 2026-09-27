import { baselineAmmoText, type BaselineAmmoDisplay, projectArmorChip, buildCoachingCueView, playerStateAtOrBefore } from "./cs2d-coaching-view";
import { matchesDecisionState, verifiedDisplayedUtilityEvidence } from "./utility-kind-evidence";
import type { CoachCue, DecisionResources, DiagnosticMeasurement, ReviewPlan, TeachingDiagnosisInput } from "@cs-coach/contracts";
import type { TeachingDiagnosisHostContext } from "./teaching-diagnosis-host";
import { decisionFactsForCue } from "./teaching-diagnosis-host";
import { projectDiagnosisClock } from "./diagnosis-decision-clock";
import { currentDiagnosisSnapshot, currentDiagnosisResources, currentDiagnosisWindow } from "./diagnosis-decision-state";

/** Opaque, page-local provenance: a saved/labelled measurement cannot manufacture this source. */
export interface CurrentCueResourceSource { readonly revision: number }
const sources = new WeakMap<CurrentCueResourceSource, { plan: ReviewPlan; cue: CoachCue; resources?: DecisionResources; clock?: TeachingDiagnosisInput["decisionClock"]; clockFact?: VerifiedResourceText; health?: VerifiedResourceText; armor?: VerifiedResourceText & { displayedText: string }; utilityKinds?: VerifiedResourceText; baselineAmmo?: BaselineAmmoDisplay }>();

/** One immutable source entry per Host. Typing/replay do not rescan the timeline. */
export class CurrentCueResourceCache {
  private last?: { context: TeachingDiagnosisHostContext; source: CurrentCueResourceSource };
  private revision = 0;

  read(context: TeachingDiagnosisHostContext | undefined): CurrentCueResourceSource | undefined {
    if (!context) {
      if (this.last) sources.delete(this.last.source);
      this.last = undefined;
      return;
    }
    const old = this.last?.context;
    if (old && old.plan === context.plan && old.cue === context.cue && old.timeline === context.timeline
      && old.material === context.material && old.selectedPlayerId === context.selectedPlayerId) return this.last!.source;
    if (this.last) sources.delete(this.last.source);
    const { plan, cue, timeline, material, selectedPlayerId } = context;
    const belongs = plan.cues.includes(cue) && plan.player_id === selectedPlayerId && timeline?.demo_id === plan.demo_id
      && (!material || material.candidateId === cue.candidate_id);
    const window = belongs ? currentDiagnosisWindow(context) : undefined;
    const resources = belongs ? currentDiagnosisResources(context, window) : undefined;
    const snapshot = belongs ? currentDiagnosisSnapshot(context, window) : undefined;
    const decisionFacts = decisionFactsForCue(cue, material);
    const clock = belongs ? projectDiagnosisClock(snapshot, decisionFacts) : undefined;
    const clockFacts = clock ? decisionFacts.filter(fact => clock.evidenceRefs.includes(fact.id)) : [];
    const fact = clockFacts[0];
    const cueClockFacts = fact ? cue.facts.filter(candidate => candidate.id === fact.id) : [];
    const clockFact = clock?.evidenceRefs.length === 1 && clockFacts.length === 1 && fact &&
      cueClockFacts.length === 1 && cueClockFacts[0].text === fact.text &&
      cueClockFacts[0].source === fact.source && cueClockFacts[0].availability === fact.availability &&
      cueClockFacts[0].observed_by_player === fact.observed_by_player && cueClockFacts[0].available_at_tick === fact.available_at_tick &&
      fact.source === "DEMO" && fact.observed_by_player && fact.availability === "DECISION" &&
      fact.available_at_tick === snapshot?.sampledAtTick && cue.observable_fact_refs.includes(fact.id) &&
      fact.text.trim().length > 0 && fact.text.length <= 400
      ? { text: fact.text, refs: [fact.id] } : undefined;
    // Match the baseline View's precedence and fact surface, while requiring current freshness.
    const semantics = { ...material, ...cue };
    const displayedContext = { ...context, material: undefined, cue: { ...cue, decisionSnapshot: semantics.decisionSnapshot } };
    const displayedSnapshot = currentDiagnosisSnapshot(displayedContext, window);
    const state = belongs && displayedSnapshot ? playerStateAtOrBefore(timeline?.player_state_tracks ?? [], selectedPlayerId, cue.decision_tick) : undefined;
    const viewFacts = buildCoachingCueView(cue, false).decisionFacts;
    const utilityKinds = state ? verifiedDisplayedUtilityEvidence(state, semantics, cue.decision_tick, viewFacts) : undefined;
    const stateRefs = displayedSnapshot?.selectedPlayer.evidenceRefs ?? [];
    const validStateRefs = stateRefs.length > 0 && stateRefs.length <= 8 && new Set(stateRefs).size === stateRefs.length && stateRefs.every(ref => {
      const shown = viewFacts.filter(fact => fact.id === ref), canonical = decisionFacts.filter(fact => fact.id === ref);
      const a = shown[0], b = canonical[0];
      return shown.length === 1 && canonical.length === 1 && a && b && a.text === b.text &&
        a.source === "DEMO" && b.source === "DEMO" && a.availability === "DECISION" && b.availability === "DECISION" &&
        a.observed_by_player && b.observed_by_player && a.available_at_tick === state?.tick && b.available_at_tick === state?.tick && cue.observable_fact_refs.includes(ref);
    });
    const health = state && resources?.health !== undefined && validStateRefs &&
      state.health === resources.health && displayedSnapshot?.selectedPlayer.value?.health === resources.health &&
      matchesDecisionState(state, semantics, cue.decision_tick, viewFacts)
      ? { text: `${resources.health} HP`, refs: [...stateRefs] } : undefined;
    const armorChip = state ? projectArmorChip(state, displayedSnapshot) : undefined;
    const armor = state && armorChip && resources?.armor !== undefined && armorChip.value === resources.armor && validStateRefs &&
      state.armor === resources.armor && displayedSnapshot?.selectedPlayer.value?.armor === resources.armor &&
      matchesDecisionState(state, semantics, cue.decision_tick, viewFacts)
      ? { text: `${resources.armor} 甲`, refs: [...stateRefs], displayedText: armorChip.text } : undefined;
    // Most cues inherit their material snapshot, so do not rescan the timeline.
    // A cue-owned override must also pass the existing complete resource guards.
    const displayedResources = displayedSnapshot === snapshot ? resources : currentDiagnosisResources(displayedContext, window);
    const ammo = resources?.weaponAmmo, shownAmmo = displayedResources?.weaponAmmo;
    const baselineAmmo = state && ammo && shownAmmo && validStateRefs && matchesDecisionState(state, semantics, cue.decision_tick, viewFacts) &&
      ammo.weapon === shownAmmo.weapon && ammo.clip === shownAmmo.clip && ammo.weapon === state.active_item?.item_id &&
      ammo.weapon === displayedSnapshot?.selectedPlayer.value?.weapon && ammo.evidenceRefs.length > 0 && ammo.evidenceRefs.length <= 8 &&
      new Set(ammo.evidenceRefs).size === ammo.evidenceRefs.length && ammo.evidenceRefs.length === shownAmmo.evidenceRefs.length &&
      ammo.evidenceRefs.every(ref => shownAmmo.evidenceRefs.includes(ref))
      ? { cueId: cue.id, candidateId: cue.candidate_id, decisionTick: cue.decision_tick, weapon: ammo.weapon, clip: ammo.clip,
          text: baselineAmmoText(ammo.weapon, ammo.clip), refs: [...ammo.evidenceRefs] } : undefined;
    const source = Object.freeze({ revision: ++this.revision });
    sources.set(source, { plan, cue, resources, clock, clockFact, health, armor, utilityKinds, baselineAmmo });
    this.last = { context: { ...context }, source };
    return source;
  }
}

export type CueResourceKind = "health" | "armor" | "utility" | "ammo" | "clock";
export interface VerifiedResourceText { text: string; refs: readonly string[] }

/** Match the existing deterministic measurement contract, never infer a resource from its label. */
export function matchDisplayedCueResources(
  source: CurrentCueResourceSource | undefined,
  plan: ReviewPlan,
  cue: CoachCue,
  measurements: readonly DiagnosticMeasurement[],
): Partial<Record<CueResourceKind, VerifiedResourceText>> {
  const origin = source && sources.get(source);
  if (!origin || origin.plan !== plan || origin.cue !== cue) return {};
  const r = origin.resources;
  const clock = origin.clock;
  const refs = [...new Set(r?.evidenceRefs ?? [])].slice(0, 8);
  const candidates = [
    { kind: "health", id: "health", label: "决策时血量", value: r?.health, unit: "HP", refs },
    { kind: "armor", id: "armor", label: "决策时护甲", value: r?.armor, unit: "甲", refs },
    { kind: "utility", id: "utility", label: "决策时道具数量", value: r?.utilityCount, unit: "颗", refs },
    { kind: "ammo", id: "weapon-clip", label: `${r?.weaponAmmo?.weapon} 决策前最近记录弹匣`, value: r?.weaponAmmo?.clip, unit: "发", refs: r?.weaponAmmo?.evidenceRefs ?? [] },
    { kind: "clock", id: "round-time", label: "决策前最近采样的回合剩余时间（约）", value: clock ? Math.ceil(clock.remainingSeconds) : undefined, unit: "秒", refs: clock?.evidenceRefs ?? [] },
  ] as const;
  const result: Partial<Record<CueResourceKind, VerifiedResourceText>> = {};
  for (const item of candidates) {
    if (item.value === undefined || item.refs.length === 0) continue;
    const matches = measurements.filter(m => m.id === `measurement-${cue.id}-${item.id}`);
    const m = matches[0];
    if (matches.length !== 1 || m.value !== item.value || m.label !== item.label || m.unit !== item.unit
      || m.evidenceRefs.length !== item.refs.length || new Set(m.evidenceRefs).size !== m.evidenceRefs.length
      || !m.evidenceRefs.every(ref => item.refs.includes(ref))) continue;
    result[item.kind] = { text: `${item.label}：${item.value}${item.unit}。`, refs: [...item.refs] };
  }
  return result;
}

/** Baseline-only caller must also supply the exact utility text from its current displayed View. */
export function matchDisplayedCueUtilityKinds(source: CurrentCueResourceSource | undefined, plan: ReviewPlan, cue: CoachCue, displayedText: string | undefined): VerifiedResourceText | undefined {
  const origin = source && sources.get(source);
  return origin && origin.plan === plan && origin.cue === cue && origin.utilityKinds && origin.utilityKinds.text === displayedText
    ? { text: origin.utilityKinds.text, refs: [...origin.utilityKinds.refs] } : undefined;
}

/** Copy the sourced sentence only if that exact fact is visible in the current baseline narration. */
export function matchDisplayedBaselineClock(source: CurrentCueResourceSource | undefined, plan: ReviewPlan, cue: CoachCue, shown: VerifiedResourceText): VerifiedResourceText | undefined {
  const origin = source && sources.get(source);
  const fact = origin?.clockFact;
  if (!origin || origin.plan !== plan || origin.cue !== cue || !origin.clock || !fact ||
    !shown.text.includes(fact.text) || !fact.refs.every(ref => shown.refs.filter(value => value === ref).length === 1)) return;
  return { text: fact.text, refs: [...fact.refs] };
}

/** A baseline chip is only a display match; the cache owns numeric health and canonical fact provenance. */
export function matchDisplayedBaselineHealth(source: CurrentCueResourceSource | undefined, plan: ReviewPlan, cue: CoachCue, displayedText: string | undefined): VerifiedResourceText | undefined {
  const origin = source && sources.get(source);
  return origin && origin.plan === plan && origin.cue === cue && origin.health && origin.health.text === displayedText
    ? { text: origin.health.text, refs: [...origin.health.refs] } : undefined;
}

/** Match the full chip, but answer only the independently verified armor quantity, never helmet state. */
export function matchDisplayedBaselineArmor(source: CurrentCueResourceSource | undefined, plan: ReviewPlan, cue: CoachCue, displayedText: string | undefined): VerifiedResourceText | undefined {
  const origin = source && sources.get(source);
  return origin && origin.plan === plan && origin.cue === cue && origin.armor && origin.armor.displayedText === displayedText
    ? { text: origin.armor.text, refs: [...origin.armor.refs] } : undefined;
}

/** Host-only display projection; object identity scopes it to the same current plan/cue. */
export function getBaselineCueAmmo(source: CurrentCueResourceSource | undefined, plan: ReviewPlan | undefined, cue: CoachCue | undefined): BaselineAmmoDisplay | undefined {
  const origin = source && sources.get(source);
  return origin && origin.plan === plan && origin.cue === cue && origin.baselineAmmo
    ? { ...origin.baselineAmmo, refs: [...origin.baselineAmmo.refs] } : undefined;
}

export function matchDisplayedBaselineAmmo(source: CurrentCueResourceSource | undefined, plan: ReviewPlan, cue: CoachCue, displayedText: string | undefined): VerifiedResourceText | undefined {
  const ammo = getBaselineCueAmmo(source, plan, cue);
  return ammo && ammo.text === displayedText ? { text: ammo.text, refs: [...ammo.refs] } : undefined;
}

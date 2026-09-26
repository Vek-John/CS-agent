import type { CoachCue, DecisionResources, DiagnosticMeasurement, ReviewPlan, TeachingDiagnosisInput } from "@cs-coach/contracts";
import type { TeachingDiagnosisHostContext } from "./teaching-diagnosis-host";
import { decisionFactsForCue } from "./teaching-diagnosis-host";
import { projectDiagnosisClock } from "./diagnosis-decision-clock";
import { currentDiagnosisSnapshot, currentDiagnosisResources, currentDiagnosisWindow } from "./diagnosis-decision-state";

/** Opaque, page-local provenance: a saved/labelled measurement cannot manufacture this source. */
export interface CurrentCueResourceSource { readonly revision: number }
const sources = new WeakMap<CurrentCueResourceSource, { plan: ReviewPlan; cue: CoachCue; resources?: DecisionResources; clock?: TeachingDiagnosisInput["decisionClock"] }>();

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
    const clock = belongs ? projectDiagnosisClock(currentDiagnosisSnapshot(context, window), decisionFactsForCue(cue, material)) : undefined;
    const source = Object.freeze({ revision: ++this.revision });
    sources.set(source, { plan, cue, resources, clock });
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

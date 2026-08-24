import {
  CapabilityBuilderInputSchema,
  type CapabilityBuilderInput,
} from "./types";

/**
 * A compact reference extracted from the parsed test_demo replay bundle.
 * This is not the current Director → PlanCompiler route: the source bundle
 * uses demo-planner/1.1.0 and has no candidate_id or primary_focus_code.
 * Canonical ticks are retained because they came from the parsed fixture;
 * raw Replay, frames, tracks and coordinates are intentionally absent.
 */
export const stage2TestDemoCueReference = Object.freeze({
  schemaVersion: "coach-agent-stage2-cue-reference.v1" as const,
  source: Object.freeze({
    kind: "PARSED_REPLAY_REFERENCE" as const,
    artifact: "apps/web/public/generated-data/test_demo.replay.json",
    sourceSha256: "84a1a4191302bdd2a3bbb5a727842093744b1fb1a228aeec630369e44b622cb2",
    sourceSizeBytes: 60_601_900,
    plannerVersion: "demo-planner/1.1.0",
    cueCount: 5,
    currentDirectorRoute: false,
  }),
  route: Object.freeze({
    status: "LEGACY_REVIEW_PLAN_ONLY" as const,
    segmentId: "seg-r1-cue-e:361",
    segmentMode: "DEEP_DIVE" as const,
    roundNumber: 1,
    startTick: 4093,
    decisionTick: 4189,
    revealTick: 4285,
    outcomeStartTick: 4189,
    outcomeEndTick: 4477,
    cueOrder: 0,
  }),
  cue: Object.freeze({
    cueId: "cue:signal:76561197964020430:e:361",
    observableStateId: "obs-state:76561197964020430:4189",
    candidateId: null,
    primaryFocusCode: null,
  }),
  narration: Object.freeze({
    readiness: "LEGACY_DETERMINISTIC_ONLY" as const,
    title: "还没受击时，先把退路留住",
    refs: Object.freeze({
      decision: ["fact:signal:76561197964020430:e:361:self"],
      action: [],
      outcome: ["fact:signal:76561197964020430:e:361:outcome"],
      advice: ["advice:signal:76561197964020430:e:361:survival-reset"],
      evidence: [
        "evidence:signal:76561197964020430:e:361:demo",
        "evidence:signal:76561197964020430:e:361:rule",
      ],
      observable: ["fact:signal:76561197964020430:e:361:self"],
    }),
  }),
  limitations: Object.freeze([
    "旧 planner 没有 candidate_id/primary_focus_code，不能直接进入当前 DirectorDecisionSet。",
    "没有 verified player-action fact；不能把结果事实或 advice 反推成 action ref。",
    "当前 test_demo 的 8-cue Director route 没有以 AnalysisBundle artifact 保留，真实当前 cue 仍需从 cs2d AnalysisBundle 提取。",
  ]),
});

export type Stage2TestDemoCueReference = typeof stage2TestDemoCueReference;

/**
 * Build the current builder's factual input only after the current Director
 * supplies a primary focus. The helper deliberately keeps actionRefs empty;
 * callers cannot smuggle a legacy outcome into a verified player action.
 */
export function buildStage2CapabilityInput(primaryFocusCode: string): CapabilityBuilderInput {
  return CapabilityBuilderInputSchema.parse({
    cueId: stage2TestDemoCueReference.cue.cueId,
    primaryFocusCode,
    decisionRefs: [...stage2TestDemoCueReference.narration.refs.decision],
    actionRefs: [],
    outcomeRefs: [...stage2TestDemoCueReference.narration.refs.outcome],
    evidenceRefs: [...stage2TestDemoCueReference.narration.refs.evidence],
    annotationRefs: ["annotation:signal:76561197964020430:e:361:decision"],
    actorRefs: [],
    calloutRefs: [],
    grenadeTrajectoryRefs: [],
    grenadeLandingRefs: [],
    outcomeGateStatus: "COMPLETE",
    modelStatus: "UNAVAILABLE",
    measurementRefs: [],
    negativeWinProbabilitySwingPercentagePoints: null,
    economyContext: {
      reliable: false,
      relevant: false,
      ref: null,
      economyClass: "UNKNOWN",
    },
    limitations: [...stage2TestDemoCueReference.limitations],
  });
}

# Independent RETURN_AND_FIRE boundary review

Date: 2026-09-23. Scope: the current self-movement/fire producer, v3 assessment projection and UNKNOWN-only acceptance, adapter integration, and real-input smoke harness. This is a focused follow-up to the earlier Jev review; it does not repeat the full historical feature review. The reviewer made no implementation edits, remote calls, large Demo reads, or browser/service launches.

## Findings

**No open actionable P1/P2 defect found in the reviewed final code.** One P2 validation-evidence defect was identified and repaired during review:

- Original `tools/jev-real-live.ts:129–130,153–154` incremented Director/Narrator consumption from artifact presence plus successful helper return. That could overstate consumption if a resolver discarded an artifact. The revised Director callback locally resolves the artifact and requires the actual Director summary assessment to equal that resolved result before incrementing (`tools/jev-real-live.ts:150–156`). The revised Narrator callback requires the actual CoachingPackage artifact, assessment, and generated core-issue text to contain the bound inference; for RETURN_AND_FIRE it also asserts UNKNOWN/UNKNOWN/INSUFFICIENT, `INSUFFICIENT_EVIDENCE`, and the explicit inability to confirm contact before counting (`tools/jev-real-live.ts:126–141`). Restored reads are counted separately. This repair was inspected, passed strict harness TypeScript checking, and is corroborated by the execution owner's real-input run below. **P2 closed.**

## Boundary checks

- `nominateReturnAndFire` reads explicit `shooterSteamId`, shot tick and selected-player samples. It ignores shot tracer coordinates, enemy positions, damage events, winners and later result labels. Wrong/missing actors, invalid or duplicate self samples, excessive sample gaps/height changes, missing return, and out-of-window shots are rejected. Sampled motion remains a nomination heuristic, not contact detection (`libs/cs2d-analysis-adapter/src/return-and-fire.ts:23–79`).
- The adapter places self-motion/attributed fire in a separate structured PLAYER_ACTION fact, and later sampled health/alive state in OUTCOME facts. Missing later outcome samples do not invent results. CandidateGenerator forwards only actor-bound, independently referenced actions in the strict window (`libs/review-planner/src/candidate-generator.ts:203–218`).
- Projection v3 has its own scenario/question version, `sincePriorShotSeconds` and literal `contactStatus: UNVERIFIED`. The parser rejects mixed legacy/contact fields and the final HTTP builder reconstructs the whitelisted packet. Future-result counterfactual tests cover both the adapter material and final serialized HTTP body/cache identity.
- `validateDecisionAssessmentResult` accepts RETURN_AND_FIRE only as UNKNOWN / UNKNOWN / INSUFFICIENT and forces evidence confidence to zero, including when legacy applicability checks are populated. It does not rewrite a model's unsupported confident decision into a fake model refusal: the response remains rejected diagnostic data (`libs/review-planner/src/decision-assessment.ts:179,213`).
- Default behavior still uses rule baseline. Accepted experimental artifacts are locally revalidated, while v1/v2 packet identities and question versions remain covered by fixed compatibility assertions. Old adapter 1.5.x serialized history remains readable. The new factual candidate type is limited to `REVIEW_UNCERTAINTY`; it is not a new expert error label.
- The live harness reads a bounded key line only from explicit stdin, supplies it directly to the fixed native adapter and emits only bounded telemetry/hashes/versions/usage. It does not serialize keys, raw packets, candidate bindings, player identity or Replay. Five remote calls is a global ceiling; actual network invocations are counted inside the final fetch wrapper. The child owns the single parse and bulk Replay; controller timeout/cleanup and worktree-only output checks remain explicit.

## Independent verification

```sh
pnpm exec vitest run \
  libs/cs2d-analysis-adapter/src/return-and-fire.test.ts \
  libs/cs2d-analysis-adapter/src/index.test.ts \
  libs/review-planner/src/candidate-generator.test.ts \
  libs/review-planner/src/decision-assessment.test.ts \
  apps/web/lib/coaching/jev-decision-assessment.test.ts
```

Result: **5 files, 116 tests passed**. Coverage includes wrong/missing actor, hidden-coordinate access, future-outcome mutation, sampled-path validity, v3 final HTTP shape, no stronger tactical label, old packet/cache identity, and serialization compatibility.

```sh
pnpm exec tsc --ignoreConfig --noEmit --target ES2022 --module esnext \
  --moduleResolution bundler --skipLibCheck --esModuleInterop --strict \
  --types node --allowImportingTsExtensions \
  tools/jev-real-live.ts tools/verify-jev-real-smoke.ts
git diff --check
```

Both passed. No temporary resources were created by this review.

The reviewer also read the bounded summary in [JEV_RETURN_FIRE_LIVE.json](JEV_RETURN_FIRE_LIVE.json), produced by the main controller rather than rerunning any remote calls. The report is `PASS`: 535 candidates, 18 RETURN_AND_FIRE patterns, 8 eligible packets; 5 actual remote requests all returned UNKNOWN / UNKNOWN / INSUFFICIENT, producing 5 test-only accepted artifacts. The repaired assertions recorded 2 actual Director-summary consumptions and 2 Narrator refusal explanations. The local restoration reconstruction recorded 28 narrations, including 2 accepted-artifact reads, and zero reassessment calls. The remaining accepted artifacts were not represented as consumed teaching. These counts close the consumption-evidence finding without implying professional tactical accuracy.

## Limits of the conclusion

The earlier missing-action producer gap is addressed by an explicitly narrower factual mode; it does **not** establish real re-peek/contact detection or CS2 tactical correctness. UNKNOWN-only acceptance validates honest abstention and integration with existing teaching, not professional coaching quality. Synthetic boundary tests and a small real-input smoke cannot establish expert accuracy or reliable p95/p99 latency. The harness's JSON roundtrip and local package reconstruction are scoped restoration evidence; full application history/OutcomeCompletionGate/Memory regression results belong to the main validation run. Production automatic acceptance must remain disabled unless separately validated.

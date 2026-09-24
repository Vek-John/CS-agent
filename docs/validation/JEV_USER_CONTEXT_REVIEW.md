# Jev closed user context review

Date: 2026-09-22. Independent review of the new USER_CONTEXT projection; reviewer did not implement the reviewed changes. This review changes no implementation files, performs no model calls, reads no credentials, and parses no Demo.

## Result

No new P1/P2 correctness or information-boundary defect was established in the inspected change. This is a scoped engineering review, not CS2 tactical-quality acceptance, a full product-entry acceptance, or proof that Jev reacts appropriately to reports.

## Inspected contracts and evidence

- `libs/contracts/src/observation.ts`: `parseUserTacticalContext` accepts exactly four keys. It reconstructs an object containing the fixed version, closed area and plan enums, and integer count 0–5 or null. Extra prompt/prose fields, invalid enums, missing fields and malformed counts cannot pass to the provider through this structure.
- `libs/observation/src/index.ts`: the Fact validator restricts the new payload to `USER_CONTEXT`; the Claim validator requires `USER_CONTEXT` / `USER_ASSERTED` / `USER_CONTEXT_ONLY`. Builder reconstructs the nested payload instead of preserving the caller's object. Observer filtering and temporal filtering remain in the existing build flow. This is user assertion provenance, not evidence that a reported enemy really occupied that site.
- `libs/review-planner/src/decision-assessment.ts`: candidate-bound claims must exist, be unique, belong to the current snapshot's observer, be available before the decision, be unexpired, and be at most ten seconds old. New content is rejected on a mismatched source/knowledge/scope combination. Team visibility cannot bypass the shared-knowledge gate.
- The outgoing observation includes `USER_PROVIDED`, its numeric confidence, relative age, and the reconstructed `reportedContext`. It excludes `context_ref`, identities, raw ticks, paths and arbitrary textual limitations. `parseDecisionAssessmentPacket` validates exact recursive keys before `buildJevHttpBody` reconstructs the final serialized request.
- A claim with the payload uses projection v2. When the payload is absent, the builder retains v1 and the old property order; the fingerprint routine still hashes the same packet JSON. The additional constant itself is not serialized into an old packet. Existing saved artifacts are resolved by local packet/fingerprint/alias validation; this review found no new provider call in that path.
- The source restriction is not merely a confidence cutoff: even a user claim with confidence 1 cannot make `objectiveAllowsDelay`, `tradeWindow` or `safeReachableCover` a verified check. Checks relying on any USER_CONTEXT reference remain `UNKNOWN`. Affirmative model conclusions cannot use an `OBSERVATION` alias as supporting evidence. Model confidence cannot override those checks.
- An explicit reported enemy count above the public alive count rejects a model's `SUFFICIENT` output. An `INSUFFICIENT` response may still be recorded; it does not become a confident decision judgment. This is a bounded consistency check, not a complete contradiction detector for every possible tactical report.
- The Jev response adapter always records `USER_CONTEXT_UNVERIFIED` when the packet contains `USER_PROVIDED`. The generation-model comparator uses the same packet and question definitions, preserving the protocol/probability differences documented by that adapter.

## Validation performed

Command:

```sh
pnpm exec vitest run libs/observation/src/index.test.ts libs/review-planner/src/decision-assessment.test.ts apps/web/lib/coaching/jev-decision-assessment.test.ts
```

Result: **3 files, 54 tests passed**. These include the new closed-content provenance/reconstruction checks, equal-metadata A-site/B-site fingerprint differentiation, invalid-source rejection, public-count contradiction refusal, and final HTTP bodies containing the expected site while excluding private `context_ref`. An injected extra `prompt` property fails before a third HTTP call. Existing future-result request invariance and restore-without-repeat-call tests also passed in this selected suite.

Filtered evaluator was run without provider settings and without `--live`:

```sh
env -u JEV_API_KEY -u DEEPSEEK_API_KEY -u DEEPSEEK_URL -u DEEPSEEK_MODEL -u DEEPSEEK_ALLOW_EMPTY_KEY pnpm exec tsx tools/eval-decision-assessment.ts --case-prefix=structured-report-
```

Result: selected **2 cases**, **6 provider rows**, **0 remote calls**. Both structured report cases belong to `synthetic-information-e` / `HOLDOUT`. Rule rows completed; Jev and generation-model rows explicitly reported `LIVE_NOT_REQUESTED`. The verifier still checks the whole dataset: **11 cases, 6 Demo groups, 2 counterfactual pairs**, with no Demo group or identical packet crossing calibration/holdout splits. All cases identify their labels as `SYNTHETIC_AUTHOR_EXPECTATION`; no expert labels or real Demo data were claimed.

## Remaining limits

The two new cases intentionally keep all computed tactical checks unknown, so the accepted expectation remains refusal for both sites. They prove that substantive user content reaches distinct legal packets, not that a professional judgment ought to change between A and B or that Jev correctly changes it. The existing final-HTTP tests use a mock transport and are not live model-quality evidence.

This review does not establish a user-facing report-entry UI or end-to-end user submission from the current product. It also does not establish real recontact action recognition. Those must retain their separate overall acceptance status. No new generated text, direct-vision truth, alternative applicability or coach golden labels should be inferred from the closed report fields.

A future focused regression could explicitly combine confidence 1 with a USER_CONTEXT-backed check, and persist/reopen a v2 artifact. The current implementation's corresponding gates were inspected, while the selected tests chiefly exercise the existing v1 restore path and lower-confidence user reports. This is residual test coverage, not a reproduced defect.

主控随后补充了confidence=1且用户引用支持check的拒绝升级测试，以及v2 artifact三次JSON恢复、fingerprint一致和零fetch调用回归；此处不扩大到真实用户报点入口验收。

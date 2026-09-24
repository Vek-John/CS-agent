# Independent Jev pilot review

Date: 2026-09-22. Review base: uncommitted work against `6f5bf45` (`HEAD`, the verified initial main baseline), including new untracked implementation files. Spec: `docs/prompts/JEV_DECISION_ASSESSMENT_TASK.md`; standards: project operating rules, `PRD.md`, `MVP_SCOPE.md`, and existing architecture boundaries. The reviewer authored the separate evaluation runner/fixtures and therefore focused this final review on the core, adapter, preparation, restoration and desktop configuration written by other agents. No remote model calls, large-data reads, or services were started during review.

## Standards

No remaining P1/P2 information-boundary or desktop-secret violation was found in the reviewed scope. The final model request is reconstructed by a strict field whitelist. Model-native confidence remains separate from evidence confidence. Version, candidate binding, field ownership, relative action-window and observable-state gates are checked locally. Desktop generation and decision credentials use distinct Keychain services; optional old initialization envelopes explicitly select rule baseline and do not inherit shell Jev credentials. Rust debug output redacts the new key. No parser coaching conclusions or Memory/player-control authority were added to the Jev adapter.

Two P2 defects found during review were repaired by the implementation owner and rechecked:

1. **Citation questions were not bound to a concrete conclusion.** Original `apps/web/lib/coaching/jev-decision-assessment.ts:42` asked whether evidence supported an atom's broad judgment definition; parallel questions cannot read the selected sibling answer. The current code creates `atom × category × alias` support questions, explicitly names each proposition, and consumes only support answers for the selected category (`parseJevResponse`, around lines 73–82). This addresses the engineering ambiguity; semantic citation correctness still requires model/expert evaluation.
2. **Local transport could indefinitely block base preparation.** Original `apps/web/lib/coaching/decision-assessment-host.ts:26` awaited configuration GET/body without a deadline, before knowing whether the pilot was enabled. POST had the same transport gap outside the upstream deadline. The new `localJson` bounds fetch plus JSON decoding, races cancellation even for an ignoring transport, limits GET to 750 ms and POST to 3,500 ms, and falls back without modifying the candidate set. Independent hung-GET and immediate-abort checks passed.

## Spec

**[P1, OPEN] Normal Demo imports still cannot reach the decision assessment producer (initial finding; binding/transport subparts updated below).** `libs/review-planner/src/decision-assessment.ts:106–111` requires legal live-player context and the new `PlayerActionFact.decisionAction`. The change adds the contract and synthetic producers but no producer in `libs/cs2d-analysis-adapter`, `libs/observation`, or `candidate-generator.ts`. `docs/validation/JEV_REAL_SMOKE.json` records 517/517 real candidates rejected with `MISSING_LIVE_PLAYER_CONTEXT`, zero eligible inputs and zero real-input model calls. Even with a key, the usual import flow cannot currently exercise a real Jev assessment. This is an implementation/data-production gap, separate from missing API credentials or coach labels. To close it, implement a legal observer-specific live snapshot and independently verified action producer, then demonstrate a real eligible candidate through the existing preparation path without deriving actions from death/kill outcomes. Until then, describe A1 as **synthetic test-only integration passed; requested real product slice incomplete**, not full implementation acceptance.

Related limits that must remain explicit:

- A3 currently proves categorical projection changes and `USER_PROVIDED` preservation. The model packet omits the substantive content of tactical reports; different reports with identical metadata cannot be distinguished. It does not establish tactical understanding or professional adjustment to new information.
- Shadow assessments do not alter teaching, but preparation awaits them sequentially before Director. It is a bounded pre-freeze side channel, not an independent background job; worst-case local waits can reach about 35 seconds for ten eligible candidates. Do not describe it as latency-free background evaluation.
- Production acceptance stays disabled; `TEST_ONLY` demonstrates plumbing with unvalidated tactical rules. No test-only success is evidence that Jev is a professional CS2 coach.
- Restoration tests demonstrate local artifact consumption and no extra fake provider calls. The broader actual history/OutcomeCompletionGate/Memory regression suite and production/Rust builds remain the main controller's validation responsibility; this review does not substitute for those checks.

## Independent verification

| Command/check | Result |
| --- | --- |
| `pnpm exec vitest run libs/review-planner/src/decision-assessment.test.ts apps/web/lib/coaching/jev-decision-assessment.test.ts apps/web/lib/desktop/decision-provider.test.ts` | 3 files, 35 tests passed after citation/transport fixes |
| `pnpm exec tsx --test apps/desktop-runtime/src/contracts.test.ts` | 6 tests passed, including old envelope and in-memory key isolation |
| Direct host probe: fetch never resolves, then separate signal-ignoring cancellation | Original candidate set returned after 753 ms; cancellation rejected with `AbortError` |
| `git diff --check` | Passed |

No review-created files or processes require cleanup beyond this report. Standards: 0 open P1/P2 findings, 2 P2 repaired. Spec: 1 open P1 product-completeness finding; live model measurement and expert quality remain separate acceptance states.

## Main-controller closure addendum

A second cross-review by the core implementer found that new preparation could retain an older experiment overlay after switching to baseline/shadow, and that schema acceptance counts could exceed locally consumable artifacts. The owner fixed both in `decision-assessment-host.ts`: strip old overlays for new preparation, reuse only compatible locally revalidated artifacts, and count acceptance after `resolveDecisionAssessment`. Frozen-history consumption stays separate. Added mode-switch and no-new-habit-key regressions pass. A failed/cancelled preparation promise is cleared for an explicit retry; successful repeated preparation remains memoized. The product-completeness P1 remains open.

Frontend integration review applied the installed emil-design-eng and apple-design skills; no markup/CSS/animation was introduced. Existing reduced-motion/transparency CSS remains present; no new visual smoke is claimed.

| Before | After | Why |
|---|---|---|
| Optional assessment transport could stall preparation | Independent bounded GET/POST + cancellation | Preserve user control and baseline availability |
| New baseline/shadow run could retain old experiment judgment | Remove old inference overlay for new preparation | Current configuration governs new work; saved history remains stable |
| Pilot judgment could contribute an unvalidated habit key | No new verifiedHabitKey for pilot artifacts | Experimental feedback must not silently acquire durable behavioral meaning |

## Producer-binding follow-up

The controller subsequently fixed candidate-owned snapshot refs in adapter 1.5.1 and added strictly attributed/window-bounded structured-action forwarding in CandidateGenerator 2.2.0. Legacy 1.5.0 restoration preserves original refs/hash. New real input evidence is `JEV_REAL_BOUNDARY_SMOKE.json`: 354 out-of-scope candidates and 163 missing structured actions, still zero eligible. The P1 remains open for actual observable contact/action production; its snapshot-binding and fact-transport subparts are now closed. This is not evidence that real recontact detection exists.

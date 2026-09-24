# Jev decision assessment evaluation

Date: 2026-09-22. This report separates engineering acceptance, live model measurement, and professional coaching quality. Synthetic author expectations are not expert labels. Rule output is not ground truth.

## Reproduce locally

From the repository root:

```sh
pnpm exec tsx tools/eval-decision-assessment.ts
pnpm exec tsx tools/eval-decision-assessment.ts --live
pnpm exec tsx tools/eval-decision-assessment.ts --live --max-calls=10 --timeout-ms=2500
```

The first command is offline. `--live` is explicit authorization to call configured providers using the same anonymous packet and rubric. The runner reads only `JEV_API_KEY`, `DEEPSEEK_API_KEY`, `DEEPSEEK_MODEL`, `DEEPSEEK_URL`, and `DEEPSEEK_ALLOW_EMPTY_KEY`; it does not load an environment file, inspect Keychain, or print credentials. Optional `--key-stdin` accepts a single Jev key line from a trusted non-echoing input source and keeps it in process memory. Existing generation settings do not silently configure Jev. Set required credentials in the invoking process using the existing server configuration workflow; do not put them in the command, report, or Git.

Output is JSON on stdout. To retain a run, redirect it to a local path of your choice; the runner does not write user data or artifacts by itself. Each row contains case/group/split, packet fingerprint, provider, actual model, structured result, rejection reason, model/evidence confidence, usage and latency. Explicitly rerunning `--live` can incur new calls; evaluation cache is only in-memory within one invocation, and identical counterfactual packets reuse one provider response. This is separate from production/history caching.

Default total budget is 10 remote requests across both providers. The hard cap is 100, with a 10-minute overall deadline, sequential calls, no runner retries, and a per-request timeout capped at 3 seconds. Raising the cap does not add samples to the current corpus. Missing credentials, exhausted budget and deadline are visible `BLOCKED` rows. HTTP/model failures remain `FALLBACK` rows. The runner never modifies teaching, frozen plans, playback or Memory.

## Corpus and labels

The committed corpus has 9 compact cases in 6 artificial Demo groups, with 2 paired outcome counterfactuals. All have `SYNTHETIC_AUTHOR_EXPECTATION` and `SYNTHETIC_RELATIVE_SECONDS` provenance. The implementation agent authored these expectations; no human coach annotation is implied. There are no canonical ticks. Seven requested distinctions are represented:

| Distinction | Case(s) | Author expectation |
| --- | --- | --- |
| Good action, bad outcome | `good-choice-bad-result` | Objective urgency supports contact despite losing |
| Bad action, good outcome | `bad-choice-good-result` | Untraded repeat peek despite verified delay/cover |
| Reasonable active contest | `reasonable-active-contest` | Verified trade permits contact; no unique optimum asserted |
| Unnecessary risk | `unnecessary-risk-bad-result` | Same decision as its favorable-outcome pair |
| Missing information | `missing-context` | Abstain, never equate missing alternatives with forced choice |
| Fresh legal information | `reliable-new-information` | Packet changes; model quality remains unmeasured |
| Multiple reasonable actions | `multiple-reasonable-actions` | Multiple acceptable labels/alternative comparisons |
| Unverified user supplement | `user-context-not-demo-fact` | Keep `USER_PROVIDED`, uncertainty and unknown checks |

Outcome fields and author labels remain outside every provider packet. Each case separately specifies acceptable risk, alternative and evidence-sufficiency labels. Ambiguous sets are allowed. There is no outcome-derived label or baseline-derived golden answer. Observation entries in this projection carry categorical metadata, source, age and confidence; they do **not** include the substance of a free-text tactical report. The fresh-information case verifies projection sensitivity, not tactical comprehension of a report.

Calibration and holdout partitions are assigned by `demoGroup`. Paired outcomes stay in one group/split; assertions reject group leakage and identical input fingerprints across splits. No threshold tuning was performed. These partitions demonstrate evaluation mechanics and do not create a real expert holdout.

Initial isolated-worktree inventory found no `demoTests/`, `.local-data/`, `.dem`, `.jsonl`, candidate JSON, or expert-label files (dependency/build/model-asset directories excluded). Existing compact `teaching-gate-fixtures.ts` is synthetic. `teaching-capability-eval.ts` evaluates visual tool selection, so only its engineering pattern is reused. `tools/verify-trusted-demo.ts` requires a parser WASM and Demo outside this checkout; its current output includes raw player names/ticks and is not a remote assessment dataset. Main-task read-only discovery of external local Replay/Demo material is reported separately; raw data was not copied for this evaluation.

## What the metrics mean

- **Parsing and validation:** report schema-parsed/unparsed rows, then deterministic pass/reject counts among parsed rows. `structuralValidity` uses **all non-blocked rows**, including parse and validation failures, as its denominator. Model/schema parsing is distinct from reference/applicability validation. These checks do not establish professional semantic correctness.
- **Proxy label/alternative/sufficiency hits:** agreement with acceptable author sets across **all parsed outputs, including deterministically rejected outputs**, separately for calibration and holdout. Audit-only `diagnosticResult` is retained separately from teaching-consumable `result`. Rejected cases must not disappear from quality statistics. The alternative metric evaluates the restricted `PREFERABLE / NOT_ESTABLISHED / UNKNOWN` comparison; it does not prove selection among concrete tactical action alternatives.
- **Refusal:** parsed `UNKNOWN` risk or `INSUFFICIENT` context, regardless of deterministic acceptance. Transport/schema failures, validation rejections, and their reason counts are separate. Missing evidence is not low teaching value.
- **Automatic acceptance:** disabled for production because no expert-validated threshold exists. Coverage is zero and acceptance error rate is unavailable, not zero. The evaluation does not exercise a test-only teaching acceptance switch.
- **Calibration:** multiclass Brier and five-bin ECE are descriptive proxy statistics for singleton author labels only. Ambiguous acceptable sets are excluded. Native Jev probabilities and a generation model's self-reported probabilities are not assumed to have the same calibration semantics. Deterministic rule probabilities are not empirically calibrated confidence.
- **Uncertainty:** 1,000 bootstrap draws resample entire Demo groups and retain their correlated nodes. Fewer than two groups returns no interval. Even available intervals are exploratory because there are only artificial groups and no expert labels; they cannot support a professional accuracy claim.
- **Usage/cost:** actual remote attempts only; cached rows are excluded. Jev cost is computed from returned input tokens at the documented rate; generation cost is null unless independently known. Failed calls with missing usage have unknown cost, not zero inferred cost.
- **Latency:** actual attempts only; p50 is descriptive. Fewer than 100 samples yields null p95/p99 and `INSUFFICIENT_SAMPLES_FOR_TAIL_ESTIMATION`. The current small corpus cannot establish reliable tail/service-level latency even if repeatedly called.

Both remote adapters receive the same `DecisionAssessmentPacket` and rubric. Native `/v1/systemone` versus generation `/chat/completions`, response constraints, confidence semantics, and provider model versions remain differences. Remote outcomes are never synthesized for absent credentials.

## Recorded verification

`pnpm exec tsx tools/eval-decision-assessment.ts` passed fixture checks: 9 cases, 6 groups, 2 counterfactual pairs, zero remote requests. Rule outputs passed structural validation for 9/9 cases. The recorded rule proxy label/alternative/sufficiency hits were each 9/9, refusals 2/9, singleton-label Brier 0 and five-bin ECE 0. These are agent-authored regression expectations, not model effects or expert accuracy; zero proxy error does not establish tactical quality. Production automatic acceptance remained disabled, coverage 0 and accepted-error rate unavailable.

The runner is outside the root TypeScript include glob. It additionally passed `pnpm exec tsc --ignoreConfig --noEmit --target ES2022 --module esnext --moduleResolution bundler --skipLibCheck --esModuleInterop --strict --types node tools/eval-decision-assessment.ts`.

The initial `pnpm exec tsx tools/eval-decision-assessment.ts --live` run had neither provider configured in the evaluation agent's process: zero remote requests and `MISSING_PROVIDER_KEY` for both providers. This was a missing-key fallback check, not a model result.

The main controller subsequently received a user-supplied key and ran an actual Jev smoke with 7 unique remote calls and 2 in-run reuses. The first live run used evaluator v1: two uncertain outputs passed the gate; five unique outputs were rejected (seven rows including counterfactual reuse). Reported usage was 36,803 input / 9,307 output tokens, documented-rate estimate $0.001545726, descriptive p50 547 ms, and no reliable p95/p99 estimate. Generation comparison remained unconfigured. The v1 report's `2/2` structural metric and label hit rate considered only gate survivors and **must not be interpreted as overall quality**; rejected output labels were not retained in that run.

Evaluator v2 corrects that selection bias: parsed rejected outputs remain audit-only diagnostics, all parsed labels enter proxy metrics, deterministic gate failures retain reason codes, and structural coverage uses every attempted row. A synthetic rejected-diagnostic accounting regression passes and never enters reported provider runs. The main controller records any follow-up live v2 run separately; neither run provides real-Demo tactical or expert validation.

The CLI asserts packet identity/cache-key identity across the two outcome pairs, absence of disallowed output/identity fields, user source preservation, schema validity and Demo-group split isolation. Final HTTP serialization, candidate projection, cancellation, late-response, prompt injection, outcome gate and history restore are covered by the dedicated implementation tests and main-task validation report; this CLI alone does not prove those boundaries. Live adversarial robustness remains unmeasured even when deterministic injection tests pass.

## Follow-up professional evaluation

Before enabling production automatic acceptance, obtain independent CS2 coach labels on legal decision packets, with multiple reasonable actions and uncertainty reasons allowed. Retain annotator provenance, disagreements, rubric version and original Demo group. Use separate Demo groups for rubric/threshold development and untouched evaluation. Measure errors among accepted cases and coverage together; inspect confident wrong answers, reliable new-information changes and outcome counterfactuals. A later 300–500-node set is a planning target only, not an existing dataset or prerequisite to this engineering slice. No such labels or results were fabricated here.

## Verified upstream facts

The native endpoint, typed question and response structure are defined by the [official API reference](https://docs.typesafe.ai/api). Fixed `jev-1.13.0`, price `$0.042 / million input tokens`, free output, text input and context limits were checked on 2026-09-22 against [Models](https://docs.typesafe.ai/models). Model confidence comes from probability shape rather than evidence verification or CS2 accuracy; see [Confidence](https://docs.typesafe.ai/confidence). The official [Jev 1.13 limitations](https://docs.typesafe.ai/model-jaggedness/jev-1.13) explicitly require code-owned arithmetic and warn about adversarial state and cross-question invariants. SDK v0.6.0 [retry defaults](https://github.com/typesafe-ai/typesafe-sdk-js/blob/v0.6.0/src/retry.ts) are 10 seconds per attempt and two retries; this integration uses an explicit bounded native adapter instead.

## Later verification: existing generation provider is available

The initial process-environment check was insufficient: the existing main-workspace localhost provider file contained the named generation settings. The controller used an explicit, read-only `--generation-env-file` selector that parses only DEEPSEEK_API_KEY/MODEL. Four recorded HTTP400 attempts exposed a JSON-mode prompt contract omission; the official [JSON guide](https://api-docs.deepseek.com/guides/json_mode/) requires an explicit JSON instruction. The corrected comparator includes that instruction and preserves the response-reported model rather than relabeling it Jev.

`GENERATION_USER_CONTEXT_JSON_LIVE.json` contains two successful calls on the same two v2 structured-report packets as `JEV_USER_CONTEXT_LIVE.json`: requested deepseek-v4-flash, returned deepseek-flash; 3618 input/1050 output tokens, 1933/2002ms, both UNKNOWN/INSUFFICIENT. These are server-reported model identifiers, not immutable weight revisions. Generation cost is unknown because the retained usage lacks precise cache pricing attribution; four failed calls also have unknown usage. All-provider attempts total22 (Jev16+generation6), not just the two successes. Professional quality and real-contact input coverage remain unproven.

Final engineering regression: 988 tests passed, 5 existing skips. Production acceptance remains disabled. No further paid calls were made after the successful two-case generation comparison.

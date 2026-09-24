# Semantic projection / joint-witness model review

Date: 2026-09-24. This is a read-only audit of the saved [development run](JEV_SEMANTIC_DEVELOPMENT_LIVE.json) and [six-input test run](JEV_SEMANTIC_HOLDOUT_LIVE.json). The reviewer authored the compact proxy fixtures/runner; this audit is not independent coach annotation. No additional model requests, data collection, prompt changes, threshold relaxation, or report rewrites were performed.

## Main conclusion

**This experiment did not demonstrate an improvement in Jev's decision-assessment quality.** Old and new Jev both score zero on the prespecified primary metric in both stages. New Jev's six-input test has fewer deterministic passes than old Jev (1 versus 2), with probability validation failures and label/witness inconsistencies. Shorter responses, lower measured cost, and lower descriptive latency do not turn those failures into a quality gain. These small results do not establish that Jev can never improve; they do not justify claiming that this revision improved it or enabling it by default.

The generation model using the new protocol does produce four primary successes across the two stages, but both test-stage successes are in condition families similar to development. It also makes two unsupported confident judgments that the gate rejects. Its performance does not establish professional CS2 correctness or a causal improvement from spatial semantics.

## Integrity, denominator and metric

Both reports record the same frozen dataset SHA-256:

`0efb9189eff4df85f3e7e06d6d1141b262ce138ee9a3ad5623cef0731e1a07e8`

Development has 3 distinct inputs × 3 arms = **9 actual / 9 planned requests**. The test stage has 6 distinct inputs × 3 arms = **18 / 18**. Each arm has exactly one remote request per input. Total new calls for this stage are **27**, with no subsequent reruns. The development JSON predates the optional `comparisonComplete` field; its call/row counts independently establish completeness, and the historical file is left unchanged.

The primary metric requires all of:

1. The returned assessment passes the strict deterministic validator, including concrete joint witnesses and references for the new protocol.
2. It is non-abstaining: risk and alternative comparison are not UNKNOWN, and context is SUFFICIENT.
3. Risk, alternative and sufficiency each belong to the pre-frozen author acceptance set.

The denominator remains **all inputs in that arm**, including parser failures, validation rejections and correct refusals. Correct refusal is reported as such and is never a primary success. Parsed rejected diagnostics remain visible rather than being silently removed from quality accounting. All labels are `AGENT_AUTHORED_PROXY`; there are **zero coach gold labels**.

## Recomputed results

| Stage / arm | Inputs | Parseable | Gate-valid | Primary success |
| --- | ---: | ---: | ---: | ---: |
| Development — old Jev | 3 | 3 | 1 | 0 |
| Development — new Jev | 3 | 2 | 1 | 0 |
| Development — generation, new protocol | 3 | 3 | 3 | 2 |
| Six-input test — old Jev | 6 | 6 | 2 | 0 |
| Six-input test — new Jev | 6 | 5 | 1 | 0 |
| Six-input test — generation, new protocol | 6 | 6 | 4 | 2 |

New Jev's development failures are one `UPSTREAM_PROBABILITY` and one `WITNESS_LABEL_MISMATCH`. Its test stage has one probability failure and four deterministic rejections. A probability failure records what the adapter rejected; because a fully parsed result is unavailable, this audit does not invent its underlying label or infer an unobserved cause. On avoidable-contact cases, a corrected risk category alone is insufficient: inconsistent alternative/context/witness output still fails the primary metric.

The generation model's test failures are concrete:

- `test-urgent-objective`: outputs UNWARRANTED / NOT_ESTABLISHED / SUFFICIENT despite the supplied objective forbidding delay; `INAPPLICABLE_WITNESS` and `UNSUPPORTED_RISK_JUDGMENT` reject it.
- `test-cover-unreachable`: outputs the same confident triple without the available cover needed by its selected avoidable-contact argument; the same gates reject it.

Those gates prevented unsupported experimental conclusions from becoming accepted teaching. Passing a safety gate and being professionally correct remain different claims.

## The six-input split is not a strong family holdout

The dataset was frozen before first calls, and no identical input crosses the declared groups. However, **distinct group strings do not prove distinct tactical families**:

- `test-current-vision-avoidable` retains the development avoidable-contact check pattern while changing counts, position and duration.
- `test-multiple-supported-options` retains the development supported-trade family while changing cover and other parameters.

The generation model's two test primary successes occur precisely on those two related-family cases. The six-input result is therefore a **pre-frozen parameter/condition test**, including two related-family regressions, not convincing unseen-family generalization. Keep the original six-input metric and failed examples intact.

As a **post-hoc conservative audit only**, the four other conditions—urgent objective, unreachable cover, conflicting user counts, and historical/sound information—produce zero primary successes for each of old Jev, new Jev and the generation model. This four-case view was not a newly preregistered metric and must not replace the original denominator or become another selected “test set.” There was no relabeling or rerun after observing these results.

## Rule proxy audit

The saved rule outputs were individually revalidated against their frozen packets and all three author acceptance sets:

| Rule proxy | Gate-valid | All three author sets hit | Non-abstaining primary |
| --- | ---: | ---: | ---: |
| Development | 3/3 | 3/3 | 2/3 |
| Six-input test | 6/6 | 6/6 | 3/6 |

The rules are a deterministic proxy over the same designed premise vocabulary. Their agreement with author-created expectations demonstrates internal consistency, **not** a coach-validated 100% accuracy result. The model arms have not demonstrated added quality beyond this restricted proxy on these inputs. The current production baseline remains RULE; the factual RETURN_AND_FIRE path still cannot be promoted to a strong contact/tactical judgment merely because a richer projection exists.

## What the design can and cannot explain

The new arm changes observation semantics **and** replaces the old question expansion with a six-question joint-witness protocol. This is a combined intervention. Any differences cannot be attributed solely to space, modality preservation, prompt count, or witness structure.

The generation model's old protocol was not rerun as a same-batch arm on these same frozen inputs. Earlier runs differ in packets, timing and protocol. Therefore the new generation results do not constitute a single-factor before/after improvement estimate either. Model-native Jev probabilities and generation-model self-reported probabilities also retain different meanings.

Only three development and six parameter/condition cases were measured, in fixed call order. Reliable population accuracy, confidence calibration, p95/p99 latency, professional coaching benefit and production acceptance thresholds cannot be inferred. The measured resource reduction is an operational observation, not the primary outcome.

## Disposition

Retain the negative Jev result, the complete frozen artifacts and the rejected diagnostics. Do not tune on the observed six-input test and rerun it as if still unseen. No further calls are needed to establish the outcome of this trial. Keep default rule behavior and contact/evidence protections unchanged. Any stronger professional-quality claim requires independent coach labels and a genuinely distinct evaluation design; neither successful builds nor the four proxy generation successes provide that evidence.

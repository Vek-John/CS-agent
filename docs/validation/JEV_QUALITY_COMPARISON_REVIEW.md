# Independent quality-comparison review

Date: 2026-09-23. Read-only review of `JEV_PAIRED_SYNTHETIC_LIVE.json`, `JEV_GENERATION_DEADLINE_DIAGNOSTIC.json`, the deadline diagnostic script, and the current provider protocol. No remote requests, large Demo reads, credential reads, or product edits were performed by this reviewer.

## Conclusion supported by the measurements

**No improvement in professional decision quality has been established.** Under this particular same-packet synthetic test and 3-second configuration, Jev produced more parseable responses before the deadline than the configured generation comparator. Both supplied zero new, gate-valid affirmative tactical judgments. This supports a narrow operational observation about this configuration; it does not support a general claim that Jev is more accurate, a better CS2 coach, or reliably faster in other workloads.

The corpus contains 11 rows but only **9 distinct input packets per provider**, in 6 synthetic Demo groups. Two rows are cached outcome counterfactual reuses, not independent model calls. Comparisons below deduplicate by packet fingerprint. Labels are `SYNTHETIC_AUTHOR_EXPECTATION`, authored for engineering regression, with **zero coach gold labels**.

| 3-second stage | Rule proxy | Jev | Generation comparator |
| --- | ---: | ---: | ---: |
| Distinct packets | 9 | 9 | 9 |
| Parseable outputs | 9 | 9 | 4 |
| Deterministic validator passes | 9 | 4 | 4 |
| Gate-valid affirmative tactical judgments | Rule-derived only | 0 | 0 |
| Accepted model outputs | N/A | All 4 are UNKNOWN / INSUFFICIENT | All 4 are UNKNOWN / INSUFFICIENT |
| Timeouts | N/A | 0 | 5 |

Jev's raw risk category agrees with the author set on 8/9 distinct packets, but the five nonpassing outputs remain rejected. On `bad-choice-good-result` it says `WARRANTED` where the author expectation is `UNWARRANTED`; the counterfactual reuse is the same response, not another model error. All nine Jev outputs mark context insufficient, including the five that nevertheless choose a positive risk category. Counting those as useful coaching would ignore the acceptance gate. The generation comparator's 4/4 agreement among parsed responses cannot be compared to Jev's 8/9 as accuracy: its other five cases are missing because of timeout.

Jev completed in 395–2,272 ms, with descriptive median 501 ms in this run. The generation comparator's four completed responses took 1,785–2,271 ms; five were terminated around 3 seconds. Those timeout observations are **right-censored**, not measured model completion times. Do not use approximately 3,000 ms as a completed-response tail latency or treat nine calls as enough for reliable p95/p99 estimates. Model-native structured output versus generated JSON, the 2,400-token generation cap, and provider-specific protocols remain material comparison differences.

## Separate 10-second diagnostic

The follow-up contains only the **five generation timeouts selected from the first stage**. It is an explicitly selected diagnostic, not another independent random five-case benchmark and not a changed production timeout:

- 3/5 parseable outputs; 2/5 validator passes, both UNKNOWN / INSUFFICIENT.
- 1 parsed `WARRANTED` / `INSUFFICIENT` output rejected by validation.
- 2 `UPSTREAM_FINISH` failures at the 2,400-token output cap.
- Response durations 4,481–6,265 ms; generation cost remains unknown.

Do not pool these durations with the original 3-second stage, replace the original failures in-place, or label a combination as a uniformly timed nine-case run. A clearly named two-stage completion diagnostic is possible, but it incurs five additional calls and selection/retry effects. No prompt, token or threshold tuning should be inferred from this audit. The added runtime still did not produce an accepted affirmative tactical judgment.

## Real-input comparison boundary

The completed [JEV_EXISTING_MODEL_COMPARISON.json](JEV_EXISTING_MODEL_COMPARISON.json) was subsequently read and checked against the historical [JEV_RETURN_FIRE_LIVE.json](JEV_RETURN_FIRE_LIVE.json). It reports PASS and five exact canonical-body hash matches. All five historical Jev choice triples match the historical report; five new generation calls all succeeded with UNKNOWN / UNKNOWN / INSUFFICIENT, exactly matching the restricted rule proxy and historical Jev choices. The pre-experiment teaching assessment was `NO_TEACHING_VALUE` for all five inputs. Thus this comparison shows agreement on abstention and a possible difference in how uncertainty is surfaced, not new justified tactical judgments or a measured increase in teaching value.

The report keeps historical Jev timing and current generation timing separate: their descriptive medians are 461 ms and 1,814 ms, measured at different times. These are not a contemporaneous randomized latency experiment and must not become a universal speedup ratio. Historical Jev summaries also lack full probabilities and citations, so cross-provider calibration/citation-quality equivalence cannot be audited from this artifact. The one-Demo parse and recovery had eight eligible packets, of which five matched the historical requests; those are correlated inputs from one Demo, not five independent matches or expert labels.

RETURN_AND_FIRE v3 deliberately permits only UNKNOWN / UNKNOWN / INSUFFICIENT while contact is unverified. Agreement on that forced refusal tests compliance with the boundary, not improved tactical judgment. The current comparison added **five generation requests and zero Jev requests**. Across this entire comparison exercise, new calls total **28 = 9 Jev synthetic + 9 generation at 3 seconds + 5 generation timeout diagnostics + 5 real-input generation**. The five historical Jev calls are reused evidence and are not counted again. This reviewer checked saved summaries only and made no calls.

## Script audit and repaired finding

One actionable P2 was found at `tools/compare-jev-deadlines.ts:22`: the initial output-path check validated the parent directory but followed an existing output symlink at `writeFileSync`, allowing a worktree-named output to overwrite a file elsewhere. The owner added `existsSync(outputPath)` plus `owned(realpathSync(outputPath))`; review confirmed that fix. The actual report path was a normal newly created worktree file, so this defect does not invalidate recorded measurements. **P2 closed; no other open actionable P1/P2 found in the reviewed script.**

The script caps the selected set at five original remote-call timeout rows, checks each packet fingerprint against the current fixture, checks the configured generation model, and bounds execution by 10 minutes. The final transport asserts the fixed generation endpoint, same legal state/questions, model and remote-call cap. Outcomes and author labels remain local. Only explicitly named key/model settings are parsed; credentials are not included in output, request telemetry or argv. The script does not change product settings. Strict standalone TypeScript checking passed:

```sh
pnpm exec tsc --ignoreConfig --noEmit --target ES2022 --module esnext \
  --moduleResolution bundler --skipLibCheck --esModuleInterop --strict \
  --types node --allowImportingTsExtensions tools/compare-jev-deadlines.ts
```

A future professional-quality claim still needs independent coach labels, held-out Demo groups, adequate sample size, and coverage/error tradeoffs measured together. These synthetic author expectations and small censored runs cannot supply that evidence.

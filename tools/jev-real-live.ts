/** Private-process real-Demo probe. Never serialize a CandidateSet, binding, key or packet. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import type { CandidateMaterial, DecisionAssessmentArtifact, NarrationResult, TeachingCandidate } from "../libs/contracts/src/index.ts";
import type { Cs2dAnalysisBundle } from "../libs/cs2d-analysis-adapter/src/index.ts";
import {
  assertValidNarrationBundle, assertValidReviewPlan, buildDecisionAssessmentPacket, buildDirectorRequest,
  deterministicDirectorFallback, deterministicNarrationBundle, parseDecisionAssessmentPacket, resolveDecisionAssessment,
} from "../libs/review-planner/src/index.ts";
import { createCs2dReviewPreparationDependencies } from "../apps/web/lib/coaching/cs2d-route-integration.ts";
import { requestDecisionAssessments } from "../apps/web/lib/coaching/decision-assessment-host.ts";
import { assessWithJev, buildJevHttpBody, type DecisionProviderAttempt } from "../apps/web/lib/coaching/jev-decision-assessment.ts";

const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");
const emptyUsage = () => ({ inputTokens: null, outputTokens: null, costUsd: null });
const safeCode = (value: string | undefined) => value && /^[A-Z][A-Z0-9_]{0,79}$/.test(value) ? value : "UNSPECIFIED";

/** Key input is deliberately not an env/argv/config fallback. The caller supplies a no-echo pipe. */
export async function readJevKeyLine(input: NodeJS.ReadableStream, timeoutMs = 60_000): Promise<string> {
  return new Promise((resolve, reject) => {
    let bytes = Buffer.alloc(0), settled = false;
    const finish = (key?: string) => {
      if (settled) return; settled = true;
      clearTimeout(timer); input.removeListener("data", onData); input.removeListener("end", onEnd); input.removeListener("error", onEnd);
      bytes.fill(0); bytes = Buffer.alloc(0); input.pause();
      if (key) resolve(key); else reject(new Error("INVALID_OR_MISSING_STDIN_KEY"));
    };
    const onData = (chunk: Buffer | string) => {
      const part = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      if (bytes.length + part.length > 514) return finish();
      const next = Buffer.concat([bytes, part]); bytes.fill(0); bytes = next;
      const newline = bytes.indexOf(10);
      if (newline < 0) return;
      const key = bytes.subarray(0, newline > 0 && bytes[newline - 1] === 13 ? newline - 1 : newline).toString("utf8");
      finish(key.length > 0 && key.length <= 512 && key.trim() === key && !/[\u0000-\u001f\u007f]/u.test(key) ? key : undefined);
    };
    const onEnd = () => finish();
    const timer = setTimeout(onEnd, timeoutMs);
    input.on("data", onData); input.once("end", onEnd); input.once("error", onEnd);
  });
}

/** Future-only counterfactual mutations never alter the legal body or cache identity. */
export function auditRealOutcomeIndependence(candidate: TeachingCandidate, material: CandidateMaterial, options: { mapName: string; tickRate: number; playerId: string }) {
  const original = buildDecisionAssessmentPacket(candidate, material, options);
  if (!original.packet || !original.binding) return false;
  const expected = JSON.stringify(buildJevHttpBody(original.packet));
  for (const death of [true, false]) {
    const changedCandidate: TeachingCandidate = { ...candidate, revealTick: candidate.revealTick + 20, outcomeEnd: candidate.outcomeEnd + 40,
      resultSummary: { ...candidate.resultSummary, selectedPlayerDeath: death, winProbabilityAfter: death ? 0.01 : 0.99 } };
    const changedMaterial: CandidateMaterial = { ...material, outcomeFacts: [{ id: "counterfactual-outcome-only", text: death ? "LOSS_DEATH" : "WIN_SURVIVAL",
      availableAtTick: candidate.outcomeEnd + 40, source: "DEMO", outcomeKind: death ? "DEATH" : "KILL", evidenceRefs: [], limitations: [] }] };
    const changed = buildDecisionAssessmentPacket(changedCandidate, changedMaterial, options);
    assert(changed.packet); assert.equal(changed.binding?.packetFingerprint, original.binding.packetFingerprint);
    assert.equal(JSON.stringify(buildJevHttpBody(changed.packet)), expected);
  }
  return true;
}

export function createRealJevProbe(options: { apiKey: string; maxCalls: number; fetcher?: typeof fetch; onTelemetry?: (summary: Record<string, unknown>) => void }) {
  if (!Number.isInteger(options.maxCalls) || options.maxCalls < 1 || options.maxCalls > 5) throw new Error("INVALID_REMOTE_BUDGET");
  let apiKey = options.apiKey;
  const fetcher = options.fetcher ?? fetch;
  const cache = new Map<string, DecisionProviderAttempt>();
  const rows: Array<Record<string, unknown>> = [];
  let attempts = 0, remoteCalls = 0, deduplicated = 0, budgetSkipped = 0, accepted = 0;
  let directorConsumed = 0, cueArtifacts = 0, narratorConsumed = 0, restoredNarrations = 0, restoredArtifactReads = 0, restorationAssessmentCalls = 0, counterfactualChecks = 0;
  const latencies: number[] = [];
  function summary() {
    const sorted = [...latencies].sort((a, b) => a - b);
    const quantile = (p: number) => sorted.length ? sorted[Math.max(0, Math.ceil(sorted.length * p) - 1)]! : null;
    return { execution: "LIVE_JEV" as const, requestedMode: "JEV_EXPERIMENT", acceptance: "TEST_ONLY", maxCalls: options.maxCalls,
      attempts, remoteCalls, deduplicated, budgetSkipped, accepted, directorConsumed, cueArtifacts, narratorConsumed,
      restoredNarrations, restoredArtifactReads, restorationAssessmentCalls, counterfactualChecks,
      directorProvider: "DETERMINISTIC_FALLBACK", narratorProvider: "DETERMINISTIC_FALLBACK",
      latencyMs: { samples: sorted.length, p50: quantile(0.5), p95: null, p99: null, reliableTailEstimate: false },
      requestRecords: [...rows] };
  }
  const emit = () => options.onTelemetry?.(summary());
  async function assessPacket(input: unknown, signal?: AbortSignal): Promise<DecisionProviderAttempt> {
    const packet = parseDecisionAssessmentPacket(input);
    const expectedBody = JSON.stringify(buildJevHttpBody(packet));
    const bodySha256 = sha256(expectedBody);
    const cached = cache.get(bodySha256);
    if (cached) { deduplicated++; return cached; }
    if (attempts >= options.maxCalls) { budgetSkipped++; return { status: "FALLBACK", reason: "GLOBAL_REAL_SMOKE_BUDGET", latencyMs: 0, usage: emptyUsage() }; }
    attempts++;
    const attempt = await assessWithJev(packet, { JEV_API_KEY: apiKey }, { signal, timeoutMs: 2500, fetcher: async (url, init) => {
      assert.equal(String(url), "https://api.typesafe.ai/v1/systemone"); assert.equal(init?.method, "POST");
      const serialized = String(init?.body);
      assert.equal(serialized, expectedBody);
      const finalBody = JSON.parse(serialized);
      assert.deepEqual(Object.keys(finalBody).sort(), ["model", "questions", "state"]);
      assert.deepEqual(parseDecisionAssessmentPacket(finalBody.state), packet);
      assert.equal(remoteCalls < options.maxCalls, true); remoteCalls++; emit();
      return fetcher(url, init);
    } });
    cache.set(bodySha256, attempt); latencies.push(attempt.latencyMs);
    const result = attempt.result ?? attempt.diagnosticResult;
    const body = buildJevHttpBody(packet);
    rows.push({ requestNumber: attempts, bodySha256, stateSha256: sha256(JSON.stringify(packet)), bodyBytes: Buffer.byteLength(expectedBody),
      whitelistPassed: true, topLevelFields: Object.keys(body).sort(), stateFields: Object.keys(packet).sort(), actionFields: Object.keys(packet.action).sort(),
      questionCount: Object.keys(body.questions).length, projectionVersion: packet.projectionVersion, questionVersion: packet.questionVersion,
      scenario: packet.scenario, requestedModel: body.model, returnedModel: result?.model ?? null,
      status: attempt.status, reason: attempt.reason ? safeCode(attempt.reason) : null, rejectionReasons: (attempt.rejectionReasons ?? []).map(safeCode),
      choices: result ? { riskWarranted: result.riskWarranted.choice, alternativePreferable: result.alternativePreferable.choice, contextSufficient: result.contextSufficient.choice } : null,
      modelConfidence: result ? Math.min(result.riskWarranted.confidence, result.alternativePreferable.confidence, result.contextSufficient.confidence) : null,
      latencyMs: attempt.latencyMs, usage: attempt.usage });
    emit(); return attempt;
  }
  async function prepare(bundle: Cs2dAnalysisBundle) {
    for (const candidate of bundle.candidate_set.candidates) {
      const material = bundle.candidate_set.materials.find(m => m.candidateId === candidate.candidateId);
      if (material && auditRealOutcomeIndependence(candidate, material, { mapName: bundle.match_timeline.map_name, tickRate: bundle.match_timeline.tick_rate, playerId: bundle.selected_steam_id })) counterfactualChecks++;
    }
    const analysis = { candidateSet: bundle.candidate_set, observationEvidence: bundle.observation_evidence,
      matchTimeline: bundle.match_timeline, winProbabilityTimeline: bundle.win_probability_timeline, selectedPlayerId: bundle.selected_steam_id };
    let expectedArtifact: DecisionAssessmentArtifact | undefined;
    let restoring = false;
    const deterministicNarrator: NonNullable<Parameters<typeof createCs2dReviewPreparationDependencies>[1]>["narrator"] = async context => {
      const narration = deterministicNarrationBundle(context.coachingPackage, context.outcomePackage);
      assertValidNarrationBundle(narration, context.coachingPackage, context.outcomePackage);
      const outcomeRefs = new Set([...context.outcomePackage.outcomeFacts.map(f => f.id), ...context.outcomePackage.deathKillHpRefs, ...context.outcomePackage.measurementRefs]);
      assert(context.coachingPackage.allowedRefs.decision.every(ref => !outcomeRefs.has(ref)));
      assert(narration.coreIssue.refs.every(ref => !outcomeRefs.has(ref)));
      if (expectedArtifact?.status === "ACCEPTED") {
        assert.deepEqual(context.coachingPackage.decisionAssessment, expectedArtifact);
        assert(context.coachingPackage.assessment);
        assert(narration.coreIssue.text.includes(context.coachingPackage.assessment.explanation));
        const candidate = bundle.candidate_set.candidates.find(c => c.candidateId === expectedArtifact!.binding.candidateId)!;
        const material = bundle.candidate_set.materials.find(m => m.candidateId === candidate.candidateId)!;
        const built = buildDecisionAssessmentPacket(candidate, material, expectedArtifact.binding);
        assert(built.packet);
        if (built.packet.action.kind === "RETURN_AND_FIRE") {
          assert.equal(expectedArtifact.result?.riskWarranted.choice, "UNKNOWN");
          assert.equal(expectedArtifact.result?.alternativePreferable.choice, "UNKNOWN");
          assert.equal(expectedArtifact.result?.contextSufficient.choice, "INSUFFICIENT");
          assert.equal(context.coachingPackage.assessment.kind, "INSUFFICIENT_EVIDENCE");
          assert.match(narration.coreIssue.text, /不能确认.*接敌/);
        }
        if (restoring) restoredArtifactReads++; else narratorConsumed++;
      }
      return { status: "FALLBACK", bundle: narration, manifest: { status: "FALLBACK", provider: "DETERMINISTIC", limitations: ["REAL_SMOKE_NO_GENERATION_MODEL"] } } satisfies NarrationResult;
    };
    const local: typeof fetch = async (_url, init) => init?.method === "POST"
      ? Response.json(await assessPacket(JSON.parse(String(init.body)), init.signal ?? undefined))
      : Response.json({ mode: "JEV_EXPERIMENT", acceptance: "TEST_ONLY" });
    const dependencies = createCs2dReviewPreparationDependencies(analysis, {
      assessDecisions: (set, opts) => requestDecisionAssessments(set, { ...opts, fetcher: local }),
      director: async set => {
        const acceptedIds = new Set(set.candidates.filter(c => c.decisionAssessment?.status === "ACCEPTED").map(c => c.candidateId));
        for (const summary of buildDirectorRequest(set).candidates.filter(c => acceptedIds.has(c.candidateId))) {
          const candidate = set.candidates.find(c => c.candidateId === summary.candidateId)!;
          const material = set.materials.find(m => m.candidateId === summary.candidateId)!;
          const expected = resolveDecisionAssessment(candidate, material);
          assert(expected); assert.deepEqual(summary.assessment, expected); directorConsumed++;
        }
        return deterministicDirectorFallback(set, "REAL_SMOKE_DETERMINISTIC_DIRECTOR");
      }, narrator: deterministicNarrator,
    });
    const signal = new AbortController().signal;
    const request = { generationId: "real-smoke", inputPlan: bundle.review_plan, signal };
    const plan = await dependencies.prepareRoute(request);
    assert.equal(await dependencies.prepareRoute(request), plan);
    assertValidReviewPlan(bundle.match_timeline, plan);
    accepted += plan.decision_assessment_run?.accepted ?? 0;
    const restoredPlan = JSON.parse(JSON.stringify(plan));
    assertValidReviewPlan(bundle.match_timeline, restoredPlan);
    const beforeRestore = remoteCalls;
    const restored = createCs2dReviewPreparationDependencies(analysis, {
      assessDecisions: async () => { restorationAssessmentCalls++; throw new Error("RESTORE_REASSESSMENT_FORBIDDEN"); },
      narrator: deterministicNarrator,
      director: async set => deterministicDirectorFallback(set, "RESTORE_DIRECTOR_MUST_NOT_RUN"),
    });
    for (const cue of plan.cues) {
      const hasArtifact = cue.decisionAssessment?.status === "ACCEPTED";
      if (hasArtifact) cueArtifacts++;
      expectedArtifact = cue.decisionAssessment; restoring = false;
      const narrationRequest = { generationId: "real-smoke", cueId: cue.id, candidateId: cue.candidate_id!, primaryFocusCode: cue.primary_focus_code!,
        routeFingerprint: plan.compiler_provenance?.route_fingerprint ?? "", cue, signal };
      await dependencies.prepareNarration(narrationRequest);
      restoring = true;
      await restored.prepareNarration({ ...narrationRequest, cue: restoredPlan.cues.find((c: { id: string }) => c.id === cue.id)! });
      restoredNarrations++;
    }
    assert.equal(remoteCalls, beforeRestore); assert.equal(restorationAssessmentCalls, 0); emit();
    return plan;
  }
  return { prepare, assessPacket, summary, dispose: () => { apiKey = ""; cache.clear(); } };
}

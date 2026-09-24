import { DECISION_ASSESSMENT_VERSIONS as V, type CandidateSet, type DecisionAssessmentPacket, type DecisionAssessmentArtifact, type DecisionAssessmentMode, type ReviewPlan } from "@cs-coach/contracts";
import { assessCandidateTeaching, buildDecisionAssessmentPacket, resolveDecisionAssessment, validateDecisionAssessmentResult } from "@cs-coach/review-planner";
import type { DecisionProviderAttempt } from "./jev-decision-assessment";

export interface DecisionAssessmentRun {
  version: "decision-assessment-run.v1";
  mode: DecisionAssessmentMode;
  calls: number;
  accepted: number;
  records: readonly { candidateId: string; reason: string; artifact?: DecisionAssessmentArtifact }[];
}
export interface AssessmentPreparation { candidateSet: CandidateSet; run: DecisionAssessmentRun }
export interface AssessmentHostOptions {
  mapName: string; tickRate: number; signal?: AbortSignal; fetcher?: typeof fetch; endpoint?: string;
  /** Evaluation budget after configuration; defaults to 6000ms, including local JSON decoding. */
  sessionTimeoutMs?: number;
}
const MAX_SESSION_REQUESTS = 10;
const MAX_CONCURRENT_REQUESTS = 2;
const SESSION_TIMEOUT_MS = 6000;
function cancelled(signal?: AbortSignal) { if (signal?.aborted) throw new DOMException("Preparation cancelled", "AbortError"); }

/** Bound localhost transport and JSON decoding as well as the upstream request. */
async function localJson(fetcher: typeof fetch, endpoint: string, init: RequestInit, signal: AbortSignal | undefined, timeoutMs: number): Promise<unknown> {
  cancelled(signal);
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  const stop = new Promise<never>((_resolve, reject) => {
    onAbort = () => { controller.abort(); reject(new DOMException("Preparation cancelled", "AbortError")); };
    signal?.addEventListener("abort", onAbort, { once: true });
    timer = setTimeout(() => { controller.abort(); reject(new Error("LOCAL_REQUEST_TIMEOUT")); }, timeoutMs);
  });
  try {
    return await Promise.race([(async () => {
      const response = await fetcher(endpoint, { ...init, signal: controller.signal });
      if (!response.ok) throw new Error(`HTTP_${response.status}`);
      return response.json();
    })(), stop]);
  } finally { if (timer) clearTimeout(timer); if (onAbort) signal?.removeEventListener("abort", onAbort); }
}

/** Called once before route freeze. Persisted cue artifacts are resolved locally on restore. */
export async function requestDecisionAssessments(set: CandidateSet, options: AssessmentHostOptions): Promise<AssessmentPreparation> {
  const originalSet = set;
  // New preparation obeys current mode; frozen history is consumed by its separate restore path.
  if (set.candidates.some(c => c.decisionAssessment) || set.materials.some(m => m.decisionAssessment)) {
    const materials = set.materials.map(({ decisionAssessment: _assessment, ...material }) => material);
    const candidates = set.candidates.map(({ decisionAssessment: _assessment, ...candidate }) => {
      const material = materials.find(m => m.candidateId === candidate.candidateId)!;
      return { ...candidate, assessment: assessCandidateTeaching(candidate, material) };
    });
    set = { ...set, candidates, materials };
  }
  const run: DecisionAssessmentRun = { version: "decision-assessment-run.v1", mode: "RULE_BASELINE", calls: 0, accepted: 0, records: [] };
  const records: Array<DecisionAssessmentRun["records"][number]> = [];
  const output = () => ({ candidateSet: set, run: { ...run, records } });
  cancelled(options.signal);
  const fetcher = options.fetcher ?? fetch;
  const endpoint = options.endpoint ?? "/api/coaching/assess-decision";
  let config: { mode: DecisionAssessmentMode; acceptance: "DISABLED" | "TEST_ONLY" };
  try {
    config = await localJson(fetcher, endpoint, { cache: "no-store" }, options.signal, 750) as typeof config;
    if (!config || typeof config !== "object") return output();
    if (!["JEV_SHADOW", "JEV_EXPERIMENT"].includes(config.mode)) return output();
    run.mode = config.mode;
  } catch { cancelled(options.signal); return output(); }
  const artifacts = new Map<string, DecisionAssessmentArtifact>();
  type Job = { packet: DecisionAssessmentPacket; attempt?: DecisionProviderAttempt; reason?: string };
  const jobs = new Map<string, Job>();
  const controller = new AbortController();
  const abort = () => controller.abort();
  options.signal?.addEventListener("abort", abort, { once: true });
  const requestedTimeout = options.sessionTimeoutMs ?? SESSION_TIMEOUT_MS;
  const timeoutMs = Number.isFinite(requestedTimeout) ? Math.max(0, requestedTimeout) : SESSION_TIMEOUT_MS;
  const deadline = performance.now() + timeoutMs;
  let expired = false;
  const expire = () => { expired = true; controller.abort(); };
  const outOfTime = () => {
    if (!expired && performance.now() >= deadline) expire();
    return expired;
  };
  const timer = setTimeout(expire, timeoutMs);
  // Group only projected packets, keeping each candidate's references and binding local.
  // A duplicate joins the same job even while it is in flight or after the call budget is used.
  try {
    const entries = set.candidates.map(candidate => {
      cancelled(options.signal);
      const material = set.materials.find(m => m.candidateId === candidate.candidateId)!;
      const built = buildDecisionAssessmentPacket(candidate, material, { mapName: options.mapName, tickRate: options.tickRate, playerId: set.playerId });
      const existing = originalSet.materials.find(m => m.candidateId === candidate.candidateId)?.decisionAssessment ?? originalSet.candidates.find(c => c.candidateId === candidate.candidateId)?.decisionAssessment;
      let job: Job | undefined;
      const saved = built.binding && existing?.binding.packetFingerprint === built.binding.packetFingerprint ? existing : undefined;
      if (built.packet && built.binding && !saved) {
        job = jobs.get(built.binding.packetFingerprint);
        if (!job) {
          job = { packet: built.packet };
          jobs.set(built.binding.packetFingerprint, job);
        }
      }
      return { candidate, material, built, saved, job };
    });
    const queue = [...jobs.values()];
    let nextJob = 0;
    const work = async () => {
      while (nextJob < queue.length) {
        cancelled(options.signal);
        const job = queue[nextJob++]!;
        if (outOfTime()) { job.reason = "SESSION_TIME_BUDGET"; continue; }
        if (run.calls >= MAX_SESSION_REQUESTS) { job.reason = "SESSION_REQUEST_BUDGET"; continue; }
        run.calls++;
        try {
          const attempt = await localJson(fetcher, endpoint, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(job.packet) }, controller.signal, 3500) as DecisionProviderAttempt;
          cancelled(options.signal);
          if (outOfTime()) throw new Error("SESSION_TIME_BUDGET");
          if (!attempt || typeof attempt !== "object") throw new Error("INVALID_RESPONSE");
          job.attempt = attempt;
        } catch {
          cancelled(options.signal);
          job.attempt = { status: "FALLBACK", reason: outOfTime() ? "SESSION_TIME_BUDGET" : "REQUEST_FAILED", latencyMs: 0, usage: { inputTokens: null, outputTokens: null, costUsd: null } };
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(MAX_CONCURRENT_REQUESTS, queue.length) }, work));
    cancelled(options.signal);
    // Completion order never changes the candidate order or the per-candidate acceptance gates.
    for (const { candidate, material, built, saved, job } of entries) {
      if (!built.packet || !built.binding) { records.push({ candidateId: candidate.candidateId, reason: built.rejectionReasons.join(",") || "UNSUPPORTED" }); continue; }
      if (saved) {
        records.push({ candidateId: candidate.candidateId, reason: "SAVED_ARTIFACT_REUSED", artifact: saved });
        if (saved.status === "ACCEPTED" && saved.mode === config.mode && config.acceptance === "TEST_ONLY" && resolveDecisionAssessment(candidate, { ...material, decisionAssessment: saved })) { artifacts.set(candidate.candidateId, saved); run.accepted++; }
        continue;
      }
      if (!job?.attempt) { records.push({ candidateId: candidate.candidateId, reason: job?.reason ?? "SESSION_TIME_BUDGET" }); continue; }
      const attempt = job.attempt;
      const auditedResult = attempt.result ?? attempt.diagnosticResult;
      const checked = auditedResult ? validateDecisionAssessmentResult(built.packet, auditedResult) : undefined;
      let accepted = attempt.status === "SUCCEEDED" && checked?.valid === true && config.mode === "JEV_EXPERIMENT" && config.acceptance === "TEST_ONLY";
      const artifact: DecisionAssessmentArtifact = {
        version: V.artifact, mode: config.mode, provider: "JEV", acceptancePolicyVersion: V.acceptance,
        acceptance: config.acceptance === "TEST_ONLY" ? "TEST_ONLY" : "DISABLED",
        status: accepted ? "ACCEPTED" : checked?.valid ? "SHADOW" : attempt.status === "FALLBACK" ? "FALLBACK" : "REJECTED",
        binding: built.binding, ...(auditedResult ? { result: auditedResult } : {}),
        modelConfidence: checked?.modelConfidence ?? null, evidenceConfidence: checked?.evidenceConfidence ?? 0,
        rejectionReasons: checked?.valid ? accepted ? [] : ["UNCALIBRATED_SHADOW_ONLY"] : checked?.rejectionReasons ?? [attempt.reason ?? "INVALID_RESPONSE"],
        latencyMs: Number.isFinite(attempt.latencyMs) ? attempt.latencyMs : 0,
        usage: attempt.usage ?? { inputTokens: null, outputTokens: null, costUsd: null }
      };
      if (accepted && !resolveDecisionAssessment(candidate, { ...material, decisionAssessment: artifact })) {
        accepted = false;
        artifact.status = "REJECTED";
        artifact.rejectionReasons = [...artifact.rejectionReasons, "EVIDENCE_ACCEPTANCE_GATE"];
      }
      records.push({ candidateId: candidate.candidateId, reason: artifact.status, artifact });
      if (accepted) { artifacts.set(candidate.candidateId, artifact); run.accepted++; }
    }
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", abort);
    controller.abort();
  }
  cancelled(options.signal);
  // Candidate identity/hash remain the canonical nomination identity. Assessments
  // are derived inference overlays, persisted with the compiled cue/run, not a reparse.
  return { candidateSet: artifacts.size ? { ...set,
    candidates: set.candidates.map((c) => artifacts.has(c.candidateId) ? { ...c, decisionAssessment: artifacts.get(c.candidateId) } : c),
    materials: set.materials.map((m) => artifacts.has(m.candidateId) ? { ...m, decisionAssessment: artifacts.get(m.candidateId) } : m)
  } : set, run: { ...run, records } };
}

/** Saved plans never invoke the provider; this is an artifact inspection helper. */
export function decisionAssessmentRun(plan: ReviewPlan): DecisionAssessmentRun | undefined { return plan.decision_assessment_run; }

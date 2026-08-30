import "./cloudflare-async-context.mjs";
import {
  createCoachAgentRuntime,
  parseRemoteCoachAgentDispatchEnvelope,
  parseRemoteCoachAgentDispatchResponse,
  DurableObjectCheckpointSaver,
} from "../libs/coach-agent/src/index.ts";
import { createDeepSeekCoachPolicyAdapter } from "../apps/web/lib/coaching/deepseek-coach-policy.ts";
import { hmacSha256Base64Url, verifyHmacSha256Base64Url } from "../apps/web/lib/memory/principal.ts";
import { MemoryOutbox } from "./memory-outbox.mjs";

// Keep the worker/runtime package boundary explicit.  The root package is not
// a consumer of every workspace library, so standalone Vitest runs use the
// source fallback while Cloudflare/OpenNext resolves @cs-coach/memory.
const memoryModule = await import("@cs-coach/memory")
  .catch(() => import("../libs/memory/src/index.ts"));

const MAX_REMOTE_REQUEST_BYTES = 64 * 1024;
const POLICY_ROUTE_TIMEOUT_MS = 15_000;
const MEMORY_BRIEF_TIMEOUT_MS = 250;
const MEMORY_BRIEF_MAX_BYTES = 16 * 1024;
const DEFAULT_MEMORY_OUTBOX_MAX_RETAINED = 256;
const DEFAULT_MEMORY_OUTBOX_PRUNE_BATCH = 100;
const MEMORY_OWNER_KEY = "coach-agent:memory-owner:v1";
const MEMORY_ENDPOINT_KEY = "coach-agent:memory-endpoint:v1";
const MEMORY_CONSENT_KEY = "coach-agent:memory-consent:v1";
const MEMORY_BRIEF_REFRESH_KEY = "coach-agent:memory-brief-refresh:v1";
const MEMORY_INVALIDATE_PATH = "/api/coaching/agent/memory-invalidate";
const MEMORY_INTERNAL_SIGNATURE_HEADER = "x-memory-signature";
const MEMORY_INTERNAL_TIMESTAMP_HEADER = "x-memory-timestamp";

export const MEMORY_ENABLED_ENV_KEY = "MEMORY_ENABLED";
export const TRUSTED_PRINCIPAL_HEADER = "x-cs-trusted-principal";
export const TRUSTED_CONSENT_HEADER = "x-cs-memory-consent";
export const TRUSTED_CONSENT_VERSION_HEADER = "x-cs-memory-consent-version";
export const MEMORY_BRIEF_HEADER = "x-cs-memory-brief";
export const MEMORY_OUTBOX_OWNER_KEY = MEMORY_OWNER_KEY;
export const MEMORY_OUTBOX_ENDPOINT_KEY = MEMORY_ENDPOINT_KEY;
export const MEMORY_OUTBOX_CONSENT_KEY = MEMORY_CONSENT_KEY;
export const MEMORY_OUTBOX_INVALIDATE_PATH = MEMORY_INVALIDATE_PATH;
export const MEMORY_PRODUCER_VERSION = "coach-agent-memory.v1";

const PRINCIPAL_HEADERS = [
  TRUSTED_PRINCIPAL_HEADER,
  "x-cs-memory-principal",
  "x-memory-principal",
  "x-internal-user-id",
];
const CONSENT_HEADERS = [
  TRUSTED_CONSENT_HEADER,
  "x-memory-consent",
  "x-trusted-memory-consent",
];

function envBoolean(value) {
  if (value === true) return true;
  if (typeof value !== "string") return false;
  return ["1", "true", "on"].includes(value.trim().toLowerCase());
}

async function internalAuthHeaders(env, rawBody = "", base = {}) {
  const headers = new Headers(base);
  const token = typeof env?.MEMORY_INTERNAL_TOKEN === "string" ? env.MEMORY_INTERNAL_TOKEN.trim() : "";
  if (token.length >= 16) {
    headers.set("x-memory-internal-token", token);
    return headers;
  }
  const secret = typeof env?.MEMORY_INTERNAL_HMAC_SECRET === "string"
    ? env.MEMORY_INTERNAL_HMAC_SECRET.trim()
    : "";
  if (secret.length >= 16) {
    const timestamp = String(Date.now());
    headers.set(MEMORY_INTERNAL_TIMESTAMP_HEADER, timestamp);
    headers.set(MEMORY_INTERNAL_SIGNATURE_HEADER, await hmacSha256Base64Url(`${timestamp}.${rawBody}`, secret));
  }
  return headers;
}

function firstHeader(request, names) {
  for (const name of names) {
    const value = request.headers.get(name)?.trim();
    if (value) return value;
  }
  return null;
}

function trustedPrincipalFrom(request) {
  const value = firstHeader(request, PRINCIPAL_HEADERS);
  if (!value || value.length > 160 || /[\u0000-\u001f\u007f]/u.test(value)) return null;
  return value;
}

function consentGrantedFrom(request) {
  const value = firstHeader(request, CONSENT_HEADERS);
  if (!value) return false;
  return ["1", "true", "yes", "on", "granted", "opt_in", "opted_in"].includes(value.toLowerCase());
}

function consentVersionFrom(request) {
  const value = request.headers.get(TRUSTED_CONSENT_VERSION_HEADER)?.trim();
  if (!value) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 && parsed <= 10_000 ? parsed : undefined;
}

function boundedText(value, max = 1_200) {
  if (value === undefined || value === null) return "";
  return String(value).replace(/\s+/g, " ").trim().slice(0, max);
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * A status endpoint can return HTTP 2xx while its backing store is degraded.
 * Only an internally consistent, explicit consent state is authoritative;
 * UNKNOWN/degraded/unavailable payloads must not be interpreted as a revoke.
 */
function parseConsentAuthorityStatus(value) {
  if (!isRecord(value) || typeof value.enabled !== "boolean") return undefined;
  const consent = typeof value.consent === "string" ? value.consent.trim().toUpperCase() : "";
  if (consent !== "GRANTED" && consent !== "REVOKED") return undefined;
  if (typeof value.featureFlag === "boolean" && !value.featureFlag) return undefined;
  if (value.storage !== undefined && value.storage !== null &&
    typeof value.storage === "string" && value.storage.trim().toUpperCase() === "UNAVAILABLE") return undefined;
  if (value.storage !== undefined && value.storage !== null && typeof value.storage !== "string") return undefined;
  if (value.degradedReason !== undefined && value.degradedReason !== null &&
    (typeof value.degradedReason !== "string" || value.degradedReason.trim())) return undefined;
  let consentVersion;
  if (value.consentVersion !== undefined && value.consentVersion !== null) {
    const version = Number(value.consentVersion);
    if (!Number.isSafeInteger(version) || version < 0 || version > 10_000) return undefined;
    consentVersion = version;
  }
  if (consent === "GRANTED" && value.enabled === true) return { granted: true, consentVersion };
  if (consent === "REVOKED" && value.enabled === false) return { granted: false, consentVersion };
  return undefined;
}

function stripClientBriefFromEnvelopeValue(value) {
  if (!isRecord(value) || !isRecord(value.event)) return value;
  const { memoryBrief: _clientBrief, ...event } = value.event;
  void _clientBrief;
  return { ...value, event };
}

function stableToken(value) {
  let hash = 14_695_981_039_346_656_037n;
  const text = String(value);
  for (let index = 0; index < text.length; index += 1) {
    hash ^= BigInt(text.charCodeAt(index));
    hash = BigInt.asUintN(64, hash * 1_099_511_628_211n);
  }
  return hash.toString(16).padStart(16, "0");
}

function memoryIdempotency({ userId, eventType, sessionId, demoContentHash, cueId, revision, logicalKey = "session" }) {
  return `memory-idem-${stableToken([
    userId,
    eventType,
    sessionId,
    demoContentHash,
    cueId,
    revision,
    logicalKey,
  ].join("|"))}`;
}

function memoryEventId(idempotencyKey) {
  return `memory-event-${stableToken(idempotencyKey)}`;
}

function memoryTimestamp() {
  return new Date().toISOString();
}

function jsonBytes(value) {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}

function withoutMemoryIdentity(value) {
  if (Array.isArray(value)) return value.map(withoutMemoryIdentity);
  if (!value || typeof value !== "object") return value;
  // Agent input may contain teaching semantics, but never stable principal,
  // Demo/session/cue identifiers or persistence bookkeeping.  Those values
  // are useful to the Memory Service and management UI, not to a policy model.
  const forbidden = new Set([
    "userId", "principal", "cookie", "rawDemo", "raw_demo", "demoBytes", "demo_bytes", "frames", "ticks",
    "fullReplay", "full_replay", "replay", "tickStream", "tick_stream",
    "prompt", "chainOfThought", "chain_of_thought", "cot", "memoryId", "logicalKey",
    "proposalId", "eventId", "idempotencyKey", "sessionId", "demoContentHash", "cueId",
    "caseId", "threadId", "refId", "previousRevisionId", "lastIdempotencyKey",
    "correctionId", "originReflectionId", "sourceThreadId", "targetMemoryId",
    "evidenceCueIds", "successfulCueIds", "conflictingCueIds", "claimIds", "evidenceRefs",
    "adviceRefs", "refs", "sourceRefs", "demoContentHashes", "supportingRefs", "contradictingRefs",
    "apiKey", "api_key", "secret",
  ]);
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => !forbidden.has(key))
      .map(([key, child]) => [key, withoutMemoryIdentity(child)]),
  );
}

function unwrapMemoryBrief(value) {
  if (isRecord(value) && isRecord(value.brief)) return value.brief;
  return value;
}

function memoryBriefOrUndefined(value) {
  const parsed = memoryModule.MemoryBriefSchema?.safeParse(unwrapMemoryBrief(value));
  if (!parsed?.success) return undefined;
  // A valid schema does not imply a current/eligible projection. Provider or
  // environment briefs can outlive a deletion and may still contain
  // DISPUTED/DELETED records or SESSION-scoped threads. Filter once more at
  // the DO trust boundary before handing anything to the Agent.
  const data = parsed.data;
  const activeStatuses = new Set(["OBSERVED", "REPEATED", "IMPROVING", "STABLE", "EMERGING", "ACTIVE", "CONFIRMED"]);
  const threadStatuses = new Set(["OPEN", "TAUGHT", "UNDERSTOOD", "APPLIED_ONCE", "REPEATED", "STABLE"]);
  const memories = Array.isArray(data.memories)
    ? data.memories.filter((record) => record && record.scope === "CROSS_DEMO" && record.active === true && activeStatuses.has(record.status))
    : [];
  const deletedIds = new Set((Array.isArray(data.memories) ? data.memories : [])
    .filter((record) => record && record.status === "DELETED")
    .map((record) => record.memoryId)
    .filter((id) => typeof id === "string"));
  const sanitized = {
    ...data,
    memories,
    activeThreads: Array.isArray(data.activeThreads)
      ? data.activeThreads.filter((thread) => thread && thread.scope === "CROSS_DEMO" && threadStatuses.has(thread.status))
      : [],
    corrections: Array.isArray(data.corrections)
      // Keep corrections for DISPUTED aggregates (they are the teaching
      // signal), while dropping only corrections explicitly tied to a
      // DELETED record in a stale/provider brief.
      ? data.corrections.filter((correction) => typeof correction.memoryId !== "string" || !deletedIds.has(correction.memoryId))
      : [],
  };
  const projected = typeof memoryModule.buildAgentMemoryBrief === "function"
    ? memoryModule.buildAgentMemoryBrief(sanitized)
    : sanitized;
  const bounded = withoutMemoryIdentity(projected);
  if (jsonBytes(bounded) > MEMORY_BRIEF_MAX_BYTES) return undefined;
  return bounded;
}

function emptyMemoryBrief(reason = "Memory brief unavailable; continuing without long-term memory.") {
  return memoryBriefOrUndefined({
    schemaVersion: "memory-brief.v1",
    generatedAt: memoryTimestamp(),
    activeThreads: [],
    memories: [],
    corrections: [],
    limitations: [boundedText(reason, 240)],
    source: "EMPTY",
    structuredStatus: "UNAVAILABLE",
    semanticStatus: "OPTIONAL",
  });
}

function cueCaseFor(result, cueId) {
  const state = result?.state;
  if (!state || !cueId || !state.cueCases || typeof state.cueCases !== "object") return undefined;
  return state.cueCases[cueId];
}

function learningThreadFor(result, cueId) {
  const threads = result?.state?.learningThreads;
  if (!Array.isArray(threads)) return undefined;
  return threads.find((thread) =>
    Array.isArray(thread?.evidenceCueIds) && thread.evidenceCueIds.includes(cueId),
  ) ?? threads.at(-1);
}

function memoryProvenanceRefsFor(event, cueCase) {
  const refs = [];
  const seen = new Set();
  const add = (namespace, refId, label) => {
    if (typeof refId !== "string" || !refId.trim()) return;
    const token = `${namespace}|${refId}`;
    if (seen.has(token)) return;
    seen.add(token);
    refs.push({ namespace, refId: refId.trim(), label });
  };
  const input = isRecord(event.input) ? event.input : {};
  for (const fact of Array.isArray(input.decisionFacts) ? input.decisionFacts : []) add("DEMO_FACT", fact?.id, "decision-time Demo fact");
  for (const fact of Array.isArray(input.playerActionFacts) ? input.playerActionFacts : []) add("DEMO_FACT", fact?.id, "player-action Demo fact");
  for (const fact of Array.isArray(input.outcomeFacts) ? input.outcomeFacts : []) add("DEMO_FACT", fact?.id, "outcome Demo fact");
  const material = isRecord(input.material) ? input.material : {};
  for (const evidence of Array.isArray(material.evidence) ? material.evidence : []) add("PRO_EVIDENCE", evidence?.id, "bounded coaching evidence");
  if (Array.isArray(cueCase?.diagnosticResult?.evidenceRefs)) {
    for (const ref of cueCase.diagnosticResult.evidenceRefs) add("OBSERVATION_CLAIM", ref, "diagnostic observation claim");
  }
  if (Array.isArray(cueCase?.verdict?.evidenceRefs)) {
    for (const ref of cueCase.verdict.evidenceRefs) add("OBSERVATION_CLAIM", ref, "verdict observation claim");
  }
  return refs.slice(0, 48);
}

function buildCueMemoryEvent(event, result, userId) {
  if (event.type !== "SUBMIT_REFLECTION" && event.type !== "SUBMIT_DISAGREEMENT") return undefined;
  const cueCase = cueCaseFor(result, event.cueId);
  const learningThread = learningThreadFor(result, event.cueId);
  // Skipped/fallback diagnosis has no verified Session thread and must not be
  // promoted into a long-term proposal.
  if (!cueCase || !learningThread || !["AWAITING_CONFIRMATION", "COMPLETED", "DISAGREED"].includes(cueCase.status) || !cueCase.verdict || !cueCase.diagnosticResult) return undefined;
  if (event.type === "SUBMIT_REFLECTION" && event.reflection.response === "SKIPPED") return undefined;
  const identity = result.identity ?? event.identity;
  const base = memoryModule.buildMemoryProposal({
    userId,
    sessionId: identity.sessionId,
    demoContentHash: identity.demoContentHash,
    cueCase,
    learningThread,
    outcomeGateStatus: event.outcomeGateStatus,
    provenanceRefs: memoryProvenanceRefsFor(event, cueCase),
    producerVersion: MEMORY_PRODUCER_VERSION,
    createdAt: memoryTimestamp(),
  });
  const revision = Number(cueCase.verdict?.revision ?? cueCase.attemptBudget?.disagreement ?? 0);
  const eventType = event.type === "SUBMIT_DISAGREEMENT" ? "USER_CORRECTED_COACH" : "CUE_DIAGNOSED";
  const idempotencyKey = memoryIdempotency({
    userId,
    eventType,
    sessionId: identity.sessionId,
    demoContentHash: identity.demoContentHash,
    cueId: event.cueId,
    revision,
    logicalKey: base.logicalKey,
  });
  let proposal = {
    ...base,
    proposalId: `proposal-${stableToken(`${base.proposalId}|${eventType}|${revision}`)}`,
    eventType,
    idempotencyKey,
  };
  if (event.type === "SUBMIT_DISAGREEMENT") {
    const correctionContent = boundedText(event.reflection.rawText) ||
      `用户不同意当前教练判断；当时目标：${boundedText(event.reflection.selectedGoal, 120) || "未提供"}`;
    proposal = {
      ...proposal,
      operation: "CORRECT",
      targetMemoryId: `memory-${stableToken(base.logicalKey)}`,
      correction: {
        correctionId: event.reflection.reflectionId ?? `correction-${stableToken(`${identity.sessionId}|${event.cueId}|${revision}`)}`,
        content: correctionContent,
        source: "USER",
      },
    };
  }
  const validatedProposal = memoryModule.MemoryProposalSchema.parse(proposal);
  return memoryModule.MemoryEventSchema.parse({
    schemaVersion: "memory-event.v1",
    eventId: memoryEventId(idempotencyKey),
    type: eventType,
    eventType,
    userId,
    sessionId: identity.sessionId,
    demoContentHash: identity.demoContentHash,
    proposalId: validatedProposal.proposalId,
    ...(validatedProposal.targetMemoryId ? { targetMemoryId: validatedProposal.targetMemoryId } : {}),
    operation: validatedProposal.operation,
    idempotencyKey,
    producerVersion: MEMORY_PRODUCER_VERSION,
    payload: validatedProposal,
    createdAt: validatedProposal.createdAt,
  });
}

function buildTransferApplicationMemoryEvent(event, result, userId, primaryEvent) {
  if (event.type !== "SUBMIT_REFLECTION" || !primaryEvent) return undefined;
  const cueCase = cueCaseFor(result, event.cueId);
  const learningThread = learningThreadFor(result, event.cueId);
  if (!cueCase || !learningThread || cueCase.status === "FALLBACK") return undefined;
  // The first occurrence teaches a rule; only a later cue in the same
  // session can be classified as an application of an already-seen thread.
  if (!learningThread.evidenceCueIds.some((cueId) => cueId !== event.cueId)) return undefined;
  const applicationOutcome = learningThread.successfulCueIds.includes(event.cueId)
    ? "SUCCESS"
    : learningThread.conflictingCueIds.includes(event.cueId)
      ? "CONFLICT"
      : undefined;
  if (!applicationOutcome) return undefined;
  const proposal = memoryModule.MemoryProposalSchema.parse(primaryEvent.payload);
  const idempotencyKey = memoryIdempotency({
    userId,
    eventType: "TRANSFER_RULE_APPLIED",
    sessionId: event.identity.sessionId,
    demoContentHash: event.identity.demoContentHash,
    cueId: event.cueId,
    revision: Number(cueCase.verdict?.revision ?? 0),
    logicalKey: `${proposal.logicalKey}|${applicationOutcome}`,
  });
  const applicationProposal = memoryModule.MemoryProposalSchema.parse({
    ...proposal,
    proposalId: `proposal-${stableToken(`${proposal.proposalId}|application|${applicationOutcome}`)}`,
    operation: "UPDATE",
    eventType: "TRANSFER_RULE_APPLIED",
    applicationOutcome,
    idempotencyKey,
  });
  return memoryModule.MemoryEventSchema.parse({
    schemaVersion: "memory-event.v1",
    eventId: memoryEventId(idempotencyKey),
    type: "TRANSFER_RULE_APPLIED",
    eventType: "TRANSFER_RULE_APPLIED",
    userId,
    sessionId: event.identity.sessionId,
    demoContentHash: event.identity.demoContentHash,
    proposalId: applicationProposal.proposalId,
    operation: "UPDATE",
    idempotencyKey,
    producerVersion: MEMORY_PRODUCER_VERSION,
    payload: applicationProposal,
    createdAt: applicationProposal.createdAt,
  });
}

function buildCompletionMemoryEvent(event, result, userId) {
  if (event.type !== "COMPLETE_SESSION" || result?.state?.sessionStatus !== "COMPLETED") return undefined;
  const identity = result.identity ?? event.identity;
  const revision = Number(result.state.completedCueIds?.length ?? result.state.lastStableCheckpoint?.sequence ?? 0);
  const idempotencyKey = memoryIdempotency({
    userId,
    eventType: "SESSION_COMPLETED",
    sessionId: identity.sessionId,
    demoContentHash: identity.demoContentHash,
    cueId: "session-complete",
    revision,
  });
  return memoryModule.MemoryEventSchema.parse({
    schemaVersion: "memory-event.v1",
    eventId: memoryEventId(idempotencyKey),
    type: "SESSION_COMPLETED",
    eventType: "SESSION_COMPLETED",
    userId,
    sessionId: identity.sessionId,
    demoContentHash: identity.demoContentHash,
    idempotencyKey,
    producerVersion: MEMORY_PRODUCER_VERSION,
    // Completion is metadata only; no route, ticks, replay or narration is
    // copied into the Memory Event.
    payload: { reason: "SESSION_COMPLETED" },
    createdAt: memoryTimestamp(),
  });
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

function errorResponse(reason, status) {
  return json({ schemaVersion: "coach-agent-remote-error.v1", reason }, status);
}

function validJsonContentType(request) {
  return request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() === "application/json";
}

async function readBoundedText(request, maxBytes) {
  const declaredLength = request.headers.get("content-length");
  if (declaredLength !== null) {
    const length = Number(declaredLength);
    if (!Number.isFinite(length) || length < 0 || length > maxBytes) return { ok: false, tooLarge: true };
  }
  if (!request.body) return { ok: true, text: "" };
  const reader = request.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      const chunk = next.value instanceof Uint8Array ? next.value : new Uint8Array(next.value);
      total += chunk.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => undefined);
        return { ok: false, tooLarge: true };
      }
      chunks.push(chunk);
    }
  } catch {
    return { ok: false, tooLarge: false };
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { ok: true, text: new TextDecoder().decode(bytes) };
}

async function readEnvelope(request) {
  const bounded = await readBoundedText(request, MAX_REMOTE_REQUEST_BYTES);
  if (!bounded.ok) return { error: errorResponse(bounded.tooLarge ? "REQUEST_TOO_LARGE" : "REQUEST_BODY_UNREADABLE", bounded.tooLarge ? 413 : 400) };
  const raw = bounded.text;
  let parsed;
  try {
    parsed = stripClientBriefFromEnvelopeValue(JSON.parse(raw));
  } catch {
    return { error: errorResponse("INVALID_JSON", 400) };
  }
  try {
    return { envelope: parseRemoteCoachAgentDispatchEnvelope(parsed) };
  } catch {
    return { error: errorResponse("INVALID_ENVELOPE", 400) };
  }
}

function policyEndpointFor(request) {
  try {
    const requestUrl = new URL(request.url);
    if (!/^https?:$/.test(requestUrl.protocol) || requestUrl.origin === "null") return null;
    const policyUrl = new URL("/api/coaching/policy", requestUrl);
    return { origin: policyUrl.origin, endpoint: policyUrl.href };
  } catch {
    return null;
  }
}

function fetchPolicyWithTimeout(input, init = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), POLICY_ROUTE_TIMEOUT_MS);
  const upstreamSignal = init.signal;
  const abortUpstream = () => controller.abort();
  if (upstreamSignal) {
    if (upstreamSignal.aborted) controller.abort();
    else upstreamSignal.addEventListener("abort", abortUpstream, { once: true });
  }
  return fetch(input, { ...init, signal: controller.signal }).finally(() => {
    clearTimeout(timeout);
    upstreamSignal?.removeEventListener("abort", abortUpstream);
  });
}

function runtimeWithPolicy(checkpointer, endpoint) {
  const policy = createDeepSeekCoachPolicyAdapter({
    endpoint,
    fetcher: fetchPolicyWithTimeout,
    // The graph already owns deterministic selection. Turning a provider
    // FALLBACK/DISABLED result into a rejected policy call preserves its
    // existing MODEL vs FALLBACK trace seam without changing graph state.
    onResult: (result) => {
      if (result.status !== "SUCCEEDED") {
        throw new Error(`COACH_POLICY_${result.status}_${result.manifest.reason ?? "FALLBACK"}`);
      }
    },
  });
  return createCoachAgentRuntime({
    checkpointer,
    checkpointBackend: "DURABLE_OBJECT",
    policy,
  });
}

function deterministicRuntime(checkpointer) {
  return createCoachAgentRuntime({
    checkpointer,
    checkpointBackend: "DURABLE_OBJECT",
  });
}

/**
 * One Durable Object owns one session's checkpoint namespace. The object only
 * receives the compact remote envelope; raw Replay, frames and prompts never
 * cross this boundary.
 */
export class CoachAgentDurableObject {
  constructor(state, env = undefined) {
    this.state = state;
    this.env = env ?? state.env ?? {};
    this.saver = new DurableObjectCheckpointSaver({
      storage: state.storage,
      retention: 20,
    });
    this.outbox = new MemoryOutbox({
      storage: state.storage,
      maxAttempts: Number(this.env.MEMORY_OUTBOX_MAX_ATTEMPTS ?? 5),
      baseDelayMs: Number(this.env.MEMORY_OUTBOX_BASE_DELAY_MS ?? 1_000),
      maxDelayMs: Number(this.env.MEMORY_OUTBOX_MAX_DELAY_MS ?? 60_000),
    });
    this.memoryOwner = null;
    this.memoryOwnerReadFailed = false;
    this.memoryConsentReadFailed = false;
    this.memoryBrief = null;
    this.memoryBriefRequiresRefresh = false;
    this.memorySessionId = null;
    this.lastMemoryRequestUrl = null;
    this.policyOrigin = null;
    this.policyEndpoint = null;
    this.policyRuntime = null;
    this.fallbackRuntime = null;
    this.dispatchTail = Promise.resolve();
    this.memoryOwnerClaimTail = Promise.resolve();
    this.memoryAuthorizationTail = Promise.resolve();
    // Memory persistence is chained independently from the Coach dispatch.
    // The chain preserves event order and lets the response return while the
    // DO's waitUntil lifecycle owns durable Outbox work.
    this.memoryEventTail = Promise.resolve();
    this.memoryConsentEpoch = 0;
    this.memoryBriefEpoch = 0;
    this.memoryAuthorityVersion = undefined;
    this.memoryAuthorityQueryToken = 0;
    // A confirmed withdrawal/deletion is an in-process veto even if the
    // subsequent storage write fails. It is cleared only by a successfully
    // persisted, strictly newer explicit grant.
    this.memoryRevokedLatch = false;
    // Outbox cleanup is queued after the current authorization task rather
    // than awaited from it. These flags make the short asynchronous window
    // fail closed and prevent a new grant from flushing rows created under a
    // prior consent epoch.
    this.memoryOutboxCleanupPending = false;
    this.memoryOutboxCleanupFailed = false;
    this.memoryOutboxCleanupPromise = undefined;
  }

  memoryFlagEnabled() {
    return envBoolean(this.env.MEMORY_ENABLED ?? this.env.memoryEnabled);
  }

  revokeMemoryLocally(options = {}) {
    // Increment synchronously, before any awaited storage/provider operation,
    // so an already scheduled sink cannot deliver after a withdrawal wins.
    this.memoryConsentEpoch += 1;
    this.memoryBriefEpoch += 1;
    if (options.latch !== false) this.memoryRevokedLatch = true;
    this.memoryBrief = null;
    // A deployment-level feature-off path must remain completely inert for
    // memory storage.  It still clears in-process context, but a refresh
    // marker is durable memory state and is therefore only written when the
    // feature is enabled (or an explicit caller requests persistence).
    if (options.persistRefresh !== false && this.memoryFlagEnabled()) {
      this.markMemoryBriefRefreshRequired();
    } else if (options.persistRefresh === false) {
      this.memoryBriefRequiresRefresh = false;
    }
    // The checkpoint saver keeps a live-only brief map so a same-instance
    // resume can reuse a trusted projection.  Revocation must clear that map
    // too; otherwise tuple rehydration could re-inject stale context after
    // the DO field above has been nulled.
    this.saver.clearEphemeralMemoryBriefs();
  }

  markMemoryBriefRefreshRequired() {
    this.memoryBriefRequiresRefresh = true;
    try {
      void Promise.resolve(this.state.storage.put(MEMORY_BRIEF_REFRESH_KEY, {
        schemaVersion: "memory-brief-refresh.v1",
        required: true,
        updatedAt: memoryTimestamp(),
      })).catch(() => undefined);
    } catch {
      // The in-memory flag still protects this instance; a storage failure is
      // handled as a conservative refresh requirement after restart.
    }
  }

  clearMemoryBriefRefreshRequirement() {
    this.memoryBriefRequiresRefresh = false;
    try {
      if (typeof this.state.storage.delete === "function") {
        void Promise.resolve(this.state.storage.delete(MEMORY_BRIEF_REFRESH_KEY)).catch(() => undefined);
      }
    } catch {
      // A stale marker is safe: it only forces a fresh provider read.
    }
  }

  async loadMemoryBriefRefreshRequirement() {
    try {
      const marker = await this.state.storage.get(MEMORY_BRIEF_REFRESH_KEY);
      if (marker && (marker.required === true || marker === true)) this.memoryBriefRequiresRefresh = true;
    } catch {
      // Do not trust an environment brief when the refresh marker cannot be
      // read; requiring a provider refresh is the fail-closed choice.
      this.memoryBriefRequiresRefresh = true;
    }
  }

  clearMemoryBriefLocally(options = {}) {
    this.memoryBriefEpoch += 1;
    this.memoryBrief = null;
    if (options.requireRefresh === false) this.clearMemoryBriefRefreshRequirement();
    else this.markMemoryBriefRefreshRequired();
    this.saver.clearEphemeralMemoryBriefs();
  }

  async storedMemoryOwner() {
    try {
      const stored = await this.state.storage.get(MEMORY_OWNER_KEY);
      this.memoryOwnerReadFailed = false;
      if (stored !== undefined && stored !== null && typeof stored !== "string" &&
        (!isRecord(stored) || typeof stored.principal !== "string")) {
        this.memoryOwnerReadFailed = true;
        return undefined;
      }
      const value = typeof stored === "string" ? stored : stored?.principal;
      this.memoryOwner = typeof value === "string" && value.length > 0 ? value : undefined;
    } catch {
      // A storage outage must not affect the baseline Agent dispatch path,
      // but it must fail closed for memory ownership rather than looking like
      // a first visit and allowing a different principal to claim the DO.
      this.memoryOwnerReadFailed = true;
    }
    return this.memoryOwner;
  }

  /** Claim the per-session principal through one serialized storage seam. */
  async claimMemoryOwner(principal) {
    const claim = this.memoryOwnerClaimTail.then(async () => {
      const owner = await this.storedMemoryOwner();
      if (this.memoryOwnerReadFailed) throw Object.assign(new Error("MEMORY_OWNER_UNAVAILABLE"), { code: "MEMORY_OWNER_UNAVAILABLE" });
      if (owner && owner !== principal) throw Object.assign(new Error("TRUSTED_PRINCIPAL_MISMATCH"), { code: "TRUSTED_PRINCIPAL_MISMATCH" });
      if (owner) return owner;
      try {
        await this.state.storage.put(MEMORY_OWNER_KEY, {
          schemaVersion: "memory-owner.v1",
          principal,
          createdAt: memoryTimestamp(),
        });
        this.memoryOwner = principal;
        return principal;
      } catch {
        throw Object.assign(new Error("MEMORY_OWNER_UNAVAILABLE"), { code: "MEMORY_OWNER_UNAVAILABLE" });
      }
    });
    this.memoryOwnerClaimTail = claim.then(() => undefined, () => undefined);
    return claim;
  }

  async storedMemoryConsent() {
    try {
      const stored = await this.state.storage.get(MEMORY_CONSENT_KEY);
      this.memoryConsentReadFailed = false;
      if (stored === undefined || stored === null) return undefined;
      if (!isRecord(stored)) {
        this.memoryConsentReadFailed = true;
        return undefined;
      }
      const principal = typeof stored.principal === "string" ? stored.principal : undefined;
      const consent = stored.consent === "GRANTED" || stored.consent === "REVOKED" ? stored.consent : undefined;
      const consentVersion = stored.consentVersion === undefined || stored.consentVersion === null
        ? 0
        : Number(stored.consentVersion);
      if (!principal || !consent) {
        this.memoryConsentReadFailed = true;
        return undefined;
      }
      if (!Number.isSafeInteger(consentVersion) || consentVersion < 0) {
        this.memoryConsentReadFailed = true;
        return undefined;
      }
      return principal && consent ? { principal, consent, consentVersion } : undefined;
    } catch {
      this.memoryConsentReadFailed = true;
      return undefined;
    }
  }

  async persistMemoryConsent(principal, consent, consentVersion = 0) {
    try {
      await this.state.storage.put(MEMORY_CONSENT_KEY, {
        schemaVersion: "memory-consent.v1",
        principal,
        consent,
        consentVersion,
        updatedAt: memoryTimestamp(),
      });
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Install a durable revocation marker without ever moving its version
   * backwards.  A stale GRANTED cookie is allowed to reopen a DO only when it
   * carries a strictly newer signed consent version, so every locally
   * observed withdrawal must never move the marker backwards. The trusted
   * consent service normally advances its version when the user opts in
   * again; incrementing here would make a DO-local marker outrun that source
   * of truth after repeated alarms or duplicate invalidations.
   */
  async persistRevokedMemoryConsent(principal, presentedVersion = 0) {
    const prior = await this.storedMemoryConsent();
    if (this.memoryConsentReadFailed) return false;
    const nextVersion = Math.max(
      Number.isSafeInteger(prior?.consentVersion) ? prior.consentVersion : 0,
      Number.isSafeInteger(presentedVersion) ? presentedVersion : 0,
    );
    return this.persistMemoryConsent(principal, "REVOKED", nextVersion);
  }

  /**
   * The Worker supplies this header only after server-side principal
   * authentication.  The DO never derives userId from the JSON event body.
   */
  async authorizeMemory(request) {
    // Serialize grant/revoke decisions as one per-DO critical section. The
    // owner claim tail alone is insufficient: a revoke can otherwise observe
    // an empty owner while a concurrent grant is awaiting storage.put().
    const task = this.runMemoryAuthorizationTask(() => this.authorizeMemorySerial(request));
    const result = await task;
    // Cleanup is queued after the authorization tail. Waiting here is safe:
    // any sink that was waiting for this tail has now been released, so there
    // is no auth↔outbox cycle. Callers therefore observe a settled transition
    // (and the old rows are terminalized) without making the critical section
    // wait on the Outbox itself.
    const cleanup = this.memoryOutboxCleanupPromise;
    if (cleanup && this.memoryOutboxCleanupPending) await cleanup;
    if (result?.enabled && this.memoryOutboxCleanupFailed) {
      return { enabled: false, reason: "MEMORY_OUTBOX_UNAVAILABLE" };
    }
    return result;
  }

  runMemoryAuthorizationTask(taskFactory) {
    const task = this.memoryAuthorizationTail.then(taskFactory, taskFactory);
    this.memoryAuthorizationTail = task.then(() => undefined, () => undefined);
    return task;
  }

  async authorizeMemorySerial(request) {
    if (!this.memoryFlagEnabled()) {
      // Disabling the deployment feature must clear only the in-process brief
      // context. It is not a user consent withdrawal: setting the revoked
      // latch here would make a later flag re-enable look like a stale grant
      // even when the durable consent row is still GRANTED.
      this.revokeMemoryLocally({ persistRefresh: false, latch: false });
      return { enabled: false, reason: "MEMORY_DISABLED" };
    }
    await this.loadMemoryBriefRefreshRequirement();
    const principal = trustedPrincipalFrom(request);
    const owner = await this.storedMemoryOwner();
    if (this.memoryOwnerReadFailed) return { enabled: false, reason: "MEMORY_OWNER_UNAVAILABLE" };
    if (owner && (!principal || owner !== principal)) {
      return { enabled: false, rejected: true, reason: "TRUSTED_PRINCIPAL_MISMATCH" };
    }
    // Read consent before claiming a missing owner. If the owner key was lost
    // but a consent row remains, treating the request as a first visit would
    // let another principal take over the session and overwrite that row.
    const initialConsent = await this.storedMemoryConsent();
    if (this.memoryConsentReadFailed) return { enabled: false, reason: "MEMORY_CONSENT_UNAVAILABLE" };
    if (initialConsent && (!principal || initialConsent.principal !== principal)) {
      return { enabled: false, rejected: true, reason: "TRUSTED_PRINCIPAL_MISMATCH" };
    }
    if (!owner && initialConsent) {
      return { enabled: false, reason: "MEMORY_OWNER_UNAVAILABLE" };
    }
    if (!principal || !consentGrantedFrom(request)) {
      if (principal && owner && owner === principal) {
        const presentedVersion = consentVersionFrom(request) ?? 0;
        this.revokeMemoryLocally();
        const persisted = await this.persistRevokedMemoryConsent(principal, presentedVersion);
        this.scheduleMemoryOutboxInvalidation("CONSENT_REVOKED");
        if (!persisted) return { enabled: false, reason: "MEMORY_CONSENT_UNAVAILABLE" };
      }
      return { enabled: false, reason: principal ? "CONSENT_REQUIRED" : "TRUSTED_PRINCIPAL_REQUIRED" };
    }
    try {
      await this.claimMemoryOwner(principal);
    } catch (error) {
      const reason = error && typeof error === "object" && "code" in error ? error.code : "MEMORY_OWNER_UNAVAILABLE";
      if (reason === "TRUSTED_PRINCIPAL_MISMATCH") return { enabled: false, rejected: true, reason };
      return { enabled: false, reason: "MEMORY_OWNER_UNAVAILABLE" };
    }
    const priorConsent = await this.storedMemoryConsent();
    if (this.memoryConsentReadFailed) return { enabled: false, reason: "MEMORY_CONSENT_UNAVAILABLE" };
    if (priorConsent && priorConsent.principal !== principal) {
      return { enabled: false, rejected: true, reason: "TRUSTED_PRINCIPAL_MISMATCH" };
    }
    const requestedVersion = consentVersionFrom(request);
    const priorVersion = priorConsent?.consentVersion ?? 0;
    // Consent versions are monotonic trusted claims. A stale signed cookie
    // must never lower the DO's durable version even when the prior state is
    // still GRANTED; doing so would reopen a window for an older authority
    // snapshot after a later revoke/grant transition.
    if (requestedVersion !== undefined && requestedVersion < priorVersion) {
      return { enabled: false, reason: "CONSENT_REQUIRED" };
    }
    // A stale GRANTED cookie must not silently re-open a channel that was
    // revoked by a delete-all operation. A newer signed consent version is
    // the explicit opt-in signal.
    if ((priorConsent?.consent === "REVOKED" || this.memoryRevokedLatch) &&
      (requestedVersion === undefined || requestedVersion <= priorVersion)) {
      return { enabled: false, reason: "CONSENT_REQUIRED" };
    }
    const grantedVersion = Math.max(requestedVersion ?? 0, priorVersion);
    if (!(await this.persistMemoryConsent(principal, "GRANTED", grantedVersion))) {
      return { enabled: false, reason: "MEMORY_CONSENT_UNAVAILABLE" };
    }
    const consentTransitioned = priorConsent?.consent !== "GRANTED" ||
      priorConsent?.consentVersion !== grantedVersion || priorConsent?.principal !== principal;
    if (consentTransitioned) {
      // A new consent version invalidates any background flush/provider task
      // that was started under the previous grant or revocation epoch.
      this.memoryConsentEpoch += 1;
      this.clearMemoryBriefLocally({ requireRefresh: Boolean(
        (priorConsent !== undefined && (
          priorConsent.consent !== "GRANTED" ||
          priorConsent.consentVersion !== grantedVersion
        )) || this.memoryRevokedLatch,
      ) });
      // A DO may have been offline while the authority moved v1→REVOKED→v3.
      // Its old PENDING/RETRY rows were created under the prior grant and
      // must never ride along with the new opt-in. Queue invalidation before
      // any later enqueue/flush; MemoryOutbox serializes the queued operation
      // ahead of those calls. Do not await it here: an in-flight sink can be
      // waiting for this authorization tail, and waiting for the Outbox tail
      // would create an auth↔outbox deadlock.
      this.scheduleMemoryOutboxInvalidation("CONSENT_VERSION_CHANGED");
      this.memoryRevokedLatch = false;
    }
    try {
      await this.state.storage.put(MEMORY_ENDPOINT_KEY, new URL("/api/memory/events", request.url).href);
    } catch {
      // Endpoint persistence only improves alarm recovery; the current
      // request can still use its same-origin sink.
    }
    return { enabled: true, userId: principal, consent: "GRANTED" };
  }

  briefFromEventOrEnvironment(_event) {
    // A remote event is browser-originated input and must never be allowed to
    // supply or override a user's long-term memory.  Only a server-configured
    // brief (tests/local host) or the authenticated provider may do so.
    if (this.memoryBriefRequiresRefresh) return this.memoryBrief ?? undefined;
    const configured = this.env.MEMORY_BRIEF ?? this.env.memoryBrief;
    const fromEnv = memoryBriefOrUndefined(configured);
    return fromEnv ?? this.memoryBrief ?? undefined;
  }

  memoryBriefForEvent(event, authorization, serverBrief = undefined) {
    // Diagnosis/lifecycle events have intentionally strict, separate wire
    // schemas.  The brief is a cue-policy input only; never widen those
    // event contracts just to attach an optional read-only projection.
    // Strip a browser-supplied brief even when the feature/consent gate is
    // closed. Returning the original event here would let an untrusted client
    // smuggle memory-shaped coaching context into the Agent baseline path.
    const { memoryBrief: _clientBrief, ...eventWithoutClientBrief } = event;
    void _clientBrief;
    if (!authorization.enabled) {
      return (event.type === "START_CUE" || event.type === "START_MANUAL_CUE_VISIT")
        ? { ...eventWithoutClientBrief, memoryBrief: null }
        : eventWithoutClientBrief;
    }
    if (event.type !== "START_CUE" && event.type !== "START_MANUAL_CUE_VISIT") return eventWithoutClientBrief;
    const brief = serverBrief ?? this.briefFromEventOrEnvironment(event) ?? emptyMemoryBrief();
    return { ...eventWithoutClientBrief, memoryBrief: brief };
  }

  async memoryBriefFromProvider(request, authorization) {
    if (!authorization.enabled) return undefined;
    const provider = this.env.MEMORY_BRIEF_PROVIDER ?? this.env.memoryBriefProvider;
    if (typeof provider === "function") {
      try {
        return memoryBriefOrUndefined(await provider(authorization.userId));
      } catch {
        return undefined;
      }
    }
    const binding = this.env.MEMORY_SERVICE ?? this.env.MEMORY_EVENTS;
    const endpointValue = this.env.MEMORY_BRIEF_URL ?? (typeof this.env.MEMORY_EVENTS === "string" ? this.env.MEMORY_EVENTS : undefined);
    // In production the module's own same-origin route is the default
    // provider. Tests stay side-effect free unless they explicitly opt into
    // this route with MEMORY_DEFAULT_BRIEF=true.
    const defaultBriefEnabled = this.env.MEMORY_DEFAULT_BRIEF === true ||
      String(this.env.MEMORY_DEFAULT_BRIEF ?? "").toLowerCase() === "true";
    if (!binding && !endpointValue && globalThis.process?.env?.NODE_ENV !== "production" && !defaultBriefEnabled) return undefined;
    try {
      const endpoint = endpointValue || new URL("/api/memory/brief", request.url).href;
      const briefHeaders = await internalAuthHeaders(this.env, "", {
        accept: "application/json",
        [TRUSTED_PRINCIPAL_HEADER]: authorization.userId,
        "x-cs-memory-internal": "1",
      });
      const briefRequest = new Request(endpoint, { method: "GET", headers: briefHeaders });
      const response = binding && typeof binding.fetch === "function"
        ? await binding.fetch(briefRequest)
        : await fetch(briefRequest, { signal: AbortSignal.timeout(MEMORY_BRIEF_TIMEOUT_MS) });
      if (!response?.ok) return undefined;
      const raw = await response.json();
      return memoryBriefOrUndefined(raw);
    } catch {
      return undefined;
    }
  }

  async memoryBriefFromProviderBounded(request, authorization) {
    let timer;
    try {
      return await Promise.race([
        this.memoryBriefFromProvider(request, authorization),
        new Promise((resolve) => {
          timer = setTimeout(() => resolve(undefined), MEMORY_BRIEF_TIMEOUT_MS);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  async consentFromProvider(request, principal, queryToken = this.memoryAuthorityQueryToken) {
    if (queryToken === this.memoryAuthorityQueryToken) this.memoryAuthorityVersion = undefined;
    const provider = this.env.MEMORY_CONSENT_PROVIDER ?? this.env.memoryConsentProvider;
    if (typeof provider === "function") {
      try {
        const value = await provider(principal);
        if (typeof value === "boolean") return value;
        const status = parseConsentAuthorityStatus(value);
        if (!status) return undefined;
        if (queryToken === this.memoryAuthorityQueryToken && status.consentVersion !== undefined) {
          this.memoryAuthorityVersion = status.consentVersion;
        }
        return status.granted;
      } catch {
        return undefined;
      }
      return undefined;
    }
    const binding = this.env.MEMORY_SERVICE ?? this.env.MEMORY_STATUS;
    const configuredStatusUrl = this.env.MEMORY_STATUS_URL;
    if (!binding && !configuredStatusUrl && globalThis.process?.env?.NODE_ENV !== "production") return undefined;
    try {
      const endpoint = configuredStatusUrl || new URL("/api/memory/status", request.url).href;
      const response = binding && typeof binding.fetch === "function"
        ? await binding.fetch(new Request(endpoint, {
            method: "GET",
            headers: await internalAuthHeaders(this.env, "", {
              accept: "application/json",
              [TRUSTED_PRINCIPAL_HEADER]: principal,
              "x-cs-memory-internal": "1",
            }),
          }))
        : await fetch(endpoint, {
            method: "GET",
            headers: await internalAuthHeaders(this.env, "", {
              accept: "application/json",
              [TRUSTED_PRINCIPAL_HEADER]: principal,
              "x-cs-memory-internal": "1",
            }),
            signal: AbortSignal.timeout(MEMORY_BRIEF_TIMEOUT_MS),
          });
      if (!response?.ok) return undefined;
      const raw = await response.json();
      const status = parseConsentAuthorityStatus(raw);
      if (!status) return undefined;
      if (queryToken === this.memoryAuthorityQueryToken && status.consentVersion !== undefined) {
        this.memoryAuthorityVersion = status.consentVersion;
      }
      return status.granted;
    } catch {
      return undefined;
    }
  }

  consentProviderConfigured() {
    const provider = this.env.MEMORY_CONSENT_PROVIDER ?? this.env.memoryConsentProvider;
    if (typeof provider === "function") return true;
    const binding = this.env.MEMORY_SERVICE ?? this.env.MEMORY_STATUS;
    const configuredStatusUrl = this.env.MEMORY_STATUS_URL;
    // Production deployments must provide a live authority (binding/URL plus
    // internal token or HMAC). Without it, fail closed instead of trusting a
    // stale local grant; test fakes intentionally use their persisted row.
    const internalToken = typeof this.env.MEMORY_INTERNAL_TOKEN === "string" && this.env.MEMORY_INTERNAL_TOKEN.trim().length >= 16;
    const internalHmac = typeof this.env.MEMORY_INTERNAL_HMAC_SECRET === "string" && this.env.MEMORY_INTERNAL_HMAC_SECRET.trim().length >= 16;
    const runningInWorker = typeof globalThis.process === "undefined" && this.env.NODE_ENV !== "test";
    const productionDeployment = globalThis.process?.env?.NODE_ENV === "production" ||
      this.env.NODE_ENV === "production" || this.env.DEPLOY_TARGET === "cloudflare";
    // In a production/Cloudflare deployment the local DO row is never a
    // sufficient authority, even when a binding or secret was accidentally
    // omitted. `consentFromProvider` will then fail closed (undefined), rather
    // than silently taking the local-grant branch.
    if (productionDeployment || runningInWorker) return true;
    return (Boolean(binding && typeof binding.fetch === "function") || Boolean(configuredStatusUrl)) &&
      Boolean(internalToken || internalHmac || globalThis.process?.env?.NODE_ENV === "test");
  }

  async consentFromProviderBounded(request, principal) {
    const queryToken = this.memoryAuthorityQueryToken + 1;
    this.memoryAuthorityQueryToken = queryToken;
    let timer;
    try {
      return await Promise.race([
        this.consentFromProvider(request, principal, queryToken),
        new Promise((resolve) => {
          timer = setTimeout(() => {
            // Invalidate the side-channel token before resolving the timeout;
            // a late provider response must not overwrite a newer authority
            // snapshot used by a subsequent flush.
            if (this.memoryAuthorityQueryToken === queryToken) this.memoryAuthorityQueryToken += 1;
            resolve(undefined);
          }, MEMORY_BRIEF_TIMEOUT_MS);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /**
   * Re-check the live authority before any cached/provider brief is exposed
   * to the Agent.  Request headers are only an authentication hint; a
   * management revoke may have happened after the browser received them.
   * Fail closed on an unavailable authority so stale context cannot cross the
   * consent boundary.  Pending outbox rows are retained for transient
   * outages, but are invalidated immediately for a confirmed withdrawal.
   */
  async authorizeMemoryAuthority(request, authorization) {
    if (!authorization.enabled) return authorization;
    const task = this.memoryAuthorizationTail.then(() => this.authorizeMemoryAuthoritySerial(request, authorization));
    this.memoryAuthorizationTail = task.then(() => undefined, () => undefined);
    return task;
  }

  async authorizeMemoryAuthoritySerial(request, authorization) {
    if (!authorization.enabled) return authorization;
    const authorityEpoch = this.memoryConsentEpoch;
    const localConsent = await this.storedMemoryConsent();
    if (this.memoryConsentReadFailed) {
      this.revokeMemoryLocally({ latch: false });
      return { enabled: false, reason: "MEMORY_AUTHORITY_UNAVAILABLE" };
    }
    const localVersion = localConsent?.consentVersion ?? 0;
    if (!localConsent || localConsent.principal !== authorization.userId || localConsent.consent !== "GRANTED") {
      this.revokeMemoryLocally();
      this.scheduleMemoryOutboxInvalidation("CONSENT_REVOKED");
      return { enabled: false, reason: "CONSENT_REQUIRED" };
    }

    if (!this.consentProviderConfigured()) {
      // A test/local injected sink with no authority provider uses the
      // durable DO consent row established by authorizeMemory above.
      const latest = await this.storedMemoryConsent();
      if (this.memoryConsentReadFailed || this.memoryConsentEpoch !== authorityEpoch ||
        !latest || latest.principal !== authorization.userId || latest.consent !== "GRANTED" ||
        latest.consentVersion !== localConsent.consentVersion) {
        if (latest?.consent !== "GRANTED") this.revokeMemoryLocally();
        return { enabled: false, reason: "CONSENT_CHANGED" };
      }
      return authorization;
    }
    const remoteConsent = await this.consentFromProviderBounded(request, authorization.userId);
    // A provider call can outlive another authorize/revoke operation. Never
    // let its result overwrite a newer local consent version or dispatch with
    // an epoch that has already been invalidated.
    const afterConsent = await this.storedMemoryConsent();
    if (this.memoryConsentReadFailed) {
      this.revokeMemoryLocally({ latch: false });
      return { enabled: false, reason: "MEMORY_AUTHORITY_UNAVAILABLE" };
    }
    const changedWhileChecking = this.memoryConsentEpoch !== authorityEpoch ||
      !afterConsent || afterConsent.principal !== authorization.userId || afterConsent.consentVersion !== localVersion;
    if (changedWhileChecking) {
      if (afterConsent?.consent !== "GRANTED") this.revokeMemoryLocally();
      return { enabled: false, reason: "CONSENT_CHANGED" };
    }
    const requestedVersion = consentVersionFrom(request);
    const authorityVersion = this.memoryAuthorityVersion;
    // A DO that missed an all-session invalidation may still hold an old
    // GRANTED row/brief. The live status route exposes its monotonic consent
    // version so an old signed cookie cannot reopen stale context after a
    // revoke/re-grant cycle.
    if (authorityVersion !== undefined &&
      (requestedVersion === undefined ? authorityVersion > localVersion : requestedVersion < authorityVersion)) {
      this.revokeMemoryLocally();
      await this.persistRevokedMemoryConsent(authorization.userId, authorityVersion);
      this.scheduleMemoryOutboxInvalidation("CONSENT_REVOKED");
      return { enabled: false, reason: "CONSENT_VERSION_STALE" };
    }
    if (remoteConsent === true) return authorization;
    if (remoteConsent === false) {
      this.revokeMemoryLocally();
      const persisted = await this.persistRevokedMemoryConsent(authorization.userId, Math.max(
        localVersion,
        Number.isSafeInteger(authorityVersion) ? authorityVersion : 0,
        consentVersionFrom(request) ?? 0,
      ));
      this.scheduleMemoryOutboxInvalidation("CONSENT_REVOKED");
      if (!persisted) return { enabled: false, reason: "MEMORY_CONSENT_UNAVAILABLE" };
      return { enabled: false, reason: "CONSENT_REQUIRED" };
    }
    // Do not let an old in-memory brief survive an authority outage.  The
    // next request/alarm may retry the authority check; this request proceeds
    // through the baseline Agent path with an explicit empty brief.
    this.revokeMemoryLocally({ latch: false });
    return { enabled: false, reason: "MEMORY_AUTHORITY_UNAVAILABLE" };
  }

  scheduleBriefRefresh(request, authorization, event) {
    if (!authorization.enabled || (event.type !== "START_CUE" && event.type !== "START_MANUAL_CUE_VISIT") ||
      ((this.env.MEMORY_BRIEF !== undefined || this.env.memoryBrief !== undefined) && !this.memoryBriefRequiresRefresh)) return;
    const expectedEpoch = this.memoryBriefEpoch;
    const task = this.memoryBriefFromProviderBounded(request, authorization).then((brief) => {
      if (brief && expectedEpoch === this.memoryBriefEpoch && this.memoryFlagEnabled()) {
        this.memoryBrief = brief;
        this.clearMemoryBriefRefreshRequirement();
      }
      return brief;
    }).catch(() => undefined);
    this.waitUntil(task);
  }

  memorySinkFor(request, userId, expectedEpoch = this.memoryConsentEpoch) {
    const configured = this.env.MEMORY_SINK ?? this.env.memorySink;
    const binding = this.env.MEMORY_SERVICE ?? (typeof this.env.MEMORY_EVENTS === "object" ? this.env.MEMORY_EVENTS : undefined);
    const configuredEndpoint = this.env.MEMORY_EVENTS_URL ?? (typeof this.env.MEMORY_EVENTS === "string" ? this.env.MEMORY_EVENTS : undefined);
    const endpoint = configuredEndpoint || new URL("/api/memory/events", request.url).href;
    let deliver;
    if (configured) {
      deliver = async (event, entry) => configured(event, entry);
    }
    if (!deliver && binding && typeof binding.fetch === "function") {
      deliver = async (event) => {
        const body = JSON.stringify(event);
        const headers = await internalAuthHeaders(this.env, body, {
          "content-type": "application/json",
          [TRUSTED_PRINCIPAL_HEADER]: userId,
          "x-memory-principal": userId,
          "x-cs-memory-internal": "1",
        });
        return binding.fetch(new Request(endpoint, { method: "POST", headers, body }));
      };
    } else if (!deliver && typeof fetch === "function") {
      deliver = async (event) => {
        const body = JSON.stringify(event);
        const headers = await internalAuthHeaders(this.env, body, {
          "content-type": "application/json",
          [TRUSTED_PRINCIPAL_HEADER]: userId,
          "x-memory-principal": userId,
          "x-cs-memory-internal": "1",
        });
        return fetch(endpoint, { method: "POST", headers, body });
      };
    }
    if (!deliver) return undefined;
    // The guard runs inside the outbox attempt, immediately before the sink
    // starts.  A revocation increments the epoch synchronously, so a flush
    // that selected an entry before the revoke cannot start a new delivery.
    return async (event, entry) => {
      if (!this.memoryFlagEnabled() || this.memoryRevokedLatch || this.memoryOutboxCleanupPending || this.memoryOutboxCleanupFailed || expectedEpoch !== this.memoryConsentEpoch) {
        throw Object.assign(new Error("CONSENT_REVOKED"), { code: "CONSENT_REVOKED" });
      }
      const consent = await this.storedMemoryConsent();
      if (this.memoryConsentReadFailed) {
        throw Object.assign(new Error("MEMORY_AUTHORITY_UNAVAILABLE"), { code: "MEMORY_AUTHORITY_UNAVAILABLE" });
      }
      if (!consent) {
        throw Object.assign(new Error("MEMORY_AUTHORITY_UNAVAILABLE"), { code: "MEMORY_AUTHORITY_UNAVAILABLE" });
      }
      if (consent.principal !== userId || consent.consent !== "GRANTED") {
        this.revokeMemoryLocally();
        throw Object.assign(new Error("CONSENT_REVOKED"), { code: "CONSENT_REVOKED" });
      }
      // The storage read above yields to the event loop. Re-check the epoch
      // once more immediately before invoking the external sink so a revoke
      // that wins during that read cannot start a delivery.
      if (this.memoryRevokedLatch || expectedEpoch !== this.memoryConsentEpoch) {
        throw Object.assign(new Error("CONSENT_REVOKED"), { code: "CONSENT_REVOKED" });
      }
      if (this.consentProviderConfigured()) {
        // Re-check the live authority at the actual sink boundary as well as
        // during the flush preflight. A management revoke may commit between
        // those two awaits; a confirmed false result terminalizes this row,
        // while an unavailable authority remains retryable.
        const remoteConsent = await this.consentFromProviderBounded(request, userId);
        if (remoteConsent === false) {
          // The provider result may be stale by the time it returns. Re-enter
          // the authorization tail and compare both the local epoch and the
          // consent version that was read before the provider call. A newer
          // explicit grant must never be overwritten by this late false.
          const revocation = await this.runMemoryAuthorizationTask(async () => {
            const latest = await this.storedMemoryConsent();
            const sameGrant = !this.memoryConsentReadFailed && latest &&
              latest.principal === userId && latest.consent === "GRANTED" &&
              latest.consentVersion === consent.consentVersion &&
              this.memoryConsentEpoch === expectedEpoch;
            if (!sameGrant) {
              // An epoch/version mismatch means another authorization won the
              // race. The old row must not be retried after a later opt-in, but
              // do not change the newer consent state or latch it as revoked.
              if (latest?.consent !== "GRANTED" || latest.principal !== userId || this.memoryConsentReadFailed) {
                this.revokeMemoryLocally();
                this.waitUntil(this.outbox.invalidatePending("CONSENT_REVOKED").catch(() => undefined));
              }
              // A newer GRANTED version has already invalidated the old rows
              // during its consent transition. Do not run a broad pending-row
              // invalidation here: it could dead-letter events enqueued by the
              // newer opt-in while this stale provider response is unwinding.
              return "STALE";
            }
            this.revokeMemoryLocally();
            const persisted = await this.persistRevokedMemoryConsent(userId, Math.max(
              latest.consentVersion,
              Number.isSafeInteger(this.memoryAuthorityVersion) ? this.memoryAuthorityVersion : 0,
            ));
            this.waitUntil(this.outbox.invalidatePending("CONSENT_REVOKED").catch(() => undefined));
            return persisted ? "REVOKED" : "UNAVAILABLE";
          });
          if (revocation === "UNAVAILABLE") {
            throw Object.assign(new Error("MEMORY_AUTHORITY_UNAVAILABLE"), { code: "MEMORY_AUTHORITY_UNAVAILABLE" });
          }
          throw Object.assign(new Error("CONSENT_REVOKED"), { code: "CONSENT_REVOKED" });
        }
        if (remoteConsent !== true) {
          throw Object.assign(new Error("MEMORY_AUTHORITY_UNAVAILABLE"), { code: "MEMORY_AUTHORITY_UNAVAILABLE" });
        }
        if (this.memoryRevokedLatch || expectedEpoch !== this.memoryConsentEpoch) {
          throw Object.assign(new Error("CONSENT_REVOKED"), { code: "CONSENT_REVOKED" });
        }
      }
      return deliver(event, entry);
    };
  }

  /**
   * Check the authority for a background Outbox pass under the same
   * authorization tail as explicit grant/revoke requests. The tail is held
   * only through the provider decision and any revocation write; the actual
   * sink flush runs afterwards so a slow network delivery cannot delay a user
   * withdrawal.
   */
  async authorizeMemoryFlush(request, userId, expectedEpoch) {
    return this.runMemoryAuthorizationTask(async () => {
      if (!this.memoryFlagEnabled() || this.memoryRevokedLatch || expectedEpoch !== this.memoryConsentEpoch) return false;
      const localConsent = await this.storedMemoryConsent();
      if (this.memoryConsentReadFailed || !localConsent) return false;
      if (localConsent.principal !== userId || localConsent.consent !== "GRANTED") {
        this.revokeMemoryLocally();
        this.scheduleMemoryOutboxInvalidation("CONSENT_REVOKED");
        return false;
      }
      const localVersion = localConsent.consentVersion;
      if (this.consentProviderConfigured()) {
        const remoteConsent = await this.consentFromProviderBounded(request, userId);
        const afterConsent = await this.storedMemoryConsent();
        if (this.memoryConsentReadFailed || !afterConsent || afterConsent.principal !== userId ||
          afterConsent.consentVersion !== localVersion || expectedEpoch !== this.memoryConsentEpoch) {
          return false;
        }
        const authorityVersion = this.memoryAuthorityVersion;
        if (authorityVersion !== undefined && authorityVersion > localVersion) {
          // This DO missed a prior revoke/invalidation. Do not let an alarm
          // with no browser cookie reopen its old pending payload after the
          // user has since gone through a newer consent cycle.
          this.revokeMemoryLocally();
          await this.persistRevokedMemoryConsent(userId, authorityVersion);
          this.scheduleMemoryOutboxInvalidation("CONSENT_REVOKED");
          return false;
        }
        if (remoteConsent === false) {
          this.revokeMemoryLocally();
          await this.persistRevokedMemoryConsent(userId, Math.max(
            localVersion,
            Number.isSafeInteger(authorityVersion) ? authorityVersion : 0,
            consentVersionFrom(request) ?? 0,
          ));
          this.scheduleMemoryOutboxInvalidation("CONSENT_REVOKED");
          return false;
        }
        if (remoteConsent !== true) return false;
      }
      return expectedEpoch === this.memoryConsentEpoch;
    });
  }

  hasWaitUntil() {
    return typeof this.state.waitUntil === "function";
  }

  scheduleMemoryOutboxInvalidation(reason = "CONSENT_REVOKED") {
    // Authorization tasks run on memoryAuthorizationTail. Starting the
    // serialized outbox operation is safe here, but awaiting it is not: an
    // in-flight sink already owns outbox.tail and may itself be waiting for
    // this authorization tail to release.
    this.memoryOutboxCleanupPending = true;
    const authorizationRelease = this.memoryAuthorizationTail;
    const task = authorizationRelease
      .then(() => this.outbox.invalidatePending(reason))
      .then(
        (result) => {
          this.memoryOutboxCleanupPending = false;
          this.memoryOutboxCleanupFailed = false;
          return result;
        },
        () => {
          this.memoryOutboxCleanupPending = false;
          this.memoryOutboxCleanupFailed = true;
          // A failed storage operation must not reopen old payloads merely
          // because the durable consent row still says GRANTED. Keep the
          // in-process veto until a later explicit grant retries cleanup.
          this.memoryRevokedLatch = true;
          return [];
        },
      );
    this.memoryOutboxCleanupPromise = task;
    this.waitUntil(task);
    return task;
  }

  waitUntil(task) {
    if (typeof this.state.waitUntil === "function") {
      try {
        this.state.waitUntil(task);
        return;
      } catch {
        // Local fakes may expose a non-callable waitUntil implementation.
      }
    }
    void task;
  }

  enqueueMemoryEvents(events, request, authorization) {
    if (!events.length || !authorization.enabled) return Promise.resolve();
    const expectedEpoch = this.memoryConsentEpoch;
    const task = this.memoryEventTail.then(async () => {
      // Re-check the authority in the background immediately before creating
      // any Outbox row. This prevents a consent revocation between request
      // authentication and deferred persistence from creating new work.
      if (!(await this.authorizeMemoryFlush(request, authorization.userId, expectedEpoch))) return;
      for (const event of events) {
        if (expectedEpoch !== this.memoryConsentEpoch) return;
        try {
          await this.outbox.enqueue(event);
        } catch {
          // Memory is optional; a failed enqueue is retained as a diagnostic
          // limitation and must never turn a successful Coach response into a
          // request failure.
        }
      }
    }).catch(() => undefined);
    this.memoryEventTail = task;
    if (this.hasWaitUntil()) this.waitUntil(task);
    return task;
  }

  async memoryOutboxBeforeSend(userId, expectedEpoch) {
    if (!this.memoryFlagEnabled() || this.memoryRevokedLatch || expectedEpoch !== this.memoryConsentEpoch) return false;
    if (this.memoryOutboxCleanupPending || this.memoryOutboxCleanupFailed) return "SKIP";
    const localConsent = await this.storedMemoryConsent();
    if (this.memoryConsentReadFailed) return "SKIP";
    if (!localConsent) return "SKIP";
    if (localConsent.principal === userId && localConsent.consent === "GRANTED") return true;
    // This callback runs inside MemoryOutbox's serialized flush.  Do not
    // await invalidatePending here (that would queue behind the current
    // flush); the current row is terminalized by flush and the queued pass
    // handles any remaining rows.
    this.revokeMemoryLocally();
    this.waitUntil(this.outbox.invalidatePending("CONSENT_REVOKED").catch(() => undefined));
    return false;
  }

  scheduleMemoryFlush(request, authorization) {
    if (!authorization.enabled) return;
    const expectedEpoch = this.memoryConsentEpoch;
    const task = (async () => {
      // Enqueue is persist-before-send. Waiting for the current chain here
      // means a flush can never race an event that this request just built.
      await this.memoryEventTail;
      if (!(await this.authorizeMemoryFlush(request, authorization.userId, expectedEpoch))) {
        // Storage/authority uncertainty leaves rows pending for a later alarm;
        // a confirmed withdrawal is terminalized by the helper.
        return { attempted: 0, delivered: 0, retried: 0, deadLettered: 0, skipped: 0, entries: [] };
      }
      const sink = this.memorySinkFor(request, authorization.userId, expectedEpoch);
      if (!sink) return { attempted: 0, delivered: 0, retried: 0, deadLettered: 0, skipped: 0, entries: [] };
      this.outbox.setSink(sink);
      return this.outbox.flush({ beforeSend: () => this.memoryOutboxBeforeSend(authorization.userId, expectedEpoch) });
    })().catch(() => ({
      attempted: 0,
      delivered: 0,
      retried: 0,
      deadLettered: 0,
      skipped: 0,
      entries: [],
    })).finally(() => {
      this.scheduleMemoryOutboxPrune();
      this.scheduleNextMemoryAlarm(1_000);
    });
    this.waitUntil(task);
  }

  scheduleNextMemoryAlarm(fallbackDelayMs = 1_000) {
    // Feature-off is a hard zero-side-effect boundary. In particular, do not
    // keep polling legacy PENDING/RETRY rows once memory has been disabled;
    // they remain durable for a later explicit opt-in or administrative
    // purge, but must not create a one-second alarm loop.
    if (!this.memoryFlagEnabled() || this.memoryRevokedLatch || this.memoryOutboxCleanupPending || this.memoryOutboxCleanupFailed || typeof this.state.storage.setAlarm !== "function") return;
    const task = this.storedMemoryConsent().then((consent) => {
      // A persisted revoke/no-consent state is terminal for background work.
      // If invalidation previously failed, leave the rows durable but do not
      // spin a 250ms/1s alarm loop; an explicit later grant/request can
      // schedule a fresh pass. Storage uncertainty is also fail-closed.
      if (this.memoryConsentReadFailed || !consent || consent.consent !== "GRANTED") return [];
      return this.outbox.list({ status: ["PENDING", "RETRY"], limit: 256 });
    }).then((entries) => {
      if (entries.length === 0) return undefined;
      const next = entries
        .map((entry) => entry.nextAttemptAt ? Date.parse(entry.nextAttemptAt) : Date.now() + fallbackDelayMs)
        .filter((value) => Number.isFinite(value))
        .sort((left, right) => left - right)[0];
      return this.state.storage.setAlarm(Math.max(Date.now() + 250, next ?? Date.now() + fallbackDelayMs));
    }).catch(() => undefined);
    this.waitUntil(task);
  }

  memoryOutboxPruneOptions() {
    const cutoff = this.env.MEMORY_OUTBOX_PRUNE_CUTOFF ?? this.env.memoryOutboxPruneCutoff;
    const maxRetainedValue = this.env.MEMORY_OUTBOX_PRUNE_MAX_RETAINED ??
      this.env.MEMORY_OUTBOX_MAX_RETAINED ??
      this.env.memoryOutboxPruneMaxRetained;
    const maxEntriesValue = this.env.MEMORY_OUTBOX_PRUNE_MAX_ENTRIES ?? this.env.memoryOutboxPruneMaxEntries;
    // Keep terminal payloads bounded even when an operator has not supplied
    // maintenance settings. Explicit deployment values can override these
    // conservative defaults.
    const options = {
      maxRetained: DEFAULT_MEMORY_OUTBOX_MAX_RETAINED,
      maxEntries: DEFAULT_MEMORY_OUTBOX_PRUNE_BATCH,
    };
    if (typeof cutoff === "string" && cutoff.trim()) options.cutoff = cutoff.trim();
    if (maxRetainedValue !== undefined && maxRetainedValue !== null && String(maxRetainedValue).trim() !== "") {
      const maxRetained = Number(maxRetainedValue);
      if (Number.isInteger(maxRetained) && maxRetained >= 0) options.maxRetained = maxRetained;
    }
    if (maxEntriesValue !== undefined && maxEntriesValue !== null && String(maxEntriesValue).trim() !== "") {
      const maxEntries = Number(maxEntriesValue);
      if (Number.isInteger(maxEntries) && maxEntries >= 0) options.maxEntries = maxEntries;
    }
    return options;
  }

  scheduleMemoryOutboxPrune() {
    const options = this.memoryOutboxPruneOptions();
    if (!options) return;
    // Retention is maintenance only. It is deliberately detached from the
    // request/dispatch promise; a slow or unsupported delete implementation
    // must not delay the coaching response or delivery retry path.
    const task = this.outbox.prune(options).catch(() => ({ deleted: 0, eligible: 0, skipped: 0 }));
    this.waitUntil(task);
  }

  async alarm() {
    const empty = { attempted: 0, delivered: 0, retried: 0, deadLettered: 0, skipped: 0, entries: [] };
    try {
      if (!this.memoryFlagEnabled()) return empty;
      const owner = await this.storedMemoryOwner();
      if (this.memoryOwnerReadFailed) return empty;
      if (!owner) return empty;
      const consent = await this.storedMemoryConsent();
      if (this.memoryConsentReadFailed) return empty;
      if (!consent || consent.principal !== owner || consent.consent !== "GRANTED") return empty;
      let request = this.lastMemoryRequestUrl ? new Request(this.lastMemoryRequestUrl) : new Request("https://memory.invalid/");
      try {
        const endpoint = await this.state.storage.get(MEMORY_ENDPOINT_KEY);
        if (typeof endpoint === "string" && endpoint) request = new Request(endpoint);
      } catch {
        // Fall back to the current request URL or configured service binding.
      }
      const expectedEpoch = this.memoryConsentEpoch;
      if (!(await this.authorizeMemoryFlush(request, owner, expectedEpoch))) return empty;
      this.scheduleMemoryOutboxPrune();
      const sink = this.memorySinkFor(request, owner, expectedEpoch);
      if (!sink) return empty;
      this.outbox.setSink(sink);
      return await this.outbox.flush({ beforeSend: () => this.memoryOutboxBeforeSend(owner, expectedEpoch) });
    } catch {
      return empty;
    } finally {
      // Retry scheduling is part of the alarm contract, including no-sink and
      // transient-authority paths. `scheduleNextMemoryAlarm` is a no-op when
      // no pending/retry entry remains, avoiding a hot alarm loop.
      this.scheduleNextMemoryAlarm(1_000);
    }
  }

  async invalidateMemoryEndpoint(request) {
    if (request.method !== "POST") return errorResponse("METHOD_NOT_ALLOWED", 405);
    if (request.headers.get("x-cs-memory-internal") !== "1") return errorResponse("INVALID_INTERNAL_MEMORY_AUTH", 401);
    const principal = trustedPrincipalFrom(request);
    if (!principal) return errorResponse("INVALID_INTERNAL_MEMORY_AUTH", 401);
    const configuredToken = typeof this.env.MEMORY_INTERNAL_TOKEN === "string" && this.env.MEMORY_INTERNAL_TOKEN.trim().length >= 16
      ? this.env.MEMORY_INTERNAL_TOKEN.trim()
      : "";
    let body;
    const bounded = await readBoundedText(request, 8 * 1024);
    if (!bounded.ok) return errorResponse(bounded.tooLarge ? "REQUEST_TOO_LARGE" : "REQUEST_BODY_UNREADABLE", bounded.tooLarge ? 413 : 400);
    const raw = bounded.text;
    try {
      body = JSON.parse(raw);
    } catch {
      return errorResponse("INVALID_JSON", 400);
    }
    const suppliedToken = request.headers.get("x-memory-internal-token") ?? "";
    let internalAuthorized = configuredToken
      ? suppliedToken === configuredToken
      : false;
    const hmacSecret = typeof this.env.MEMORY_INTERNAL_HMAC_SECRET === "string" ? this.env.MEMORY_INTERNAL_HMAC_SECRET.trim() : "";
    if (!internalAuthorized) {
      const timestamp = request.headers.get(MEMORY_INTERNAL_TIMESTAMP_HEADER);
      const signature = request.headers.get(MEMORY_INTERNAL_SIGNATURE_HEADER);
      // Match every other internal boundary: a short HMAC secret is invalid
      // configuration and must not become an authentication mechanism.
      if (hmacSecret.length >= 16 && timestamp && signature) {
        const numericTimestamp = Number(timestamp);
        const timestampMs = Number.isFinite(numericTimestamp)
          ? (numericTimestamp < 10_000_000_000 ? numericTimestamp * 1_000 : numericTimestamp)
          : Date.parse(timestamp);
        if (Number.isFinite(timestampMs) && Math.abs(Date.now() - timestampMs) <= 5 * 60 * 1000) {
          internalAuthorized = await verifyHmacSha256Base64Url(`${timestamp}.${raw}`, signature, hmacSecret);
        }
      }
    }
    if (!internalAuthorized && !configuredToken && hmacSecret.length < 16) {
      internalAuthorized = globalThis.process?.env?.NODE_ENV === "test" && request.headers.get("x-memory-test-principal") === principal;
    }
    if (!internalAuthorized) return errorResponse("INVALID_INTERNAL_MEMORY_AUTH", 401);
    if (!isRecord(body) || (body.all !== true && (typeof body.memoryId !== "string" || body.memoryId.trim().length === 0 || body.memoryId.length > 160)) ||
      (body.logicalKey !== undefined && (typeof body.logicalKey !== "string" || body.logicalKey.trim().length === 0 || body.logicalKey.length > 160))) {
      return errorResponse("INVALID_MEMORY_INVALIDATION", 400);
    }
    // Serialize invalidation with grants, authority checks and background
    // flush preflights. Otherwise a grant that is already awaiting storage
    // could commit after this endpoint and recreate a deleted channel.
    return this.runMemoryAuthorizationTask(async () => {
      const owner = await this.storedMemoryOwner();
      if (this.memoryOwnerReadFailed) return errorResponse("MEMORY_OWNER_UNAVAILABLE", 503);
      if (!owner || owner !== principal) return errorResponse("TRUSTED_PRINCIPAL_MISMATCH", 403);
      // A deletion invalidates any cached teaching projection immediately. For
      // one aggregate use the brief-only generation so unrelated pending events
      // are not discarded; a user-wide erase also closes the consent epoch.
      if (body.all === true) {
        // A user-wide erase must survive a DO restart and a deployment without
        // a live consent provider. Persist the local REVOKED marker before
        // acknowledging the invalidation; otherwise the next request could
        // reuse a stale GRANTED row and recreate the erased outbox.
        this.revokeMemoryLocally();
        const persisted = await this.persistRevokedMemoryConsent(principal);
        if (!persisted) {
          await this.outbox.invalidatePending("MEMORY_DELETED").catch(() => undefined);
          return errorResponse("MEMORY_CONSENT_UNAVAILABLE", 503);
        }
      } else this.clearMemoryBriefLocally();
      const invalidated = body.all === true
        ? await this.outbox.invalidatePending("MEMORY_DELETED")
        : await this.outbox.invalidateMemory(body.memoryId, "MEMORY_DELETED", {
            logicalKey: typeof body.logicalKey === "string" ? body.logicalKey : undefined,
          });
      return json({ accepted: true, invalidated: invalidated.length });
    });
  }

  runtimeFor(request) {
    const endpoint = policyEndpointFor(request);
    if (endpoint && (this.policyOrigin === null || this.policyOrigin === endpoint.origin)) {
      if (!this.policyRuntime) {
        this.policyOrigin = endpoint.origin;
        this.policyEndpoint = endpoint.endpoint;
        this.policyRuntime = runtimeWithPolicy(this.saver, endpoint.endpoint);
      }
      return this.policyRuntime;
    }
    if (!this.fallbackRuntime) this.fallbackRuntime = deterministicRuntime(this.saver);
    return this.fallbackRuntime;
  }

  dispatchSerial(task) {
    const next = this.dispatchTail.then(task, task);
    this.dispatchTail = next.then(() => undefined, () => undefined);
    return next;
  }

  async fetch(request) {
    try {
      if (new URL(request.url).pathname === MEMORY_INVALIDATE_PATH) return await this.invalidateMemoryEndpoint(request);
    } catch {
      return errorResponse("INVALID_REQUEST", 400);
    }
    if (request.method !== "POST") return errorResponse("METHOD_NOT_ALLOWED", 405);
    if (!validJsonContentType(request)) return errorResponse("UNSUPPORTED_MEDIA_TYPE", 415);
    const parsed = await readEnvelope(request);
    if (parsed.error) return parsed.error;
    // One DO normally owns one session, but keep the saver's ephemeral map
    // explicitly tied to the authenticated envelope for test/future hosts.
    this.memorySessionId = parsed.envelope.sessionId;
    const authorization = await this.authorizeMemory(request);
    if (authorization.rejected) return errorResponse(authorization.reason, 403);
    // A signed browser consent header is not a live authorization decision.
    // Re-check the authority before reading this DO's cached brief or calling
    // the provider, otherwise a stale grant can leak old teaching context
    // after a management revoke.
    let effectiveAuthorization = await this.authorizeMemoryAuthority(request, authorization);
    this.lastMemoryRequestUrl = request.url;
    try {
      // Remove the client field before any provider/flag decision. Only the
      // server-side provider below may add it back.
      const { memoryBrief: _clientBrief, ...eventWithoutClientBrief } = parsed.envelope.event;
      void _clientBrief;
      let sourceEvent = eventWithoutClientBrief;
      let serverBriefLoaded = Boolean(effectiveAuthorization.enabled && this.memoryBrief);
      let trustedBrief = effectiveAuthorization.enabled ? this.briefFromEventOrEnvironment(sourceEvent) : undefined;
      if (
        effectiveAuthorization.enabled &&
        !this.memoryBrief &&
        (sourceEvent.type === "START_CUE" || sourceEvent.type === "START_MANUAL_CUE_VISIT")
      ) {
        const briefEpoch = this.memoryBriefEpoch;
        const fetchedBrief = await this.memoryBriefFromProviderBounded(request, effectiveAuthorization);
        // A revoke may win while the optional provider is in flight. Recheck
        // both the local generation and the live authority before allowing
        // the returned projection to enter the graph.
        const authorityAfterFetch = briefEpoch === this.memoryBriefEpoch
          ? await this.authorizeMemoryAuthority(request, effectiveAuthorization)
          : { enabled: false, reason: "CONSENT_REQUIRED" };
        if (!authorityAfterFetch.enabled || briefEpoch !== this.memoryBriefEpoch) {
          effectiveAuthorization = authorityAfterFetch;
          sourceEvent = eventWithoutClientBrief;
          trustedBrief = undefined;
          serverBriefLoaded = false;
        } else if (fetchedBrief) {
          sourceEvent = { ...sourceEvent, memoryBrief: fetchedBrief };
          trustedBrief = fetchedBrief;
          this.memoryBrief = fetchedBrief;
          this.clearMemoryBriefRefreshRequirement();
          serverBriefLoaded = true;
        }
      }
      // Never pass the browser's optional memoryBrief through, including on a
      // later cue after a trusted brief has been cached in this DO.
      let event = this.memoryBriefForEvent(sourceEvent, effectiveAuthorization, trustedBrief);
      const dispatchEpoch = this.memoryBriefEpoch;
      const result = await this.dispatchSerial(async () => {
        // A consent route can commit REVOKED after the provider/brief phase
        // above but before this serialized dispatch starts. Perform one final
        // authority check at the dispatch boundary; if it fails, strip the
        // cached brief and keep the baseline graph path. This is the closest
        // linearization point available across the independent Node/DO
        // storage systems and complements the sink-side check below.
        if (effectiveAuthorization.enabled) {
          const dispatchAuthorization = await this.authorizeMemoryAuthority(request, effectiveAuthorization);
          if (!dispatchAuthorization.enabled) {
            effectiveAuthorization = dispatchAuthorization;
            event = this.memoryBriefForEvent(sourceEvent, dispatchAuthorization);
          }
        }
        // Do not dispatch a brief captured before a concurrent revoke. The
        // graph still runs the same baseline event with its brief cleared.
        if (effectiveAuthorization.enabled && this.memoryBriefEpoch !== dispatchEpoch) {
          event = this.memoryBriefForEvent(sourceEvent, { enabled: false, reason: "CONSENT_REQUIRED" });
        }
        const dispatched = parseRemoteCoachAgentDispatchResponse(
          await this.runtimeFor(request).dispatch(event),
        );
        if (effectiveAuthorization.enabled) {
          // Build and persist the primary cue event independently from the
          // optional transfer-application projection. A malformed secondary
          // event must never erase a valid diagnosis from the durable outbox.
          let cueMemoryEvent;
          try {
            cueMemoryEvent = buildCueMemoryEvent(event, dispatched, authorization.userId);
          } catch {
            cueMemoryEvent = undefined;
          }
          const memoryEvents = [];
          if (cueMemoryEvent) {
            memoryEvents.push(cueMemoryEvent);
            try {
              const applicationMemoryEvent = buildTransferApplicationMemoryEvent(
                event,
                dispatched,
                authorization.userId,
                cueMemoryEvent,
              );
              if (applicationMemoryEvent) memoryEvents.push(applicationMemoryEvent);
            } catch {
              // A secondary application event is best effort.
            }
          } else {
            try {
              const completionMemoryEvent = buildCompletionMemoryEvent(event, dispatched, authorization.userId);
              if (completionMemoryEvent) memoryEvents.push(completionMemoryEvent);
            } catch {
              // Completion metadata is optional and must not block baseline.
            }
          }
          const memoryTask = this.enqueueMemoryEvents(memoryEvents, request, effectiveAuthorization);
          // Cloudflare Durable Object State always supplies waitUntil. Local
          // fakes do not, so await only in that test/development harness to
          // make storage assertions deterministic without slowing production.
          if (!this.hasWaitUntil()) await memoryTask;
        }
        return dispatched;
      });
      // Pass the original event so a transient provider failure can be
      // refreshed asynchronously; the prepared event may contain the empty
      // fallback brief inserted above.
      if (!serverBriefLoaded) this.scheduleBriefRefresh(request, effectiveAuthorization, parsed.envelope.event);
      this.scheduleMemoryFlush(request, effectiveAuthorization);
      return json(result);
    } catch {
      return errorResponse("DISPATCH_FAILED", 500);
    }
  }
}

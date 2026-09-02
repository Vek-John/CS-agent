import {
  createCoachAgentRuntime,
  MemoryBriefWireSchema,
  parseRemoteCoachAgentDispatchEnvelope,
  parseRemoteCoachAgentDispatchResponse,
  type CoachAgentRuntime,
} from "@cs-coach/coach-agent";
import { buildAgentMemoryBrief, type UserMemoryBrief } from "@cs-coach/memory";
import { getSqliteCheckpointSaver } from "@cs-coach/memory-sqlite/server";
import { currentDesktopReviewLibrary } from "@cs-coach/review-library/server";
import { after as scheduleAfter } from "next/server";
import { ensureRequestPrincipal, withCookie } from "../../../../lib/memory/api";
import { getMemoryRuntime, memoryPersistenceUnavailable } from "../../../../lib/memory/server";
import {
  buildLocalAgentMemoryEvents,
  desktopBehaviorOpportunityClaim,
} from "../../../../lib/memory/agent-events";
import { sameOriginRequest } from "../../../../lib/desktop/request-origin";

export const dynamic = "force-dynamic";

const MAX_REMOTE_REQUEST_BYTES = 64 * 1024;
const MEMORY_READ_TIMEOUT_MS = 250;
const runtimes = new Map<string, CoachAgentRuntime>();
const localPersistenceTails = new Map<string, Promise<void>>();

function json(body: unknown, status = 200): Response {
  return Response.json(body, {
    status,
    headers: { "cache-control": "no-store" },
  });
}

function runtimeFor(sessionId: string): CoachAgentRuntime {
  const desktop = (process.env.DEPLOY_TARGET ?? "").trim().toLowerCase() === "desktop";
  const runtimeKey = `${desktop ? "sqlite" : "memory"}:${sessionId}`;
  const existing = runtimes.get(runtimeKey);
  if (existing) return existing;
  const runtime = desktop
    ? createCoachAgentRuntime({ checkpointer: getSqliteCheckpointSaver(), checkpoint: "sqlite", checkpointBackend: "SQLITE" })
    : createCoachAgentRuntime();
  runtimes.set(runtimeKey, runtime);
  return runtime;
}

function stripClientMemoryBrief<T extends { event: Record<string, unknown> }>(envelope: T): T {
  // The local route has no trusted MemoryService injection seam. Treat every
  // browser brief as untrusted and remove it before the graph can read it;
  // this keeps the feature-off/local fallback path identical to the DO gate.
  const { memoryBrief: _clientBrief, ...event } = envelope.event;
  void _clientBrief;
  const sanitizedEvent = event.type === "START_CUE" || event.type === "START_MANUAL_CUE_VISIT"
    ? { ...event, memoryBrief: null }
    : event;
  return { ...envelope, event: sanitizedEvent } as T;
}

function stripRawClientBrief(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const candidate = value as { event?: unknown };
  if (!candidate.event || typeof candidate.event !== "object" || Array.isArray(candidate.event)) return value;
  const { memoryBrief: _clientBrief, ...event } = candidate.event as Record<string, unknown>;
  void _clientBrief;
  return { ...candidate, event };
}

function stripBriefIdentity(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripBriefIdentity);
  if (!value || typeof value !== "object") return value;
  const forbidden = new Set([
    "userId", "principal", "cookie", "rawDemo", "raw_demo", "demoBytes", "demo_bytes", "frames", "ticks",
    "fullReplay", "full_replay", "replay", "tickStream", "tick_stream", "prompt", "chainOfThought",
    "chain_of_thought", "cot", "memoryId", "logicalKey", "proposalId", "eventId", "idempotencyKey",
    "sessionId", "demoContentHash", "cueId", "caseId", "threadId", "refId", "previousRevisionId",
    "lastIdempotencyKey", "correctionId", "sourceThreadId", "targetMemoryId", "refs", "sourceRefs",
    "demoContentHashes", "supportingRefs", "contradictingRefs", "evidenceCueIds", "successfulCueIds",
    "conflictingCueIds", "claimIds", "evidenceRefs", "adviceRefs",
  ]);
  return Object.fromEntries(Object.entries(value).filter(([key]) => !forbidden.has(key)).map(([key, child]) => [key, stripBriefIdentity(child)]));
}

function agentBrief(value: unknown): import("@cs-coach/coach-agent").MemoryBriefWire | undefined {
  try {
    const candidate = stripBriefIdentity(buildAgentMemoryBrief(value as UserMemoryBrief));
    const parsed = MemoryBriefWireSchema.safeParse(candidate);
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

async function boundedMemoryRead<T>(operation: () => Promise<T>, fallback: T): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation().catch(() => fallback),
      new Promise<T>((resolve) => {
        timer = setTimeout(() => resolve(fallback), MEMORY_READ_TIMEOUT_MS);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function scheduleLocalMemoryPersistence(userId: string, task: () => Promise<unknown>): void {
  // Next's `after` keeps optional persistence outside the response critical
  // path on supported runtimes. Keep a per-principal tail as well: a second
  // request (for example a disagreement immediately after a reflection) must
  // not run its correction before the first cue projection has materialized.
  // Direct route-handler tests do not have a request async context, so retain
  // a harmless best-effort immediate fallback when `after` throws.
  const prior = localPersistenceTails.get(userId) ?? Promise.resolve();
  let release: (() => void) | undefined;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let started = false;
  let next: Promise<void>;
  const start = (): Promise<void> => {
    if (!started) {
      started = true;
      release?.();
    }
    return next;
  };
  next = prior
    .catch(() => undefined)
    .then(() => gate)
    .then(() => task())
    .then(() => undefined, () => undefined);
  localPersistenceTails.set(userId, next);
  void next.then(() => {
    if (localPersistenceTails.get(userId) === next) localPersistenceTails.delete(userId);
  });
  try {
    scheduleAfter(() => start());
  } catch {
    void start();
  }
}

export async function POST(request: Request): Promise<Response> {
  if (!sameOriginRequest(request)) return json({ schemaVersion: "coach-agent-remote-error.v1", reason: "CROSS_ORIGIN" }, 403);
  if (request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() !== "application/json") {
    return json({ schemaVersion: "coach-agent-remote-error.v1", reason: "UNSUPPORTED_MEDIA_TYPE" }, 415);
  }
  const declaredLength = request.headers.get("content-length");
  if (declaredLength !== null) {
    const length = Number(declaredLength);
    if (!Number.isFinite(length) || length < 0 || length > MAX_REMOTE_REQUEST_BYTES) {
      return json({ schemaVersion: "coach-agent-remote-error.v1", reason: "REQUEST_TOO_LARGE" }, 413);
    }
  }
  const raw = await request.text();
  if (new TextEncoder().encode(raw).byteLength > MAX_REMOTE_REQUEST_BYTES) {
    return json({ schemaVersion: "coach-agent-remote-error.v1", reason: "REQUEST_TOO_LARGE" }, 413);
  }
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return json({ schemaVersion: "coach-agent-remote-error.v1", reason: "INVALID_JSON" }, 400);
  }
  let envelope;
  try {
    envelope = stripClientMemoryBrief(parseRemoteCoachAgentDispatchEnvelope(stripRawClientBrief(value)));
  } catch {
    return json({ schemaVersion: "coach-agent-remote-error.v1", reason: "INVALID_ENVELOPE" }, 400);
  }
  let responseCookie: string | undefined;
  let memoryRuntime: ReturnType<typeof getMemoryRuntime> | undefined;
  let memoryPrincipalId: string | undefined;
  let memoryConsentVersion: number | undefined;
  let dispatchEnvelope = envelope;
  try {
    // The local runtime is deliberately process-local, but when the optional
    // memory feature is enabled it still uses the same signed anonymous
    // principal and server-derived brief contract as the DO path.
    memoryRuntime = getMemoryRuntime();
    if (memoryRuntime.featureEnabled) {
      const principal = await ensureRequestPrincipal(request);
      responseCookie = principal.setCookie;
      memoryPrincipalId = principal.principal.id;
      if (await boundedMemoryRead(() => memoryRuntime!.isAuthorized(memoryPrincipalId!), false) &&
        (envelope.event.type === "START_CUE" || envelope.event.type === "START_MANUAL_CUE_VISIT")) {
        const authorization = await boundedMemoryRead(
          () => memoryRuntime!.getAuthorization(memoryPrincipalId!),
          undefined,
        );
        // Compare against the durable store when it exposes a version. The
        // signed cookie is an input hint and may legitimately be newer than a
        // legacy row that predates consent-version support; treating that
        // mismatch as a revoke would drop a valid local brief.
        memoryConsentVersion = authorization?.consentVersion;
        const brief = agentBrief(await boundedMemoryRead(
          () => memoryRuntime!.service.getBrief(memoryPrincipalId!),
          undefined,
        ));
        if (brief) dispatchEnvelope = { ...envelope, event: { ...envelope.event, memoryBrief: brief } };
      }
    }
    // The local route has no Durable Object sink boundary. Recheck consent
    // and its monotonic version immediately before dispatch so a revoke that
    // wins while the brief is loading falls back to the baseline event.
    const dispatchEventWithBrief = dispatchEnvelope.event.type === "START_CUE" || dispatchEnvelope.event.type === "START_MANUAL_CUE_VISIT"
      ? dispatchEnvelope.event
      : undefined;
    if (memoryRuntime?.featureEnabled && memoryPrincipalId && dispatchEventWithBrief?.memoryBrief) {
      const stillAuthorized = await boundedMemoryRead(
        () => memoryRuntime!.isAuthorized(memoryPrincipalId!),
        false,
      );
      const latestAuthorization = await boundedMemoryRead(
        () => memoryRuntime!.getAuthorization(memoryPrincipalId!),
        undefined,
      );
      if (!stillAuthorized || !latestAuthorization || (memoryConsentVersion !== undefined &&
        (latestAuthorization?.consentVersion ?? 0) !== memoryConsentVersion)) {
        dispatchEnvelope = stripClientMemoryBrief(dispatchEnvelope);
      }
    }
    const result = parseRemoteCoachAgentDispatchResponse(
      await runtimeFor(dispatchEnvelope.sessionId).dispatch(dispatchEnvelope.event),
    );
    const expectedBackend = (process.env.DEPLOY_TARGET ?? "").trim().toLowerCase() === "desktop" ? "SQLITE" : "MEMORY";
    if (result.checkpoint.backend !== expectedBackend || result.checkpoint.recoverableAfterRefresh !== (expectedBackend === "SQLITE")) {
      return json({ schemaVersion: "coach-agent-remote-error.v1", reason: "LOCAL_BACKEND_CONTRACT" }, 500);
    }
    if (memoryRuntime?.featureEnabled && memoryPrincipalId && !memoryPersistenceUnavailable(memoryRuntime)) {
      const events = buildLocalAgentMemoryEvents(dispatchEnvelope.event, result, memoryPrincipalId);
      if (events.length > 0) {
        const persistenceRuntime = memoryRuntime;
        const persistencePrincipalId = memoryPrincipalId;
        scheduleLocalMemoryPersistence(persistencePrincipalId, async () => {
          // Re-check consent inside the deferred task so a revocation between
          // dispatch and persistence cannot create a new local memory write.
          if (!(await boundedMemoryRead(() => persistenceRuntime.isAuthorized(persistencePrincipalId), false))) return;
          // The primary CUE_DIAGNOSED event establishes the logical aggregate
          // that a following TRANSFER_RULE_APPLIED event updates. Persist the
          // local fallback events in producer order; concurrent repository
          // calls could let the secondary event observe no current row and
          // silently lose its application counters.
          for (const event of events) {
            const opportunity = desktopBehaviorOpportunityClaim(
              event,
              result.identity.selectedPlayerId,
              result.identity.routeHash,
            );
            if (opportunity) {
              const library = currentDesktopReviewLibrary();
              if (library) {
                // The SQLite claim is the durable first-writer gate. A later
                // analysis revision may update evidence provenance but must
                // not reach the reducer as another behavior opportunity.
                const claim = await library
                  .claimMemoryOpportunity(opportunity)
                  .catch(() => undefined);
                if (!claim?.claimed) continue;
              }
            }
            await persistenceRuntime.service.ingestEvent(persistencePrincipalId, event).catch(() => undefined);
          }
        });
      }
    }
    return withCookie(json(result), responseCookie);
  } catch {
    return withCookie(json({ schemaVersion: "coach-agent-remote-error.v1", reason: "DISPATCH_FAILED" }, 500), responseCookie);
  }
}

export function GET(): Response {
  return json({ schemaVersion: "coach-agent-remote-error.v1", reason: "METHOD_NOT_ALLOWED" }, 405);
}

export function PUT(): Response {
  return json({ schemaVersion: "coach-agent-remote-error.v1", reason: "METHOD_NOT_ALLOWED" }, 405);
}

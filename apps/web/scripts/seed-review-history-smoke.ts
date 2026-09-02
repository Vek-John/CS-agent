import { COACH_AGENT_GRAPH_VERSION } from "@cs-coach/coach-agent/client";
import {
  buildCs2dAnalysisBundle,
  CS2D_ADAPTER_VERSION,
  type Cs2dReplay,
} from "@cs-coach/cs2d-analysis-adapter";
import {
  buildCoachingPackage,
  buildOutcomeImpactForCue,
  buildOutcomePackage,
  deterministicNarrationBundle,
} from "@cs-coach/review-planner";
import { createCoachingSession } from "@cs-coach/session";
import { buildInitialCoachingRouteState } from "../lib/coaching/cs2d-route-integration";
import {
  buildSessionRecoveryRecord,
  createRecoverySessionIdentity,
} from "../lib/recovery/cs2d-session-recovery";

interface SeedInput {
  readonly appOrigin: string;
  readonly sessionToken: string;
  readonly demoContentHash: string;
}

async function readInput(): Promise<SeedInput> {
  let text = "";
  for await (const chunk of process.stdin) text += String(chunk);
  const value = JSON.parse(text) as Partial<SeedInput>;
  if (
    !/^http:\/\/127\.0\.0\.1:[1-9]\d*$/u.test(value.appOrigin ?? "") ||
    !/^[A-Za-z0-9_-]{43}$/u.test(value.sessionToken ?? "") ||
    !/^[0-9a-f]{64}$/u.test(value.demoContentHash ?? "")
  ) throw new Error("SEED_INPUT_INVALID");
  return value as SeedInput;
}

function state(steamId: string, tick: number, health: number, selectedPlayerId: string) {
  return {
    steamId,
    x: 100 + tick / 10,
    y: 200 + tick / 10,
    z: 64,
    yaw: 90,
    health,
    alive: health > 0,
    side: steamId === selectedPlayerId ? "T" as const : "CT" as const,
    weapon: steamId === selectedPlayerId ? "AK-47" : "M4A1-S",
    lastPlaceName: "Connector",
    money: 4_200,
    equipValue: 5_000,
    armor: 100,
    helmet: true,
    grenades: ["Smoke"],
  };
}

function replay(selectedPlayerId: string): Cs2dReplay {
  const opponent = "smoke-opponent";
  return {
    map: "de_mirage",
    demoTickRate: 64,
    frameRate: 8,
    players: [
      { steamId: selectedPlayerId, name: "Selected player", startSide: "T" },
      { steamId: opponent, name: "Opponent", startSide: "CT" },
    ],
    rounds: [{
      number: 1,
      freezeStartTick: 4_000,
      startTick: 4_100,
      decidedTick: 4_800,
      endTick: 4_900,
      postEndTick: 5_000,
      winner: "CT",
      scoreCt: 0,
      scoreT: 0,
      frames: [
        { tick: 4_100, t: 1, players: [state(selectedPlayerId, 4_100, 100, selectedPlayerId), state(opponent, 4_100, 100, selectedPlayerId)] },
        { tick: 4_300, t: 4, players: [state(selectedPlayerId, 4_300, 70, selectedPlayerId), state(opponent, 4_300, 100, selectedPlayerId)] },
        { tick: 4_493, t: 7, players: [state(selectedPlayerId, 4_493, 0, selectedPlayerId), state(opponent, 4_493, 100, selectedPlayerId)] },
      ],
      events: [{
        type: "kill",
        tick: 4_493,
        t: 7,
        attackerSteamId: opponent,
        victimSteamId: selectedPlayerId,
        assisterSteamId: null,
        assistedFlash: false,
        weapon: "M4A1-S",
        headshot: false,
        x: 549,
        y: 649,
        z: 64,
      }],
      grenadePaths: [],
    }],
  };
}

async function main() {
  const input = await readInput();
  const baseHeaders = {
    cookie: `cs_agent_runtime=${input.sessionToken}`,
    origin: input.appOrigin,
    "sec-fetch-site": "same-origin",
  };
  const request = async <T>(pathname: string, init: RequestInit = {}): Promise<T> => {
    const response = await fetch(`${input.appOrigin}${pathname}`, {
      ...init,
      headers: { ...baseHeaders, ...init.headers },
    });
    const body = await response.json().catch(() => undefined) as T | { code?: string } | undefined;
    if (!response.ok) {
      const code = body && typeof body === "object" && "code" in body ? body.code : "UNKNOWN";
      throw new Error(`SEED_HTTP_${response.status}_${String(code)}`);
    }
    return body as T;
  };
  const json = (value: unknown): RequestInit => ({
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(value),
  });

  let reviewId: string | undefined;
  for (let attempt = 0; attempt < 50 && !reviewId; attempt += 1) {
    const page = await request<{ items: Array<{ reviewId: string; status: string; demoStatus: string }> }>(
      "/api/review-history",
      { cache: "no-store" },
    );
    reviewId = page.items.find((item) => item.demoStatus === "READY" && item.status === "PREPARING")?.reviewId;
    if (!reviewId) await new Promise((resolve) => setTimeout(resolve, 100));
  }
  if (!reviewId) throw new Error("SEED_REVIEW_NOT_FOUND");
  const detail = await request<{
    review: { id: string; demoId: string; selectedPlayerId: string };
  }>(`/api/review-history/${encodeURIComponent(reviewId)}`, { cache: "no-store" });
  if (detail.review.id !== reviewId || !detail.review.demoId || !detail.review.selectedPlayerId) {
    throw new Error("SEED_REVIEW_IDENTITY_INVALID");
  }

  const analysis = buildCs2dAnalysisBundle({
    replay: replay(detail.review.selectedPlayerId),
    selectedSteamId: detail.review.selectedPlayerId,
    demoId: `cs2d-${input.demoContentHash}`,
    demoContentHash: input.demoContentHash,
    demoContentHashLatencyMs: 1,
  });
  const narrationByCue = Object.fromEntries(analysis.review_plan.cues.map((cue) => {
    const coaching = buildCoachingPackage(cue, analysis.candidate_set, analysis.observation_evidence);
    const impact = buildOutcomeImpactForCue(
      cue,
      analysis.candidate_set,
      analysis.win_probability_timeline,
      analysis.match_timeline,
      analysis.selected_steam_id,
    );
    return [cue.id, deterministicNarrationBundle(
      coaching,
      buildOutcomePackage(cue, analysis.candidate_set, impact),
    )];
  }));
  const readiness = Object.fromEntries(
    analysis.review_plan.cues.map((cue) => [cue.id, "READY" as const]),
  );
  const route = buildInitialCoachingRouteState(analysis.review_plan, {
    narrationByCue,
    readiness,
  });
  const identity = createRecoverySessionIdentity();
  const session = createCoachingSession(analysis.review_plan, identity.sessionId, route);
  const recovery = buildSessionRecoveryRecord({
    identity,
    demoContentHash: input.demoContentHash,
    selectedPlayerId: detail.review.selectedPlayerId,
    plan: analysis.review_plan,
    routeState: route,
    session,
    boundaryKind: "ROUTE_START",
    narrationByCue,
    analysis,
    agentCheckpointId: null,
  });
  const revision = await request<{ revisionId: string }>(
    `/api/review-history/${encodeURIComponent(reviewId)}/revisions`,
    json({
      mode: "SELECT_PLAYER",
      routeId: analysis.review_plan.id,
      routeHash: route.routeFingerprint,
      analysisVersion: CS2D_ADAPTER_VERSION,
      graphVersion: COACH_AGENT_GRAPH_VERSION,
      promptVersion: analysis.review_plan.generation_manifest.prompt_version,
      modelMetadata: { source: "desktop-real-demo-history-smoke", deterministic: true },
    }),
  );
  const append = async (
    artifactType: string,
    artifactKey: string,
    schemaVersion: string,
    payload: unknown,
  ) => request(
    `/api/review-history/${encodeURIComponent(reviewId)}/artifacts`,
    json({
      revisionId: revision.revisionId,
      artifactType,
      artifactKey,
      artifactRevision: 1,
      schemaVersion,
      payload,
      idempotencyKey: `${revision.revisionId}:${artifactType}:${artifactKey}:v1`.slice(0, 160),
    }),
  );
  await append("ANALYSIS_BUNDLE", analysis.demo_id, "cs2d-analysis-bundle.v1", analysis);
  await append("CANDIDATE_SET", analysis.candidate_set.id, "candidate-set.v1", analysis.candidate_set);
  await append("REVIEW_PLAN", analysis.review_plan.id, "review-plan.v1", analysis.review_plan);
  for (const [cueId, narration] of Object.entries(narrationByCue)) {
    await append("NARRATION_BUNDLE", cueId, "narration-bundle.v1", narration);
  }
  await append(
    "SESSION_RECOVERY",
    recovery.boundary.boundaryId,
    "session-recovery-record.v2",
    recovery,
  );
  await request(
    `/api/review-history/${encodeURIComponent(reviewId)}/runtime-head`,
    {
      ...json({
        reviewRevisionId: revision.revisionId,
        recoveryArtifactKey: recovery.boundary.boundaryId,
        sessionId: identity.sessionId,
        runId: identity.runId,
        demoId: detail.review.demoId,
        demoContentHash: input.demoContentHash,
        selectedPlayerId: detail.review.selectedPlayerId,
        routeId: analysis.review_plan.id,
        routeHash: route.routeFingerprint,
        recoveryBoundary: "ROUTE_START",
        defaultRouteCursor: 0,
        completedCueCount: 0,
        totalCueCount: analysis.review_plan.cues.length,
        stableProgress: { routeFrozen: true, readiness },
        reviewStatus: "IN_PROGRESS",
      }),
      method: "PUT",
    },
  );
  process.stdout.write(`${JSON.stringify({
    ok: true,
    reviewId,
    revisionId: revision.revisionId,
    cueCount: analysis.review_plan.cues.length,
    selectedPlayerId: detail.review.selectedPlayerId,
  })}\n`);
}

void main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : "SEED_FAILED"}\n`);
  process.exitCode = 1;
});

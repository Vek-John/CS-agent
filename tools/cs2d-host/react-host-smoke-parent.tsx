import { SessionRecoveryRecordSchema, parseRemoteCoachAgentDispatchResponse } from "../../libs/coach-agent/src/remote-dispatch-client";
import { syntheticRecoveryAdmission, observeSyntheticRecoveryWrites, type SyntheticRecoveryMarker } from "./react-host-smoke-selection";
import React from "react";
import { createRoot } from "react-dom/client";
import { Cs2dPlaybackHost } from "../../apps/web/components/playback/cs2d-playback-host";
import { deserializeCs2dAnalysisBundle } from "../../libs/cs2d-analysis-adapter/src/index";
import { deterministicDirectorFallback } from "../../libs/review-planner/src/index";
import { isPlaybackEventEnvelope } from "../../libs/contracts/src/playback-bridge";
import { createCs2dReviewPreparationDependencies, type ReviewPreparationDependencies } from "../../apps/web/lib/coaching/cs2d-route-integration";
import { teachingDiagnosticsEnabled } from "../../apps/web/lib/playback/cs2d-playback-host";
import { requestNarrationBundle } from "../../apps/web/lib/coaching/narrator-contract";
import "../../apps/web/app/globals.css";

const ordinaryRecovery = new URLSearchParams(location.search).get("ordinaryRecovery") === "1";
const ordinaryCued = ordinaryRecovery && new URLSearchParams(location.search).get("ordinaryCued") === "1";
const realDemo = new URLSearchParams(location.search).get("realDemo") === "1";
const emptyRoute = !realDemo && ((ordinaryRecovery && !ordinaryCued) || new URLSearchParams(location.search).get("emptyRoute") === "1");
const ammo = !realDemo && !emptyRoute && new URLSearchParams(location.search).get("ammo") === "1";
const selfBlind = !realDemo && !emptyRoute && new URLSearchParams(location.search).get("selfBlind") === "1";
const summary = document.querySelector<HTMLPreElement>("#summary")!, load = document.querySelector<HTMLButtonElement>("#load")!;
const reloadButton = document.querySelector<HTMLButtonElement>("#reload-recovery");
const recovery = { enabled: ordinaryRecovery, cued: ordinaryCued, reload: false, ordinaryCommits: 0, targetTick: null as number | null,
  armed: false, reconnectRequests: 0, reconnectMatched: false, resumedAfterReconnect: false,
  firstRun: null as SyntheticRecoveryMarker["firstRun"] | null, trace: [] as Array<{ event: string; tick?: number; playing?: boolean }> };
let marker: SyntheticRecoveryMarker | undefined;
const markerKey = "cs-agent-synthetic-recovery-run.v1";
const trace = (event: string, tick?: number, playing?: boolean) => { if (recovery.trace.length < 48) recovery.trace.push({ event, ...(tick === undefined ? {} : { tick }), ...(playing === undefined ? {} : { playing }) }); };
const state = { recovery, mounted: false, childReady: false, stageReady: 0 as number | null, replayReady: 0, selected: 0, analysisReady: 0, prepareRoute: 0, prepareNarration: 0,
  agentRequests: 0, forbiddenFetches: 0, providerFetches: 0, playbackReports: 0, playing: false, tick: 0, acks: 0,
  errors: [] as string[], emptyRouteFixture: emptyRoute, candidateCount: null as number | null, cueCount: null as number | null, segmentCount: null as number | null, selfBlindFixture: selfBlind, ammoFixture: ammo, syntheticIdentity: true, parserEnabled: false, modelEnabled: false, diagnostics: teachingDiagnosticsEnabled(location.search), realLifecycle: null as Record<string, unknown> | null };
if (realDemo) { load.hidden = true; state.syntheticIdentity = false; state.parserEnabled = true; state.modelEnabled = true; state.stageReady = null; }
const render = () => { summary.textContent = JSON.stringify(state, null, 2); };
const fail = (code: string) => { if (!state.errors.includes(code)) state.errors.push(code); render(); };
const nativeFetch = window.fetch.bind(window);
window.fetch = async (input, init) => {
  const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, location.origin);
  if (url.origin !== location.origin || !["/api/coaching/agent", "/generated-assets/items/catalog.json", ...(ordinaryRecovery ? ["/smoke-run.json"] : [])].includes(url.pathname)) {
    state.forbiddenFetches++; render(); throw Error("SMOKE_FETCH_FORBIDDEN");
  }
  if (url.pathname === "/api/coaching/agent") state.agentRequests++;
  let reconnect = false;
  if (ordinaryRecovery && url.pathname === "/api/coaching/agent" && typeof init?.body === "string") {
    const body = JSON.parse(init.body); reconnect = body?.event?.type === "RECONNECT_REPLAY";
    if (reconnect) { recovery.reconnectRequests++; trace("reconnect-request"); }
  }
  render();
  const response = await nativeFetch(input, init);
  if (reconnect && response.ok) {
    const result = parseRemoteCoachAgentDispatchResponse(await response.clone().json());
    recovery.reconnectMatched = result.restored === "MATCHED"; trace(recovery.reconnectMatched ? "reconnect-matched" : "reconnect-rejected"); render();
  }
  return response;
};
let dependencies: ReviewPreparationDependencies | undefined;
const input: ReviewPreparationDependencies = {
  prepareRoute: request => { state.prepareRoute++; render(); if (!dependencies) throw Error("SMOKE_ANALYSIS_MISSING"); return dependencies.prepareRoute(request); },
  prepareNarration: request => { state.prepareNarration++; render(); if (!dependencies) throw Error("SMOKE_ANALYSIS_MISSING"); return dependencies.prepareNarration(request); },
};
const iframe = () => document.querySelector<HTMLIFrameElement>("#host iframe");
window.addEventListener("message", event => {
  if (event.origin !== location.origin || event.source !== iframe()?.contentWindow) return;
  if (event.data?.channel === "react-host-smoke") {
    if (realDemo && event.data.type === "real-lifecycle") { state.realLifecycle = event.data.summary; state.childReady = true; }
    if (event.data.type === "shell-ready") { state.childReady = true; load.disabled = false; }
    if (ordinaryRecovery && event.data.type === "recovery-command" && ["pause", "play", "seekCanonicalTick"].includes(event.data.command)) {
      trace(`command-${event.data.command}`, Number.isSafeInteger(event.data.tick) ? event.data.tick : undefined);
      if (recovery.reload && event.data.command === "play" && !recovery.reconnectMatched) fail("PLAY_COMMAND_BEFORE_RECONNECT");
      render();
    }
    if (event.data.type === "stage-ready") state.stageReady = (state.stageReady ?? 0) + 1;
    if (event.data.type === "error") fail("CHILD_ERROR"); render(); return;
  }
  if (!isPlaybackEventEnvelope(event.data)) return;
  const payload = event.data.payload;
  if (payload.type === "REPLAY_READY") state.replayReady++;
  if (payload.type === "PLAYER_SELECTED") state.selected++;
  if (payload.type === "PLAYBACK_STATE") { state.playbackReports++; state.tick = payload.canonicalTick; state.playing = payload.playing;
    if (ordinaryRecovery) {
      if (recovery.reload && !payload.playing && recovery.targetTick !== null && Math.abs(payload.canonicalTick - recovery.targetTick) <= 1 && recovery.trace.some(item => item.event === "command-seekCanonicalTick" && item.tick === recovery.targetTick) && !recovery.trace.some(item => item.event === "paused-at-boundary")) trace("paused-at-boundary", payload.canonicalTick, false);
      if (recovery.reload && payload.playing && !recovery.resumedAfterReconnect) {
        trace("playing-after-reload", payload.canonicalTick, true); recovery.resumedAfterReconnect = recovery.reconnectMatched;
        if (!recovery.reconnectMatched) fail("PLAY_BEFORE_RECONNECT");
      }
    }
  }
  if (payload.type === "TEACHING_TOOL_ACK") state.acks++;
  if (realDemo && (payload.type === "ANALYSIS_READY" || payload.type === "ANALYSIS_FAILED")) iframe()?.contentWindow?.postMessage({ channel: "real-demo-smoke", type: payload.type === "ANALYSIS_READY" ? "analysis-delivered" : "analysis-failed" }, location.origin);
  if (payload.type === "ANALYSIS_READY") {
    state.analysisReady++;
    const analysis = deserializeCs2dAnalysisBundle(payload.bundleJson);
    state.candidateCount = analysis.candidate_set.candidates.length; state.cueCount = analysis.review_plan.cues.length; state.segmentCount = analysis.review_plan.segments.length;
    dependencies = createCs2dReviewPreparationDependencies({ candidateSet: analysis.candidate_set, observationEvidence: analysis.observation_evidence,
      matchTimeline: analysis.match_timeline, winProbabilityTimeline: analysis.win_probability_timeline, selectedPlayerId: analysis.selected_steam_id }, {
      assessDecisions: async candidateSet => ({ candidateSet, run: { version: "decision-assessment-run.v1", mode: "RULE_BASELINE", calls: 0, accepted: 0, records: [] } }),
      director: async set => deterministicDirectorFallback(set),
      narrator: (context, options) => requestNarrationBundle(context, { ...options, fetcher: async () => { state.providerFetches++; render(); throw Error("SMOKE_PROVIDER_FORBIDDEN"); } }),
    });
  }
  render();
});
load.onclick = () => { if (!state.childReady || state.replayReady) return; load.disabled = true; iframe()?.contentWindow?.postMessage({ channel: "react-host-smoke", type: "load" }, location.origin); };
window.addEventListener("error", () => fail("PARENT_WINDOW_ERROR"));
window.addEventListener("unhandledrejection", () => fail("PARENT_UNHANDLED_REJECTION"));
async function mount() {
  // Stop before BOOT if an origin is not isolated. Never read or erase existing recovery records.
  if (!indexedDB.databases) { fail("ORIGIN_INVENTORY_UNAVAILABLE"); return; }
  const databases = (await indexedDB.databases()).map(item => item.name ?? "");
  let releaseObserver = () => {};
  if (ordinaryRecovery) {
    if (realDemo) { fail("RECOVERY_REQUIRES_SYNTHETIC_MODE"); return; }
    const info = await (await window.fetch("/smoke-run.json")).json();
    if (info.ordinaryRecovery !== true || Boolean(info.ordinaryCued) !== ordinaryCued || (ordinaryCued && emptyRoute)) { fail("RECOVERY_SERVER_MODE_REQUIRED"); return; }
    const stored = sessionStorage.getItem(markerKey);
    marker = stored ? JSON.parse(stored) : undefined;
    const admission = syntheticRecoveryAdmission(info.nonce, marker, databases, Object.keys(localStorage));
    if (admission === "REJECT") { fail("ORIGIN_NOT_OWNED_BY_THIS_RUN"); return; }
    recovery.reload = admission === "RELOAD"; recovery.targetTick = marker?.targetTick ?? null; recovery.firstRun = marker?.firstRun ?? null; recovery.ordinaryCommits = marker?.captured ? 1 : 0;
    if (!marker) marker = { nonce: info.nonce, captured: false, localKeys: [] };
    if (recovery.reload) marker.reloaded = true;
    sessionStorage.setItem(markerKey, JSON.stringify(marker));
    document.querySelector<HTMLElement>("#recovery-note")!.hidden = false;
    if (reloadButton) {
      reloadButton.hidden = recovery.reload;
      reloadButton.disabled = recovery.reload;
      reloadButton.onclick = () => { if (recovery.reload || recovery.armed) return; recovery.armed = true; reloadButton.disabled = true; trace("capture-armed"); render(); };
    }
    if (!recovery.reload) releaseObserver = observeSyntheticRecoveryWrites(value => {
      const parsed = SessionRecoveryRecordSchema.safeParse(value);
      if (!parsed.success || !marker || marker.captured || !recovery.armed) return;
      const record = parsed.data;
      if (record.boundary.kind === "ROUTE_START" && !marker.recoveryId) marker.recoveryId = record.recoveryId;
      if (record.boundary.kind !== "ORDINARY_SEGMENT" || !record.agentCheckpointId || marker.recoveryId !== record.recoveryId) return;
      const segment = record.frozenReviewPlan.segments[record.boundary.segmentIndex] as { start_tick: number; round_number: number };
      // A later round forces a real cold seek, rather than the initial freeze-skip position.
      if (segment.round_number !== 2) return;
      if (ordinaryCued && (record.frozenReviewPlan.cues.length !== 2 || record.cueProgress.consumedCueIds.length !== 1)) {
        fail("CUED_RECOVERY_PROGRESS_NOT_READY"); return;
      }
      marker.captured = true; marker.targetTick = segment.start_tick; marker.localKeys = Object.keys(localStorage);
      marker.firstRun = { analysisReady: state.analysisReady, prepareRoute: state.prepareRoute, prepareNarration: state.prepareNarration, savedNarrationCount: record.narrationArtifacts.length, consumedCueCount: record.cueProgress.consumedCueIds.length };
      sessionStorage.setItem(markerKey, JSON.stringify(marker)); recovery.ordinaryCommits++; recovery.targetTick = segment.start_tick;
      trace("ordinary-transaction-committed", segment.start_tick); render();
      // Explicitly armed test action: reload after the real commit, never fake a pause or ACK.
      setTimeout(() => location.reload(), 0);
    });
  } else if (databases.length || localStorage.length) { fail("ORIGIN_NOT_EMPTY_USE_NEW_PORT"); return; }
  const root = createRoot(document.querySelector("#host")!);
  root.render(<Cs2dPlaybackHost viewerUrl={`${location.origin}/child.html?parentOrigin=${encodeURIComponent(location.origin)}${selfBlind ? "&selfBlind=1" : ""}${ammo ? "&ammo=1" : ""}${emptyRoute ? "&emptyRoute=1" : ""}${ordinaryRecovery ? "&ordinaryRecovery=1" : ""}`} parentOrigin={location.origin} deployTarget="localhost" reviewPreparationDependencies={input} />);
  state.mounted = true; render(); window.addEventListener("pagehide", () => { releaseObserver(); root.unmount(); }, { once: true });
}
void mount().catch(() => fail("MOUNT_PREFLIGHT_FAILED")); render();

import React from "react";
import { createRoot } from "react-dom/client";
import { Cs2dPlaybackHost } from "../../apps/web/components/playback/cs2d-playback-host";
import { deserializeCs2dAnalysisBundle } from "../../libs/cs2d-analysis-adapter/src/index";
import { deterministicDirectorFallback } from "../../libs/review-planner/src/index";
import { isPlaybackEventEnvelope } from "../../libs/contracts/src/playback-bridge";
import { createCs2dReviewPreparationDependencies, type ReviewPreparationDependencies } from "../../apps/web/lib/coaching/cs2d-route-integration";
import { requestNarrationBundle } from "../../apps/web/lib/coaching/narrator-contract";
import "../../apps/web/app/globals.css";

const summary = document.querySelector<HTMLPreElement>("#summary")!, load = document.querySelector<HTMLButtonElement>("#load")!;
const state = { mounted: false, childReady: false, stageReady: 0, replayReady: 0, selected: 0, analysisReady: 0, prepareRoute: 0, prepareNarration: 0,
  agentRequests: 0, forbiddenFetches: 0, providerFetches: 0, playbackReports: 0, playing: false, tick: 0, acks: 0,
  errors: [] as string[], syntheticIdentity: true, parser: false, model: false, diagnostics: false };
const render = () => { summary.textContent = JSON.stringify(state, null, 2); };
const fail = (code: string) => { if (!state.errors.includes(code)) state.errors.push(code); render(); };
const nativeFetch = window.fetch.bind(window);
window.fetch = async (input, init) => {
  const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, location.origin);
  if (url.origin !== location.origin || !["/api/coaching/agent", "/generated-assets/items/catalog.json"].includes(url.pathname)) {
    state.forbiddenFetches++; render(); throw Error("SMOKE_FETCH_FORBIDDEN");
  }
  if (url.pathname === "/api/coaching/agent") state.agentRequests++;
  render(); return nativeFetch(input, init);
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
    if (event.data.type === "shell-ready") { state.childReady = true; load.disabled = false; }
    if (event.data.type === "stage-ready") state.stageReady++;
    if (event.data.type === "error") fail("CHILD_ERROR"); render(); return;
  }
  if (!isPlaybackEventEnvelope(event.data)) return;
  const payload = event.data.payload;
  if (payload.type === "REPLAY_READY") state.replayReady++;
  if (payload.type === "PLAYER_SELECTED") state.selected++;
  if (payload.type === "PLAYBACK_STATE") { state.playbackReports++; state.tick = payload.canonicalTick; state.playing = payload.playing; }
  if (payload.type === "TEACHING_TOOL_ACK") state.acks++;
  if (payload.type === "ANALYSIS_READY") {
    state.analysisReady++;
    const analysis = deserializeCs2dAnalysisBundle(payload.bundleJson);
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
  if (!indexedDB.databases || (await indexedDB.databases()).length || localStorage.length) { fail("ORIGIN_NOT_EMPTY_USE_NEW_PORT"); return; }
  const root = createRoot(document.querySelector("#host")!);
  root.render(<Cs2dPlaybackHost viewerUrl={`${location.origin}/child.html?parentOrigin=${encodeURIComponent(location.origin)}`} parentOrigin={location.origin} deployTarget="localhost" reviewPreparationDependencies={input} />);
  state.mounted = true; render(); window.addEventListener("pagehide", () => root.unmount(), { once: true });
}
void mount().catch(() => fail("MOUNT_PREFLIGHT_FAILED")); render();

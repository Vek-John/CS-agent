import { createApp, h } from "vue";
import { createMemoryHistory, createRouter, RouterView } from "vue-router";
import DemoAnalyzerView from "@/viewer/DemoAnalyzerView.vue";
import { allowedRealDemoFiles, realDemoDeadlines } from "./react-host-smoke-real-lifecycle";
import { i18n } from "@/app/i18n";

const origin = new URL(location.href).searchParams.get("parentOrigin");
if (origin !== location.origin) throw Error("INVALID_PARENT_ORIGIN");
const state = { phase: "IDLE", parserWorkers: 0, modelWorkers: 0, activeWorkers: 0, parsed: false, parseError: false,
  cacheRouteReady: false, analysisDelivered: false, analysisFailed: false, timeout: false, rejectedInput: false,
  inputBytes: 0, parseAndCacheMs: 0, selectedPipelineMs: 0, model: "wasm-int8", threads: 1, errors: [] as string[] };
const report = () => parent.postMessage({ channel: "react-host-smoke", type: "real-lifecycle", summary: { ...state } }, origin);
const NativeWorker = window.Worker, owned = new Set<Worker>();
let app: ReturnType<typeof createApp> | undefined;
const deadlines = realDemoDeadlines(() => stop("PROCESSING_DEADLINE"));
let parseStarted = 0, pipelineStarted = 0, stopped = false;
function finishPhase(phase?: "parse" | "pipeline") {
  deadlines.finish(phase);
}
function stop(code: string) {
  if (stopped) return; stopped = true; finishPhase(); state.timeout = code === "PROCESSING_DEADLINE"; state.errors.push(code); state.phase = "STOPPED";
  app?.unmount(); for (const worker of owned) worker.terminate(); owned.clear(); state.activeWorkers = 0;
  document.querySelector("#app")!.textContent = "本次验收已停止：" + code; report();
}
function deadline(phase: string) { const key = phase === "SELECTED_PIPELINE" ? "pipeline" : "parse"; finishPhase(key); state.phase = phase; deadlines.start(key); report(); }
class OwnedWorker extends NativeWorker {
  constructor(url: string | URL, options?: WorkerOptions) {
    super(url, options); owned.add(this); state.activeWorkers = owned.size;
    const parser = String(url).includes("demoParser.worker"), model = String(url).includes("csNetWinRate.worker");
    if (parser) state.parserWorkers++;
    if (model) { state.modelWorkers++; pipelineStarted = performance.now(); deadline("SELECTED_PIPELINE"); }
    this.addEventListener("message", event => {
      const message = event.data;
      if (parser && message?.type === "result") {
        state.parsed = message.ok === true; state.parseError = message.ok === false;
        if (state.parseError) { finishPhase("parse"); state.phase = "PARSER_ERROR"; state.parseAndCacheMs = Math.round(performance.now() - parseStarted); }
        else state.phase = "SAVING_LOCAL_CACHE";
      }
      report();
    });
    this.addEventListener("error", () => { state.errors.push(parser ? "PARSER_WORKER_ERROR" : model ? "MODEL_WORKER_ERROR" : "WORKER_ERROR"); report(); });
    report();
  }
  terminate() { super.terminate(); owned.delete(this); state.activeWorkers = owned.size; report(); }
}
window.Worker = OwnedWorker;
const guardFile = (event: Event) => {
  const files = event.type === "drop" ? (event as DragEvent).dataTransfer?.files : (event.target as HTMLInputElement)?.files;
  if (!files?.length) return;
  const file = files[0];
  if (stopped || !allowedRealDemoFiles(Array.from(files))) {
    event.preventDefault(); event.stopImmediatePropagation(); state.rejectedInput = true; report(); return;
  }
  parseStarted = performance.now(); state.inputBytes = file.size; deadline("PARSING_AND_CACHE");
};
document.addEventListener("change", guardFile, true); document.addEventListener("drop", guardFile, true);
const router = createRouter({ history: createMemoryHistory(), routes: [{ path: "/:id?/:tab?/:sub?", component: DemoAnalyzerView }] });
router.afterEach(to => {
  if (typeof to.params.id === "string" && to.params.id && state.parsed) {
    state.cacheRouteReady = true; state.parseAndCacheMs = Math.round(performance.now() - parseStarted);
    // The actual recent.save() completed before DemoAnalyzer pushes this route.
    finishPhase("parse"); if (!pipelineStarted) state.phase = "PLAYER_SELECTION"; report();
  }
});
window.addEventListener("message", event => {
  if (event.source !== parent || event.origin !== origin || event.data?.channel !== "real-demo-smoke") return;
  if (event.data.type === "analysis-delivered" || event.data.type === "analysis-failed") {
    state.analysisDelivered = event.data.type === "analysis-delivered"; state.analysisFailed = !state.analysisDelivered;
    state.selectedPipelineMs = Math.round(performance.now() - pipelineStarted); state.phase = state.analysisDelivered ? "HOST_PREPARATION" : "ANALYSIS_FAILED";
    finishPhase("pipeline"); report();
  }
});
const probe = document.createElement("div"); probe.className = "absolute inset-0 h-full w-full"; document.body.append(probe);
const style = getComputedStyle(probe), cssReady = style.position === "absolute" && style.top === "0px" && Math.abs(probe.getBoundingClientRect().height - innerHeight) < 2;
probe.remove(); if (!cssReady) throw Error("VIEWER_CSS_MISSING");
await router.push({ path: "/", query: { host: "1", parentOrigin: origin, csProvider: "wasm-int8", csThreads: "1", csBatch: "16" } });
await router.isReady(); app = createApp({ render: () => h(RouterView) });
app.config.errorHandler = () => stop("VIEWER_COMPONENT_ERROR");
app.use(router).use(i18n).mount("#app"); report();
window.addEventListener("pagehide", () => {
  stopped = true; finishPhase(); app?.unmount(); for (const worker of owned) worker.terminate(); owned.clear();
  window.Worker = NativeWorker; document.removeEventListener("change", guardFile, true); document.removeEventListener("drop", guardFile, true);
}, { once: true });

import { createApp, h, ref } from "vue";
import ViewerStage from "@/viewer/player/ViewerStage.vue";
import { i18n } from "@/app/i18n";
import { replayReadyMessage, emitPlaybackEvent } from "@/viewer/player/hostBridge";
import { createSyntheticHostSelection } from "./react-host-smoke-selection";
import { isPlaybackCommandEnvelope } from "../../libs/contracts/src/playback-bridge";
import { twoCueViewerReplay, emptyCueViewerReplay, twoCueViewerPlayer } from "./viewer-two-cue-fixture";
const recoveryMode = new URLSearchParams(location.search).get("ordinaryRecovery") === "1";
const replay = new URLSearchParams(location.search).get("emptyRoute") === "1" ? emptyCueViewerReplay() : twoCueViewerReplay({ priorSelfBlind: new URLSearchParams(location.search).get("selfBlind") === "1", priorWeaponAmmo: new URLSearchParams(location.search).get("ammo") === "1" });
const origin = new URL(location.href).searchParams.get("parentOrigin");
if (origin !== location.origin) throw Error("INVALID_PARENT_ORIGIN");
const report = (type: string) => parent.postMessage({ channel: "react-host-smoke", type }, origin);
const probe = document.createElement("div"); probe.className = "absolute inset-0 h-full w-full"; document.body.append(probe);
const style = getComputedStyle(probe), ready = style.position === "absolute" && style.top === "0px" && Math.abs(probe.getBoundingClientRect().height - innerHeight) < 2;
probe.remove(); if (!ready) { report("error"); throw Error("VIEWER_CSS_MISSING"); }
let loaded = false;
const stageSelected = ref(false);
const choose = createSyntheticHostSelection(replay, () => loaded, emitPlaybackEvent);
const selectButton = document.createElement("button");
selectButton.textContent = "选择 Synthetic T（合成入口，替代 DemoAnalyzer 选人）";
selectButton.disabled = true;
selectButton.style.cssText = "position:fixed;z-index:100;top:10px;left:50%;transform:translateX(-50%);padding:8px 12px;background:#162338;color:white;border:1px solid #7188a8;border-radius:6px;max-width:90%;font:14px system-ui";
selectButton.onclick = () => { if (choose(twoCueViewerPlayer)) { selectButton.disabled = true; stageSelected.value = true; } };
document.body.append(selectButton);
window.addEventListener("message", event => {
  if (event.source !== parent || event.origin !== origin || event.data?.channel !== "react-host-smoke" || event.data.type !== "load" || loaded) return;
  loaded = true; selectButton.disabled = false;
  // Synthetic identity only: never derived from or represented as a parsed file hash.
  emitPlaybackEvent(replayReadyMessage({ ...replay, demoContentHash: "a".repeat(64), hashLatencyMs: 0 }));
});
if (recoveryMode) window.addEventListener("message", event => {
  if (event.source !== parent || event.origin !== origin || !isPlaybackCommandEnvelope(event.data)) return;
  const command = event.data.payload;
  if (["pause", "play", "seekCanonicalTick"].includes(command.type)) parent.postMessage({ channel: "react-host-smoke", type: "recovery-command",
    command: command.type, ...(command.type === "seekCanonicalTick" ? { tick: command.canonicalTick } : {}) }, origin);
});
const select = (event: MessageEvent<unknown>) => {
  if (event.source !== parent || event.origin !== origin || !isPlaybackCommandEnvelope(event.data) || event.data.payload.type !== "selectPlayer") return;
  if (choose(event.data.payload.playerId)) { selectButton.disabled = true; stageSelected.value = true; }
};
window.addEventListener("message", select);
const app = createApp({ render: () => stageSelected.value ? h(ViewerStage, { replay, sourceLabel: "Synthetic · not measured Demo ticks", hostMode: true,
  hostTargetPlayerId: twoCueViewerPlayer, autoplay: false, active: false, skipFreeze: true, onHostReady: () => report("stage-ready") }) : h("p", { style: "padding:64px 16px;color:white" }, "合成选人入口：载入后选择玩家，再挂载真实回放舞台。") });
app.config.errorHandler = () => report("error"); app.use(i18n).mount("#app");
report("shell-ready");
window.addEventListener("pagehide", () => { window.removeEventListener("message", select); app.unmount(); selectButton.remove(); }, { once: true });

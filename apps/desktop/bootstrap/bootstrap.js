import { createInvoke } from "./bootstrap-ipc.js";

const title = document.querySelector("#status-title");
const detail = document.querySelector("#status-detail");
const card = document.querySelector(".status-card");
const retryButton = document.querySelector("#retry-button");
const settingsButton = document.querySelector("#settings-button");

const invoke = createInvoke();

function render(status) {
  card.dataset.state = status.state;
  retryButton.hidden = status.state !== "error";

  if (status.state === "ready") {
    title.textContent = "教练已就绪";
    detail.textContent = "正在打开本地复盘会话。";
    return;
  }

  if (status.state === "error") {
    title.textContent = "本地教练暂时无法启动";
    detail.textContent = status.message ?? "可以重新启动应用；你的 Demo 与教练记录没有被更改。";
    return;
  }

  title.textContent = "正在准备本地教练";
  detail.textContent = "正在启动安全的本地运行环境。你的 Demo 不会经过桌面宿主。";
}

async function refresh() {
  try {
    render(await invoke("runtime_status"));
  } catch {
    render({ state: "error", message: "桌面宿主没有响应，请重新启动应用。" });
  }
}

settingsButton.addEventListener("click", async () => {
  settingsButton.disabled = true;
  try {
    await invoke("open_settings");
  } finally {
    settingsButton.disabled = false;
  }
});

retryButton.addEventListener("click", async () => {
  retryButton.disabled = true;
  retryButton.setAttribute("aria-busy", "true");
  detail.textContent = "正在安全停止本地运行时并重新启动应用…";
  try {
    await invoke("runtime_restart");
  } catch {
    retryButton.disabled = false;
    retryButton.setAttribute("aria-busy", "false");
    detail.textContent = "重新启动未完成；你的 Demo 与教练记录没有被更改。";
  }
});
window.addEventListener("cs-agent-runtime-status", refresh);

refresh();
const poll = window.setInterval(refresh, 500);
window.addEventListener("pagehide", () => window.clearInterval(poll), { once: true });

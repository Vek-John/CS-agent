import { createInvoke } from "./bootstrap-ipc.js";

const invoke = createInvoke();
const form = document.querySelector("#provider-form");
const kind = document.querySelector("#provider-kind");
const apiKey = document.querySelector("#api-key");
const deleteKey = document.querySelector("#delete-key");
const baseUrl = document.querySelector("#base-url");
const model = document.querySelector("#model");
const message = document.querySelector("#provider-message");
const keyState = document.querySelector("#key-state");
const restart = document.querySelector("#restart-runtime");
const updateSummary = document.querySelector("#update-summary");
const updateVersion = document.querySelector("#update-version");
const updateDetail = document.querySelector("#update-detail");
const updateNotes = document.querySelector("#update-notes");
const updateProgress = document.querySelector("#update-progress");
const updateCheck = document.querySelector("#update-check");
const updateDownload = document.querySelector("#update-download");
const updateEndReview = document.querySelector("#update-end-review");
const updateInstall = document.querySelector("#update-install");
const updateRelaunch = document.querySelector("#update-relaunch");
const updateLater = document.querySelector("#update-later");
const updateFallback = document.querySelector("#update-fallback");
const updateFallbackUrl = document.querySelector("#update-fallback-url");
const updateOpenFallback = document.querySelector("#update-open-fallback");
const archiveStatus = document.querySelector("#archive-status");
const libraryStatus = document.querySelector("#library-status");
const verifyLibrary = document.querySelector("#verify-library");
const clearLibraryCache = document.querySelector("#clear-library-cache");
const libraryReviewSelect = document.querySelector("#library-review-select");
const libraryDemoSelect = document.querySelector("#library-demo-select");
const deleteLibraryReview = document.querySelector("#delete-library-review");
const deleteLibraryDemo = document.querySelector("#delete-library-demo");
let libraryEntries = { reviews: [], demos: [] };

function formatBytes(value) {
  if (!Number.isFinite(value) || value < 0) return "—";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let amount = value;
  let unit = 0;
  while (amount >= 1024 && unit < units.length - 1) {
    amount /= 1024;
    unit += 1;
  }
  return `${amount >= 10 || unit === 0 ? amount.toFixed(0) : amount.toFixed(1)} ${units[unit]}`;
}

async function refreshLibraryStats() {
  libraryStatus.textContent = "正在读取资料库统计…";
  try {
    const stats = await invoke("review_library_stats");
    document.querySelector("#library-demo-count").textContent = String(stats.demoCount);
    document.querySelector("#library-review-count").textContent = String(stats.reviewCount);
    document.querySelector("#library-demo-size").textContent = formatBytes(stats.rawDemoBytes);
    document.querySelector("#library-artifact-size").textContent = formatBytes(stats.artifactBytes);
    document.querySelector("#library-cache-size").textContent = formatBytes(stats.cacheBytes);
    document.querySelector("#library-total-size").textContent = formatBytes(stats.totalBytes);
    libraryStatus.textContent = "只统计应用管理目录；SQLite 小型备份不复制原始 Demo。";
  } catch {
    libraryStatus.textContent = "资料库尚未就绪；本地教练与既有数据没有被修改。";
  }
}

function optionLabel(parts) {
  return parts.filter((part) => typeof part === "string" && part.trim()).join(" · ");
}

function replaceOptions(select, items, placeholder, label) {
  const selected = select.value;
  select.replaceChildren(new Option(placeholder, ""));
  for (const item of items) select.add(new Option(label(item), item.id));
  select.value = items.some((item) => item.id === selected) ? selected : "";
}

function syncLibraryDeleteButtons() {
  deleteLibraryReview.disabled = !libraryReviewSelect.value;
  deleteLibraryDemo.disabled = !libraryDemoSelect.value;
}

async function refreshLibraryEntries() {
  try {
    const entries = await invoke("review_library_entries");
    libraryEntries = {
      reviews: entries.reviews.map((review) => ({ ...review, id: review.reviewId })),
      demos: entries.demos.map((demo) => ({ ...demo, id: demo.demoId })),
    };
    replaceOptions(
      libraryReviewSelect,
      libraryEntries.reviews,
      libraryEntries.reviews.length ? "选择一个复盘" : "尚无可删除复盘",
      (review) => optionLabel([
        review.title,
        review.selectedPlayerName,
        review.mapName,
        review.scoreText,
        review.status,
      ]),
    );
    replaceOptions(
      libraryDemoSelect,
      libraryEntries.demos,
      libraryEntries.demos.length ? "选择一个 Demo" : "尚无可删除 Demo",
      (demo) => optionLabel([
        demo.originalFilename,
        demo.mapName,
        `${demo.reviewCount} 个复盘`,
        formatBytes(demo.byteSize),
      ]),
    );
    syncLibraryDeleteButtons();
  } catch {
    libraryEntries = { reviews: [], demos: [] };
    replaceOptions(libraryReviewSelect, [], "无法读取复盘列表", () => "");
    replaceOptions(libraryDemoSelect, [], "无法读取 Demo 列表", () => "");
    syncLibraryDeleteButtons();
    libraryStatus.textContent = "无法读取资料库条目；本地数据没有被修改。";
  }
}

async function refreshLibrary() {
  await refreshLibraryStats();
  await refreshLibraryEntries();
}

const updatePhaseText = {
  UNAVAILABLE: "公开更新尚未配置", IDLE: "可以检查更新", CHECKING: "正在检查签名发布",
  CURRENT: "当前已是最新版本", AVAILABLE: "发现可用更新", DOWNLOADING: "正在下载并验证签名",
  STAGED: "更新已安全暂存", INSTALLING: "正在备份并原子安装",
  RELAUNCH_REQUIRED: "新版本已安装，等待重新打开", DMG_FALLBACK: "需要手动使用 DMG 更新",
  ERROR: "更新未完成",
};

const updateErrorText = {
  UPDATE_PUBLIC_KEY_NOT_CONFIGURED: "公开发行权利或更新公钥尚未就绪，本机不会假装可以公开更新。",
  UPDATE_CHECK_FAILED: "无法安全读取更新信息，请稍后再试。",
  UPDATE_MANIFEST_INVALID: "更新清单不符合固定版本、平台或下载地址要求。",
  UPDATE_NOT_AVAILABLE: "当前没有可下载的更新。",
  UPDATE_DOWNLOAD_FAILED: "下载没有完整结束，临时文件已清理。",
  UPDATE_DOWNLOAD_TOO_LARGE: "更新包超过安全大小限制，已停止下载。",
  UPDATE_SIGNATURE_INVALID: "更新签名无法验证，已拒绝该文件。",
  UPDATE_STAGE_FAILED: "无法在当前应用所在磁盘创建安全暂存区。",
  UPDATE_ARCHIVE_INVALID: "更新压缩包包含不安全或意外的文件。",
  UPDATE_APP_INVALID: "新应用的版本、架构、标识或 Apple 签名验证失败。",
  UPDATE_COACHING_BUSY: "当前复盘尚未明确结束。请先点击“结束当前复盘”。",
  UPDATE_REVIEW_UNAVAILABLE: "无法安全结束当前复盘；应用没有进入安装状态。",
  UPDATE_BACKUP_REQUIRED: "SQLite 一致性备份未成功，当前应用未被更改。",
  UPDATE_ATOMIC_SWAP_UNAVAILABLE: "系统无法完成同磁盘原子交换，当前应用未被更改。",
  UPDATE_DMG_FALLBACK_REQUIRED: "自动安装条件不满足，当前应用未被更改。",
  UPDATE_DMG_OPEN_FAILED: "无法打开系统浏览器；请复制下方固定发布地址。",
  UPDATE_RELAUNCH_UNAVAILABLE: "还没有已安装并可重新打开的新版本。",
  UPDATE_STATE_INVALID: "当前更新已暂存或已安装，不能用新检查覆盖该状态。",
};

function input() {
  return {
    kind: kind.value,
    apiKey: apiKey.value || null,
    deleteApiKey: deleteKey.checked,
    baseUrl: kind.value === "NONE" ? null : baseUrl.value,
    model: kind.value === "NONE" ? null : model.value,
  };
}

function applyStatus(status) {
  kind.value = status.kind;
  baseUrl.value = status.baseUrl ?? (status.kind === "DEEPSEEK" ? "https://api.deepseek.com" : "");
  model.value = status.model ?? (status.kind === "DEEPSEEK" ? "deepseek-chat" : "");
  keyState.textContent = status.hasApiKey ? "已安全保存" : "未保存";
  restart.disabled = !status.restartRequired;
  apiKey.value = "";
  deleteKey.checked = false;
  syncFields();
}

function syncFields() {
  const disabled = kind.value === "NONE";
  for (const field of [apiKey, deleteKey, baseUrl, model]) field.disabled = disabled;
  if (kind.value === "DEEPSEEK") {
    baseUrl.value = "https://api.deepseek.com";
    baseUrl.readOnly = true;
    if (!model.value) model.value = "deepseek-chat";
  } else {
    baseUrl.readOnly = false;
  }
}

async function run(command, args, success) {
  message.textContent = "处理中…";
  try {
    const result = await invoke(command, args);
    if (result?.kind) applyStatus(result);
    message.textContent = success;
  } catch (error) {
    message.textContent = `操作未完成：${String(error)}`;
  }
}

function setUpdateButtonsBusy(busy) {
  for (const button of [updateCheck, updateDownload, updateEndReview, updateInstall, updateRelaunch, updateOpenFallback]) {
    button.setAttribute("aria-busy", String(busy));
    if (busy) button.disabled = true;
  }
}

function applyUpdateStatus(status) {
  updateSummary.textContent = updatePhaseText[status.phase] ?? "更新状态未知";
  updateVersion.textContent = status.availableVersion ? `${status.currentVersion} → ${status.availableVersion}` : status.currentVersion;
  updateDetail.textContent = status.errorCode ? (updateErrorText[status.errorCode] ?? "更新未完成，当前应用没有被更改。") : "";
  updateNotes.textContent = status.releaseNotes ?? "";
  updateNotes.hidden = !status.releaseNotes;
  const hasProgress = status.phase === "DOWNLOADING" && status.progressPercent !== null;
  updateProgress.hidden = !hasProgress;
  if (hasProgress) updateProgress.value = status.progressPercent;
  updateCheck.disabled = !status.canCheck;
  updateDownload.disabled = !status.canDownload;
  updateEndReview.disabled = !status.canEndReview;
  updateInstall.disabled = !status.canInstall;
  updateRelaunch.disabled = !status.canRelaunch;
  updateEndReview.hidden = status.phase !== "STAGED" || status.reviewEndedForUpdate;
  updateInstall.title = status.coachingBusy ? "请先明确结束当前复盘" : "";
  updateLater.textContent = status.canResumeReview ? "稍后，返回复盘" : "稍后";
  updateFallback.hidden = !status.fallbackDmgUrl || status.phase !== "DMG_FALLBACK";
  updateFallbackUrl.textContent = status.fallbackDmgUrl ?? "";
}

async function refreshUpdateStatus() {
  try {
    applyUpdateStatus(await invoke("update_status"));
  } catch {
    updateSummary.textContent = "无法读取更新状态";
    updateDetail.textContent = "更新功能没有启动，当前应用没有被更改。";
    setUpdateButtonsBusy(true);
  }
}

async function runUpdate(command) {
  setUpdateButtonsBusy(true);
  updateDetail.textContent = "处理中…";
  let failureMessage = null;
  try {
    await invoke(command);
  } catch (error) {
    const code = String(error);
    failureMessage = updateErrorText[code] ?? "更新未完成，当前应用没有被更改。";
  } finally {
    await refreshUpdateStatus();
    if (failureMessage) updateDetail.textContent = failureMessage;
  }
}

updateCheck.addEventListener("click", () => runUpdate("update_check"));
updateDownload.addEventListener("click", () => runUpdate("update_download_stage"));
updateEndReview.addEventListener("click", () => runUpdate("update_end_review"));
updateInstall.addEventListener("click", () => runUpdate("update_install"));
updateRelaunch.addEventListener("click", () => runUpdate("update_relaunch"));
updateOpenFallback.addEventListener("click", () => runUpdate("update_open_fallback"));
updateLater.addEventListener("click", async () => {
  try {
    await invoke("hide_settings");
  } catch {
    updateDetail.textContent = "暂时无法隐藏设置窗口，更新状态没有改变。";
  }
});

kind.addEventListener("change", syncFields);
document.querySelector("#validate-provider").addEventListener("click", () =>
  run("provider_validate", { input: input() }, "配置格式与钥匙串状态正常；尚未发送网络请求。"));
form.addEventListener("submit", (event) => {
  event.preventDefault();
  run("provider_save", { input: input() }, "已保存。新配置会在安全重启后生效。");
});
document.querySelector("#delete-provider").addEventListener("click", () =>
  run("provider_delete", {}, "配置与钥匙串密钥已删除；安全重启后生效。"));
restart.addEventListener("click", () => run("runtime_restart", {}, "正在安全重启…"));
document.querySelector("#manage-memory").addEventListener("click", async () => {
  archiveStatus.textContent = "正在打开记忆管理…";
  try {
    await invoke("open_memory");
  } catch (error) {
    archiveStatus.textContent = `无法打开记忆管理：${String(error)}`;
  }
});
document.querySelector("#open-logs").addEventListener("click", async () => {
  archiveStatus.textContent = "正在打开日志文件夹…";
  try {
    await invoke("open_log_directory");
    archiveStatus.textContent = "已在 Finder 中打开日志文件夹。日志只记录有界生命周期事件码。";
  } catch (error) {
    archiveStatus.textContent = `无法打开日志文件夹：${String(error)}`;
  }
});
document.querySelector("#open-library").addEventListener("click", async () => {
  libraryStatus.textContent = "正在打开资料库目录…";
  try {
    await invoke("open_library_directory");
    libraryStatus.textContent = "已在 Finder 中打开应用管理的资料库目录。";
  } catch {
    libraryStatus.textContent = "无法打开资料库目录。";
  }
});
document.querySelector("#refresh-library").addEventListener("click", refreshLibrary);
libraryReviewSelect.addEventListener("change", syncLibraryDeleteButtons);
libraryDemoSelect.addEventListener("change", syncLibraryDeleteButtons);
deleteLibraryReview.addEventListener("click", async () => {
  const review = libraryEntries.reviews.find((item) => item.id === libraryReviewSelect.value);
  if (!review) return;
  const confirmed = window.confirm(
    `确定永久删除复盘“${review.title}”？\n\n将删除该复盘的产物、恢复点和证据引用。原始 Demo“${review.originalFilename}”会保留。`,
  );
  if (!confirmed) return;
  deleteLibraryReview.disabled = true;
  deleteLibraryReview.setAttribute("aria-busy", "true");
  libraryStatus.textContent = "正在删除所选复盘…";
  try {
    await invoke("review_library_delete_review", { input: { objectId: review.id } });
    await refreshLibrary();
    libraryStatus.textContent = `已删除复盘“${review.title}”；原始 Demo 已保留。`;
  } catch {
    libraryStatus.textContent = "复盘删除未完成；请刷新后再试。";
  } finally {
    deleteLibraryReview.removeAttribute("aria-busy");
    syncLibraryDeleteButtons();
  }
});
deleteLibraryDemo.addEventListener("click", async () => {
  const demo = libraryEntries.demos.find((item) => item.id === libraryDemoSelect.value);
  if (!demo) return;
  deleteLibraryDemo.disabled = true;
  deleteLibraryDemo.setAttribute("aria-busy", "true");
  libraryStatus.textContent = "正在读取 Demo 删除影响…";
  try {
    const impact = await invoke("review_library_demo_impact", {
      input: { objectId: demo.id },
    });
    const visibleReviews = impact.affectedReviews
      .slice(0, 8)
      .map((review) => `• ${review.title} · ${review.selectedPlayerName} · ${review.status}`)
      .join("\n");
    const hiddenCount = Math.max(0, impact.affectedReviewCount - Math.min(8, impact.affectedReviews.length));
    const affectedText = impact.affectedReviewCount === 0
      ? "没有关联复盘。"
      : `${visibleReviews}${hiddenCount ? `\n• 另有 ${hiddenCount} 个复盘` : ""}`;
    const confirmed = window.confirm(
      `确定永久删除 Demo“${impact.originalFilename}”？\n\n将同时删除 ${impact.affectedReviewCount} 个复盘、原始文件、所有复盘产物、恢复点和证据引用：\n${affectedText}\n\n此操作无法撤销。`,
    );
    if (!confirmed) {
      libraryStatus.textContent = "已取消 Demo 删除。";
      return;
    }
    await invoke("review_library_delete_demo", {
      input: { demoId: impact.demoId, impactToken: impact.impactToken },
    });
    await refreshLibrary();
    libraryStatus.textContent = `已删除 Demo“${impact.originalFilename}”及 ${impact.affectedReviewCount} 个受影响复盘。`;
  } catch (error) {
    libraryStatus.textContent = String(error).includes("REVIEW_LIBRARY_IMPACT_CHANGED")
      ? "Demo 的关联复盘已发生变化；已拒绝删除，请刷新影响范围后再确认。"
      : "Demo 删除未完成；原始 Demo 和复盘未被完整移除。";
  } finally {
    deleteLibraryDemo.removeAttribute("aria-busy");
    syncLibraryDeleteButtons();
  }
});
verifyLibrary.addEventListener("click", async () => {
  verifyLibrary.disabled = true;
  verifyLibrary.setAttribute("aria-busy", "true");
  libraryStatus.textContent = "正在逐个校验托管 Demo 与大型复盘产物…";
  try {
    const result = await invoke("review_library_verify");
    const outcome = result.issueCount === 0
      ? `资料库完整：已校验 ${result.checkedDemos} 个 Demo 和 ${result.checkedArtifacts} 个大型产物。`
      : `发现 ${result.issueCount} 个问题；有问题的记录将不会被当作可用 Demo。`;
    await refreshLibraryStats();
    libraryStatus.textContent = outcome;
  } catch {
    libraryStatus.textContent = "资料库验证未完成；原始 Demo 和复盘没有被删除。";
  } finally {
    verifyLibrary.disabled = false;
    verifyLibrary.setAttribute("aria-busy", "false");
  }
});
clearLibraryCache.addEventListener("click", async () => {
  clearLibraryCache.disabled = true;
  clearLibraryCache.setAttribute("aria-busy", "true");
  libraryStatus.textContent = "正在清理可重建缓存…";
  try {
    const result = await invoke("review_library_clear_cache");
    await refreshLibraryStats();
    libraryStatus.textContent = `已清理 ${formatBytes(result.removedBytes)} 可重建缓存；原始 Demo、用户回答和 LLM 产物已保留。`;
  } catch {
    libraryStatus.textContent = "缓存清理未完成；不可重建的资料没有被修改。";
  } finally {
    clearLibraryCache.disabled = false;
    clearLibraryCache.setAttribute("aria-busy", "false");
  }
});

try {
  applyStatus(await invoke("provider_status"));
  const paths = await invoke("desktop_paths");
  document.querySelector("#data-path").textContent = paths.dataDir;
  document.querySelector("#database-path").textContent = paths.databasePath;
  document.querySelector("#cache-path").textContent = paths.cacheDir;
  document.querySelector("#log-path").textContent = paths.logDir;
  archiveStatus.textContent = paths.backupAvailable && paths.exportAvailable
    ? "每次更新安装前都会创建一致性备份；记忆可在管理页导出 JSON 或永久清除。"
    : "本地数据管理能力暂不可用。";
} catch {
  message.textContent = "无法读取本地设置状态。";
}

await refreshUpdateStatus();
await refreshLibrary();
const updatePoll = window.setInterval(refreshUpdateStatus, 1000);
window.addEventListener("pagehide", () => window.clearInterval(updatePoll), { once: true });

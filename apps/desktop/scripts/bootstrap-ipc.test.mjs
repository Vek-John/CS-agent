import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createInvoke } from "../bootstrap/bootstrap-ipc.js";

test("bundled bootstrap invokes only its three narrow commands through Tauri internals", async () => {
  const calls = [];
  const invoke = createInvoke({
    __TAURI_INTERNALS__: {
      invoke: async (command, args) => {
        calls.push({ command, args });
        return command === "runtime_status" ? { state: "starting" } : undefined;
      },
    },
  });
  assert.deepEqual(await invoke("runtime_status"), { state: "starting" });
  await invoke("open_settings");
  await invoke("runtime_restart");
  assert.deepEqual(calls, [
    { command: "runtime_status", args: {} },
    { command: "open_settings", args: {} },
    { command: "runtime_restart", args: {} },
  ]);
});

test("bootstrap error recovery restarts the host instead of reloading the page", async () => {
  const source = await readFile(new URL("../bootstrap/bootstrap.js", import.meta.url), "utf8");
  const markup = await readFile(new URL("../bootstrap/index.html", import.meta.url), "utf8");
  assert.match(source, /invoke\("runtime_restart"\)/u);
  assert.doesNotMatch(source, /location\.reload/u);
  assert.match(markup, />重新启动应用</u);
});

test("bootstrap fails closed outside a Tauri-injected local WebView", () => {
  assert.throws(() => createInvoke({}), /HOST_UNAVAILABLE/);
});

test("settings uses only the narrow provider and restart commands", async () => {
  const source = await readFile(new URL("../bootstrap/settings.js", import.meta.url), "utf8");
  for (const command of [
    "provider_status", "provider_validate", "provider_save", "provider_delete",
    "desktop_paths", "open_memory", "open_log_directory", "runtime_restart",
    "update_status", "update_check", "update_download_stage", "update_end_review",
    "update_install", "update_relaunch", "update_open_fallback",
    "review_library_stats", "review_library_entries", "review_library_demo_impact",
    "review_library_delete_review", "review_library_delete_demo",
    "review_library_verify", "review_library_clear_cache", "open_library_directory",
    "hide_settings",
  ]) assert.match(source, new RegExp(`["]${command}["]`, "u"));
  assert.doesNotMatch(source, /provider_get|apiKey.*textContent/u);
  assert.doesNotMatch(source, /shell|filesystem|opener|update_private_key/u);
});

test("updater commands stay settings-only while main can only open Settings", async () => {
  const settings = JSON.parse(await readFile(new URL("../src-tauri/capabilities/settings-local.json", import.meta.url), "utf8"));
  const bootstrap = JSON.parse(await readFile(new URL("../src-tauri/capabilities/bootstrap-local.json", import.meta.url), "utf8"));
  const main = JSON.parse(await readFile(new URL("../src-tauri/capabilities/main-open-settings.json", import.meta.url), "utf8"));
  const config = JSON.parse(await readFile(new URL("../src-tauri/tauri.conf.json", import.meta.url), "utf8"));
  const updaterPermissions = [
    "allow-update-status", "allow-update-check", "allow-update-download-stage",
    "allow-update-end-review", "allow-update-install", "allow-update-relaunch",
    "allow-update-open-fallback",
  ];
  const libraryPermissions = [
    "allow-review-library-stats", "allow-review-library-entries",
    "allow-review-library-demo-impact", "allow-review-library-delete-review",
    "allow-review-library-delete-demo", "allow-review-library-verify",
    "allow-review-library-clear-cache",
  ];
  assert.deepEqual(settings.windows, ["settings"]);
  assert.deepEqual(bootstrap.windows, ["bootstrap"]);
  assert.deepEqual(main.windows, ["main"]);
  assert.equal(main.local, false);
  assert.deepEqual(main.permissions, ["allow-open-settings"]);
  assert.deepEqual(main.remote.urls, ["http://127.0.0.1:*/*"]);
  for (const permission of updaterPermissions) {
    assert.ok(settings.permissions.includes(permission));
    assert.ok(!bootstrap.permissions.includes(permission));
  }
  for (const permission of libraryPermissions) {
    assert.ok(settings.permissions.includes(permission));
    assert.ok(!bootstrap.permissions.includes(permission));
  }
  assert.ok(bootstrap.permissions.includes("allow-runtime-restart"));
  assert.ok(settings.permissions.includes("allow-hide-settings"));
  assert.ok(settings.permissions.includes("allow-open-memory"));
  assert.ok(settings.permissions.includes("allow-open-log-directory"));
  assert.ok(!bootstrap.permissions.includes("allow-hide-settings"));
  assert.deepEqual(config.app.security.capabilities, ["bootstrap-local", "settings-local", "main-open-settings"]);
  assert.ok(!settings.permissions.some((permission) => permission.startsWith("updater:")));
});

test("settings exposes separate Review and Demo deletion with explicit impact confirmation", async () => {
  const markup = await readFile(new URL("../bootstrap/settings.html", import.meta.url), "utf8");
  const source = await readFile(new URL("../bootstrap/settings.js", import.meta.url), "utf8");
  assert.match(markup, /id="library-review-select"/u);
  assert.match(markup, /id="delete-library-review"[^>]+disabled/u);
  assert.match(markup, /id="library-demo-select"/u);
  assert.match(markup, /id="delete-library-demo"[^>]+disabled/u);
  assert.match(source, /invoke\("review_library_demo_impact"/u);
  assert.match(source, /impact\.affectedReviews/u);
  assert.match(source, /impactToken: impact\.impactToken/u);
  assert.match(source, /\u539f\u59cb Demo.*\u4f1a\u4fdd\u7559/u);
  assert.match(source, /\u6b64\u64cd\u4f5c\u65e0\u6cd5\u64a4\u9500/u);
  assert.doesNotMatch(source, /innerHTML/u);
});

test("settings update states remain explicit and respect accessibility preferences", async () => {
  const markup = await readFile(new URL("../bootstrap/settings.html", import.meta.url), "utf8");
  const styles = await readFile(new URL("../bootstrap/styles.css", import.meta.url), "utf8");
  assert.match(markup, /<progress[^>]+aria-label="更新下载进度"/u);
  assert.match(markup, /id="update-fallback"/u);
  assert.match(markup, /id="update-end-review"/u);
  assert.match(markup, /id="update-open-fallback"/u);
  assert.match(markup, /id="update-later"[^>]*>稍后</u);
  const source = await readFile(new URL("../bootstrap/settings.js", import.meta.url), "utf8");
  assert.match(source, /updateNotes\.textContent = status\.releaseNotes/u);
  assert.doesNotMatch(source, /innerHTML/u);
  assert.match(source, /updateCheck\.disabled = !status\.canCheck/u);
  assert.match(source, /updateEndReview\.disabled = !status\.canEndReview/u);
  assert.match(source, /updateInstall\.disabled = !status\.canInstall/u);
  assert.match(styles, /prefers-reduced-motion:\s*reduce/u);
  assert.match(styles, /prefers-reduced-transparency:\s*reduce/u);
  assert.match(styles, /\[hidden\]\s*\{\s*display:\s*none\s*!important;/u);
});

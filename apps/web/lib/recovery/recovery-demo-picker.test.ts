import { isRecoveryDemoImportActive } from "./recovery-demo-picker";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { PLAYBACK_BRIDGE_CHANNEL, type PlaybackBridgeEvent } from "@cs-coach/contracts";
import { acceptedPlaybackEvent, managedRequestMatchesExpected } from "../playback/cs2d-playback-host";
import { SessionRecoveryStatus } from "../../components/playback/session-recovery-status";

// Uses the production bridge validator; progress values are the existing Host prop,
// not a claim that a browser picker or parser ran in this test.
function accepted(payload: PlaybackBridgeEvent) {
  return acceptedPlaybackEvent({ data: { channel: PLAYBACK_BRIDGE_CHANNEL, direction: "event", payload },
    eventOrigin: "http://localhost:5174", expectedOrigin: "http://localhost:5174", sourceMatches: true })?.payload;
}
function panel(importing: boolean) {
  return renderToStaticMarkup(createElement(SessionRecoveryStatus, { status: "REJECTED", importing,
    detail: "旧恢复未完成", onChooseDemo: () => {}, onDiscard: () => {} }));
}

it("shows actual managed import work and returns to actionable recovery after import failure", () => {
  const request = accepted({ type: "DEMO_IMPORT_REQUESTED", schemaVersion: "cs2d-demo-import-requested.v1", requestId: "selected-file", originalFilename: "match.dem", byteSize: 4096 });
  expect(request?.type).toBe("DEMO_IMPORT_REQUESTED");
  const expected = { requestId: "selected-file" };
  expect(panel(false)).toContain("选择文件后才会开始导入");
  expect(panel(true)).toContain("正在导入 Demo"); expect(panel(true)).toContain('aria-busy="true"');
  expect(panel(true)).not.toContain("到回放区选择 Demo"); expect(panel(true)).not.toContain("旧恢复未完成");
  for (const completedBytes of [1024, 4096]) {
    const event = accepted({ type: "DEMO_IMPORT_PROGRESS", schemaVersion: "cs2d-demo-import-progress.v1", requestId: "selected-file", completedBytes, totalBytes: 4096 });
    expect(event?.type).toBe("DEMO_IMPORT_PROGRESS");
    expect(managedRequestMatchesExpected(expected, "selected-file")).toBe(true);
    // Byte transfer completion does not mean parsing/validation has finished.
    expect(panel(true)).toContain("正在导入 Demo"); expect(panel(true)).not.toContain("复盘已恢复");
  }
  expect(managedRequestMatchesExpected(expected, "stale-file")).toBe(false);
  const failed = accepted({ type: "DEMO_IMPORT_FAILED", schemaVersion: "cs2d-demo-import-failed.v1", requestId: "selected-file", code: "MANAGED_DEMO_PARSE_FAILED", message: "parse failed" });
  expect(failed?.type).toBe("DEMO_IMPORT_FAILED");
  const html = panel(false);
  expect(html).toContain("旧恢复未完成"); expect(html).toContain("到回放区选择 Demo"); expect(html).toContain('aria-busy="false"');
});

it("ends the import display only when a validated success event is received, then uses normal recovery state", () => {
  expect(accepted({ type: "DEMO_IMPORT_SUCCEEDED", schemaVersion: "cs2d-demo-import-succeeded.v1", requestId: "selected-file", demoId: "managed-demo", contentHash: "a".repeat(64), originalFilename: "match.dem", byteSize: 4096, deduplicated: false })?.type).toBe("DEMO_IMPORT_SUCCEEDED");
  const verifying = renderToStaticMarkup(createElement(SessionRecoveryStatus, { status: "REBUILDING", importing: false, onChooseDemo: () => {} }));
  expect(verifying).toContain("正在验证并重新解析");
  const recovered = renderToStaticMarkup(createElement(SessionRecoveryStatus, { status: "RECOVERED", importing: false, onChooseDemo: () => {} }));
  expect(recovered).toContain("复盘已恢复"); expect(recovered).toContain('aria-busy="false"');
});


it("does not carry A's import indicator into B when the old request is detached or replaced", () => {
  const progress = { requestId: "import-a" };
  expect(isRecoveryDemoImportActive(progress, { requestId: "import-a" })).toBe(true);
  for (const expected of [undefined, { requestId: "import-b" }]) {
    const importing = isRecoveryDemoImportActive(progress, expected);
    expect(importing).toBe(false);
    expect(managedRequestMatchesExpected(expected, "import-a")).toBe(false);
    expect(panel(importing)).toContain("到回放区选择 Demo");
    expect(panel(importing)).not.toContain("正在导入 Demo");
  }
  expect(isRecoveryDemoImportActive(undefined, { requestId: "import-a" })).toBe(false);
});

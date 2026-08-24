"use client";

import { useEffect, useRef, useState } from "react";
import styles from "./agent-poc.module.css";
import {
  STAGE0_TOOL_REQUEST_STORAGE_KEY,
  createStage0FailureResult,
  createStage0ResetEvent,
  createStage0ResumeEvent,
  createStage0StartEvent,
  createWaitingBrowserSmokeResult,
  dispatchStage0Event,
  errorText,
  evaluateRemoteResetResult,
  evaluateRemoteResumeResult,
  evaluateRemoteStartResult,
  parseStage0ToolRequest,
  serializeStage0ToolRequest,
  stage0PhaseFromSearch,
  stage0BackendDescription,
  toolRequestFromResult,
  type BrowserSmokeResult,
  type Stage0Phase,
} from "../../lib/coaching/coach-agent-browser-smoke";

function navigateToPhase(phase: Stage0Phase): void {
  const url = new URL(window.location.href);
  url.searchParams.set("phase", phase);
  window.location.assign(url.toString());
}

export default function AgentPocPage() {
  // Keep the server render and the first client render identical. The URL is
  // intentionally read only after mount so a direct reset/resume load cannot
  // change the hydration tree.
  const [phase, setPhase] = useState<Stage0Phase>("start");
  const [report, setReport] = useState<BrowserSmokeResult>(() =>
    createWaitingBrowserSmokeResult("start"),
  );
  const [hydrated, setHydrated] = useState(false);
  const [running, setRunning] = useState(true);
  const hasRunRef = useRef(false);

  useEffect(() => {
    const nextPhase = stage0PhaseFromSearch(window.location.search);
    setPhase(nextPhase);
    setReport(createWaitingBrowserSmokeResult(nextPhase));
    setHydrated(true);
  }, []);

  useEffect(() => {
    if (!hydrated) return;
    if (hasRunRef.current) return;
    hasRunRef.current = true;
    let disposed = false;

    const run = async () => {
      try {
        if (phase === "start") {
          const started = await dispatchStage0Event(
            createStage0StartEvent("stage0-remote-start"),
          );
          const nextReport = evaluateRemoteStartResult(started);
          if (nextReport.status === "PASS") {
            localStorage.setItem(
              STAGE0_TOOL_REQUEST_STORAGE_KEY,
              serializeStage0ToolRequest(toolRequestFromResult(started)),
            );
          }
          if (!disposed) setReport(nextReport);
        } else if (phase === "resume") {
          const serializedRequest = localStorage.getItem(
            STAGE0_TOOL_REQUEST_STORAGE_KEY,
          );
          if (!serializedRequest) {
            throw new Error("Missing stored tool request; run phase=start first");
          }
          const toolRequest = parseStage0ToolRequest(serializedRequest);
          const resumed = await dispatchStage0Event(
            createStage0ResumeEvent(toolRequest, "stage0-remote-resume"),
          );
          if (!disposed) setReport(evaluateRemoteResumeResult(resumed));
        } else {
          const reset = await dispatchStage0Event(createStage0ResetEvent());
          const nextReport = evaluateRemoteResetResult(reset);
          if (nextReport.status === "PASS") {
            localStorage.removeItem(STAGE0_TOOL_REQUEST_STORAGE_KEY);
          }
          if (!disposed) setReport(nextReport);
        }
      } catch (error) {
        if (!disposed) {
          setReport(createStage0FailureResult(phase, errorText(error)));
        }
      } finally {
        if (!disposed) setRunning(false);
      }
    };

    void run();
    return () => {
      disposed = true;
    };
  }, [hydrated, phase]);

  return (
    <main className={styles.shell} data-status={report.status}>
      <section className={styles.panel} aria-labelledby="agent-poc-title">
        <div className={styles.eyebrow}>STAGE 0 · REMOTE DISPATCH</div>
        <h1 id="agent-poc-title">远程教练会话检查</h1>
        <p className={styles.lede}>
          浏览器只发紧凑事件；localhost 进程内恢复 / Cloudflare Durable Object 持久恢复。
        </p>

        <div className={styles.statusGrid} aria-live="polite">
          <div className={styles.statusCard}>
            <span>Agent backend</span>
            <strong>{report.backend ?? "WAITING"}</strong>
            <small>{stage0BackendDescription(report)}</small>
          </div>
          <div className={styles.statusCard}>
            <span>Remote dispatch</span>
            <strong>{report.status}</strong>
            <small>effect {report.effectCount}</small>
          </div>
        </div>

        <div className={styles.actions}>
          {phase === "start" && report.status === "PASS" ? (
            <button type="button" onClick={() => navigateToPhase("resume")}>
              整页重载并恢复
            </button>
          ) : null}
          {phase === "resume" && report.status === "PASS" ? (
            <button type="button" onClick={() => navigateToPhase("reset")}>
              清理固定测试数据
            </button>
          ) : null}
          <span>{running ? "运行中…" : `phase=${phase}`}</span>
        </div>

        <pre
          id="coach-agent-stage0-result"
          className={styles.result}
          data-status={report.status}
        >
          {JSON.stringify(report, null, 2)}
        </pre>
      </section>
    </main>
  );
}

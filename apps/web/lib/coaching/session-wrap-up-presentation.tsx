import type { CoachAgentResult, SessionWrapUpResult } from "@cs-coach/coach-agent/client";
import type { ReviewPlan } from "@cs-coach/contracts";

export function canPublishSessionWrapUp(result: CoachAgentResult, generation: number, currentGeneration: number, runId: string, takenOver: boolean): boolean {
  return generation === currentGeneration && !takenOver && result.identity.runId === runId
    && result.status === "COMPLETED" && result.state.sessionStatus === "COMPLETED";
}

export function isSessionWrapUpIdentityCurrent(result: { identity: { sessionId: string; runId: string } },
  session: Pick<import("@cs-coach/contracts").CoachingSessionState, "id" | "phase"> | undefined,
  activeRunId: string | undefined): boolean {
  // Normal completion releases recovery/Stage3 identity but retains the completed session.
  return session?.id === result.identity.sessionId && (activeRunId === result.identity.runId
    || (activeRunId === undefined && session.phase === "COMPLETED"));
}

export function sessionWrapUpPresentation(result: SessionWrapUpResult | null | undefined): { status: "READY" | "FALLBACK"; error?: string } {
  if (!result) return { status: "FALLBACK", error: "这次历史记录未保存全场总结，无法确认当时是否生成成功。已完成的复盘和回看不受影响。" };
  const failure = sessionWrapUpFailureReasonMessage(result.manifest.reason);
  if (failure && result.status !== "SUCCEEDED") return { status: "FALLBACK", error: failure };
  const local = result.status === "DISABLED" && result.manifest.provider === "DETERMINISTIC" && result.manifest.reason === "CLOSED_SESSION_PROJECTION";
  return {
    status: result.status === "SUCCEEDED" || local ? "READY" : "FALLBACK",
    error: result.status === "SUCCEEDED" || local || result.manifest.reason === "NO_REPEATED_THEME"
      ? undefined : "智能总结暂不可用，下面保留已确认的复盘结论。",
  };
}

export function SessionWrapUpNotice({ error }: { error?: string }) {
  return error ? <p>{error}</p> : null;
}

export type SessionWrapUpFailureReason = "MISSING_SESSION_SUMMARY" | "INVALID_PRESENTABLE_INPUT" | "SOURCE_LIMITATIONS_EXCEED_OUTPUT_LIMIT";

export function sessionWrapUpFailureReasonMessage(reason: string | undefined): string | undefined {
  switch (reason) {
    case "MISSING_SESSION_SUMMARY": return "缺少完整的会话摘要，未生成全场总结；已完成的复盘和回看不受影响。";
    case "INVALID_PRESENTABLE_INPUT": return "已完成片段的可展示资料不足，未生成全场总结；已完成的复盘和回看不受影响。";
    case "SOURCE_LIMITATIONS_EXCEED_OUTPUT_LIMIT": return "总结需要保留的限定超过当前上限，未生成总结；已完成的复盘和回看不受影响。";
    default: return undefined;
  }
}

export function sessionWrapUpFailureMessage(error: unknown): string {
  return sessionWrapUpFailureReasonMessage(error instanceof Error && error.message === "SOURCE_LIMITATIONS_EXCEED_OUTPUT_LIMIT"
    ? "SOURCE_LIMITATIONS_EXCEED_OUTPUT_LIMIT" : "INVALID_PRESENTABLE_INPUT")!;
}

function representativeRoundLabels(theme: SessionWrapUpResult["bundle"]["themes"][number], plan?: ReviewPlan): string[] {
  if (plan?.status !== "COMPLETE") return [];
  const rounds = new Set<number>();
  for (const ref of theme.summary.refs) {
    const matches = plan.cues.filter(cue => cue.id === ref);
    if (matches.length !== 1) continue;
    const cue = matches[0];
    // Summary refs can also name evidence. Only unambiguous, same-theme cue refs locate a case.
    if (cue.primary_focus_code !== theme.focus || plan.cues.some(candidate =>
      [...candidate.facts, ...candidate.inferences, ...candidate.advice, ...candidate.evidence,
        ...(candidate.action_facts ?? []), ...(candidate.outcome_facts ?? [])].some(item => item.id === ref))) continue;
    const segments = plan.segments.filter(segment => segment.id === cue.segment_id);
    if (segments.length !== 1) continue;
    const segment = segments[0];
    if (!segment.cue_ids.includes(cue.id) || !Number.isSafeInteger(segment.round_number) || segment.round_number <= 0) continue;
    rounds.add(segment.round_number);
  }
  return [...rounds].map(round => `第 ${round} 回合`);
}

export function SessionWrapUpPanel({ status, result, plan, phase, error, onComplete }: {
  status: string; result?: SessionWrapUpResult;
  request?: import("@cs-coach/coach-agent/client").SessionWrapUpRequest;
  plan?: import("@cs-coach/contracts").ReviewPlan;
  phase: string; error?: string; onComplete: () => void;
}) {
  return <section className="cs2d-coach-summary" aria-live="polite">
    <small>本场复盘总结</small>
    {status === "LOADING" ? <p>正在整理已完成且可呈现的讲解点。</p> : null}
    <SessionWrapUpNotice error={error} />
    {(result?.bundle.themes.length ?? 0) > 0 ? <div>{result?.bundle.themes.slice(0, 3).map((theme, index) => {
      const roundLabels = representativeRoundLabels(theme, plan);
      return <article key={`${theme.focus}-${index}`} className="cs2d-coach-card">
        <small>主题 {index + 1} · {roundLabels.length ? `代表案例：${roundLabels.join("、")}` : "已完成讲解点"}</small>
        <p>{theme.summary.text}</p><p><b>训练建议：</b>{theme.trainingAdvice.text}</p>
      </article>;
    })}</div> : result && status !== "LOADING" && !error ? <p>本场没有足够重复且条件明确的证据，暂不归纳为习惯。</p> : null}
    {(result?.bundle.themes.length ?? 0) > 0 ? result?.bundle.limitations.map((limitation, index) => <p key={`limitation-${index}`}>{limitation}</p>) : null}
    {phase === "WRAP_UP" ? <button className="cs2d-coach-primary" type="button" onClick={onComplete}>完成本次复盘</button> : null}
  </section>;
}

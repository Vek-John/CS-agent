"use client";

import { useMemo, useState } from "react";
import type {
  CoachCue,
  CoachVerdict,
  CueCase,
  DiagnosticResult,
  Fact,
  HingeCondition,
  LearningThread,
  ReflectionGoal,
  TransferRule,
  UserReflection,
} from "@cs-coach/contracts";
import styles from "./teaching-diagnosis-panel.module.css";

const GOALS: readonly { value: ReflectionGoal; label: string }[] = [
  { value: "GET_INFO", label: "拿信息" },
  { value: "TAKE_SPACE", label: "抢空间或首杀" },
  { value: "TRADE", label: "给队友补枪" },
  { value: "DELAY", label: "拖时间" },
  { value: "ROTATE", label: "转点" },
  { value: "SAVE", label: "保枪" },
  { value: "EXECUTE_PLAN", label: "执行战术" },
  { value: "MECHANICAL_ATTEMPT", label: "纯执行尝试" },
  { value: "UNKNOWN", label: "不记得" },
  { value: "OTHER", label: "其他" },
];

const DISAGREEMENT_OPTIONS = [
  "有队友语音",
  "这是固定战术",
  "我听到了脚步",
  "队友本该跟我",
  "时间压力更大",
] as const;

export interface TeachingDiagnosisPanelProps {
  cue: Pick<CoachCue, "id" | "title" | "question">;
  decisionFacts: readonly Fact[];
  cueCase?: CueCase;
  learningThread?: LearningThread;
  busy?: boolean;
  error?: string;
  onSubmit: (reflection: UserReflection) => void | Promise<void>;
  onSkip: () => void | Promise<void>;
  onConfirm: () => void;
  onDisagree: (reflection: UserReflection) => void | Promise<void>;
}

function verdictLabel(verdict: CoachVerdict["type"]): string {
  switch (verdict) {
    case "GOAL_AND_ACTION_ALIGNED": return "目标与行动一致";
    case "GOAL_VALID_CONDITION_FAILED": return "目标合理，但关键条件没成立";
    case "BELIEF_INCORRECT": return "信息判断有误";
    case "ACTION_GOAL_MISMATCH": return "行动没有完成目标";
    case "EXECUTION_ONLY": return "更像纯执行问题";
    case "TEAM_EXECUTION": return "更像团队同步问题";
    case "INCONCLUSIVE": return "目前无法确定";
  }
}

function resultLabel(status: DiagnosticResult["status"]): string {
  switch (status) {
    case "SUPPORTED": return "支持这个条件";
    case "PARTIALLY_SUPPORTED": return "部分支持";
    case "CONTRADICTED": return "不支持这个条件";
    case "UNVERIFIABLE": return "数据无法验证";
    case "UNTESTED": return "尚未验证";
  }
}

function reflectionQuestion(cue: TeachingDiagnosisPanelProps["cue"]): string {
  const semanticText = `${cue.title} ${cue.question}`;
  if (/补枪|队友/.test(semanticText)) return "你当时是想形成补枪，还是在等队友同步？";
  if (/信息|脚步/.test(semanticText)) return "你当时是依据什么信息做这个动作的？";
  if (/时间|拖延/.test(semanticText)) return "你当时想争取什么时间窗口？";
  return "在你做这个动作时，最想完成的目标是什么？";
}

function makeReflection(cueId: string, selectedGoal: ReflectionGoal | undefined, rawText: string, response: UserReflection["response"] = "ANSWERED"): UserReflection {
  return {
    cueId,
    ...(selectedGoal ? { selectedGoal } : {}),
    ...(rawText.trim() ? { rawText: rawText.trim().slice(0, 500) } : {}),
    response,
    source: "USER",
    limitations: [],
  };
}

function DecisionFacts({ facts }: { facts: readonly Fact[] }) {
  if (facts.length === 0) return <p className={styles.muted}>当前决策事实有限，先用你自己的描述补充上下文。</p>;
  return (
    <ul className={styles.factList}>
      {facts.slice(0, 3).map((fact) => <li key={fact.id}>{fact.text}</li>)}
    </ul>
  );
}

function Limitations({ values }: { values: readonly string[] }) {
  const shown = [...new Set(values.filter(Boolean))].slice(0, 4);
  if (shown.length === 0) return null;
  return <ul className={styles.limitations}>{shown.map((value) => <li key={value}>{value}</li>)}</ul>;
}

export function TeachingDiagnosisPanel({
  cue,
  decisionFacts,
  cueCase,
  learningThread,
  busy = false,
  error,
  onSubmit,
  onSkip,
  onConfirm,
  onDisagree,
}: TeachingDiagnosisPanelProps) {
  const [selectedGoal, setSelectedGoal] = useState<ReflectionGoal>();
  const [text, setText] = useState("");
  const [disagreeing, setDisagreeing] = useState(false);
  const [disagreement, setDisagreement] = useState("");
  const [disagreementGoal, setDisagreementGoal] = useState<ReflectionGoal>();
  const question = useMemo(() => reflectionQuestion(cue), [cue]);

  if (!cueCase || cueCase.status === "REFLECTION_PENDING") {
    return (
      <section className={styles.panel} aria-live="polite" aria-labelledby={`${cue.id}-reflection-title`}>
        <div className={styles.topline}>
          <div className={styles.kicker}>先说说你的思路</div>
          <span className={styles.counter}>1 / 2</span>
        </div>
        <h3 id={`${cue.id}-reflection-title`}>{question}</h3>
        <p className={styles.lede}>只选一个最接近的目标即可，也可以补一句话；不需要猜结果。</p>
        <div className={styles.goalGrid} role="group" aria-label="当时的目标">
          {GOALS.map((goal) => (
            <button
              key={goal.value}
              type="button"
              className={selectedGoal === goal.value ? styles.goalSelected : styles.goal}
              aria-pressed={selectedGoal === goal.value}
              onClick={() => setSelectedGoal(goal.value)}
              disabled={busy}
            >
              {goal.label}
            </button>
          ))}
        </div>
        <label className={styles.label} htmlFor={`${cue.id}-reflection-text`}>可选补充</label>
        <textarea
          id={`${cue.id}-reflection-text`}
          value={text}
          maxLength={500}
          onChange={(event) => setText(event.target.value)}
          placeholder="例如：我以为队友能马上补枪"
          disabled={busy}
          rows={2}
        />
        <div className={styles.factBox}>
          <span>先确认的事实</span>
          <DecisionFacts facts={decisionFacts} />
        </div>
        {error ? <p className={styles.error} role="alert">{error}</p> : null}
        <div className={styles.actions}>
          <button type="button" className={styles.primary} disabled={busy || (!selectedGoal && !text.trim())} onClick={() => void onSubmit(makeReflection(cue.id, selectedGoal, text))}>{busy ? "正在检查…" : "检查这个条件"}</button>
          <button type="button" className={styles.secondary} disabled={busy} onClick={() => void onSkip()}>跳过，直接看分析</button>
        </div>
      </section>
    );
  }

  if (cueCase.status === "FALLBACK" || !cueCase.hinge || !cueCase.diagnosticResult || !cueCase.verdict || !cueCase.transferRule) {
    return (
      <section className={`${styles.panel} ${styles.fallback}`} aria-live="polite">
        <div className={styles.topline}>
          <div className={styles.kicker}>基础讲解</div>
          <span className={styles.counter}>已降级</span>
        </div>
        <h3>这次先不做自适应诊断</h3>
        <p className={styles.lede}>保留原有的事实和讲解，你仍然可以继续回放。</p>
        <Limitations values={cueCase.limitations} />
        <button type="button" className={styles.primary} onClick={onConfirm}>看完了，继续下一段</button>
      </section>
    );
  }

  const { hinge, diagnosticResult, verdict, transferRule } = cueCase;
  const showDisagreement = disagreeing && cueCase.attemptBudget.disagreement < 1;
  return (
    <section className={styles.panel} aria-live="polite" aria-labelledby={`${cue.id}-diagnosis-title`}>
      <div className={styles.topline}>
        <div className={styles.kicker}>你的思路 · {cueCase.pedagogyMode === "CLARIFY" ? "继续澄清" : "第一次讲清"}</div>
        <span className={styles.counter}>2 / 2</span>
      </div>
      <h3 id={`${cue.id}-diagnosis-title`}>诊断完成</h3>
      <div className={styles.claimBox}>
        <span>你的思路</span>
        <p>{cueCase.reflection?.rawText || cueCase.reflection?.selectedGoal || "你没有提供具体目标"}</p>
        <small>这段内容保留为 USER claim，不会被当作 Demo 事实。</small>
      </div>
      <div className={styles.hingeBox}>
        <span>关键条件</span>
        <p>{hinge.statement}</p>
      </div>
      <div className={styles.evidenceBox}>
        <span>证据结论 · {resultLabel(diagnosticResult.status)}</span>
        <p>{diagnosticResult.explanation}</p>
        {diagnosticResult.measurements.length > 0 ? (
          <ul className={styles.measurements}>{diagnosticResult.measurements.slice(0, 4).map((measurement) => <li key={measurement.id}><b>{measurement.label}</b><span>{String(measurement.value)}{measurement.unit ?? ""}</span></li>)}</ul>
        ) : null}
      </div>
      <div className={styles.verdictBox}>
        <span>这次怎么判 · {verdictLabel(verdict.type)}</span>
        <p>{verdict.explanation}</p>
        <small>置信度 {Math.round(verdict.confidence * 100)}%</small>
      </div>
      <div className={styles.transferBox}>
        <span>下次记住什么</span>
        <p><b>当：</b>{transferRule.when}</p>
        <p><b>做：</b>{transferRule.do}</p>
        {transferRule.unless ? <p><b>除非：</b>{transferRule.unless}</p> : null}
      </div>
      <Limitations values={[...hinge.limitations, ...diagnosticResult.limitations, ...verdict.limitations, ...(learningThread?.status === "REPEATED" ? ["本场同类条件再次出现，已更新 Learning Thread。"] : [])]} />
      {showDisagreement ? (
        <div className={styles.disagreementBox}>
          <span>补充一条信息（只会再检查一次）</span>
          <div className={styles.quickGrid}>
            {DISAGREEMENT_OPTIONS.map((option) => <button key={option} type="button" className={disagreement === option ? styles.quickSelected : styles.quick} onClick={() => setDisagreement(option)}>{option}</button>)}
          </div>
          <label className={styles.label} htmlFor={`${cue.id}-disagreement`}>其他补充</label>
          <textarea id={`${cue.id}-disagreement`} value={disagreement} maxLength={500} onChange={(event) => setDisagreement(event.target.value)} rows={2} placeholder="只写会改变判断的那条信息" />
          <div className={styles.actions}>
            <button type="button" className={styles.primary} disabled={busy || (!disagreement.trim() && !disagreementGoal)} onClick={() => void onDisagree(makeReflection(cue.id, disagreementGoal, disagreement))}>用这条信息再检查一次</button>
            <button type="button" className={styles.secondary} disabled={busy} onClick={() => setDisagreeing(false)}>先不补充</button>
          </div>
        </div>
      ) : null}
      <div className={styles.actions}>
        <button type="button" className={styles.primary} disabled={busy} onClick={onConfirm}>懂了，继续</button>
        {!showDisagreement && cueCase.attemptBudget.disagreement < 1 ? <button type="button" className={styles.secondary} disabled={busy} onClick={() => setDisagreeing(true)}>我不同意这个结论</button> : null}
        {!showDisagreement && cueCase.attemptBudget.disagreement < 1 ? <button type="button" className={styles.tertiary} disabled={busy} onClick={() => setDisagreeing(true)}>这不是我当时的想法</button> : null}
      </div>
    </section>
  );
}

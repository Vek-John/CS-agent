import { Check, Circle, LoaderCircle, ShieldCheck, TriangleAlert } from "lucide-react";
import styles from "./coach-setup-flow.module.css";

export type CoachSetupStepState = "complete" | "active" | "pending" | "error";

export interface CoachSetupStep {
  readonly title: string;
  readonly detail: string;
  readonly state: CoachSetupStepState;
  readonly progress?: number;
}

function StepIcon({ state }: { state: CoachSetupStepState }) {
  if (state === "complete") return <Check aria-hidden="true" />;
  if (state === "active") return <LoaderCircle aria-hidden="true" />;
  if (state === "error") return <TriangleAlert aria-hidden="true" />;
  return <Circle aria-hidden="true" />;
}

const STATE_LABEL: Record<CoachSetupStepState, string> = {
  complete: "完成",
  active: "进行中",
  pending: "等待",
  error: "需要处理",
};

export function CoachSetupFlow({ steps, winRateFallback }: { steps: readonly CoachSetupStep[]; winRateFallback?: { requested: boolean; onChoose: () => void } }) {
  return (
    <section className={styles.flow} aria-labelledby="coach-setup-title">
      <div className={styles.heading}>
        <div>
          <p>本地准备</p>
          <h3 id="coach-setup-title">把比赛变成一条复盘路线</h3>
        </div>
        <span>{steps.filter((step) => step.state === "complete").length}/{steps.length}</span>
      </div>
      <ol className={styles.steps}>
        {steps.map((step, index) => (
          <li
            key={step.title}
            data-state={step.state}
            aria-current={step.state === "active" ? "step" : undefined}
          >
            <span className={styles.index}>{String(index + 1).padStart(2, "0")}</span>
            <span className={styles.icon}><StepIcon state={step.state} /></span>
            <div className={styles.copy}>
              <div><strong>{step.title}</strong><small>{STATE_LABEL[step.state]}</small></div>
              <p>{step.detail}</p>
              {typeof step.progress === "number" ? (
                <span
                  className={styles.progress}
                  role="progressbar"
                  aria-label={`${step.title}进度`}
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-valuenow={Math.round(step.progress)}
                >
                  <i style={{ transform: `scaleX(${Math.max(0, Math.min(100, step.progress)) / 100})` }} />
                </span>
              ) : null}
            </div>
          </li>
        ))}
      </ol>
      {winRateFallback ? <div className={styles.optionalAnalysis}>
        <p role="status">{winRateFallback.requested ? "正在切换到基础路线…" : "胜率分析仍在准备。可以先开始带看，本次不包含胜率分析。"}</p>
        <button type="button" className="cs2d-coach-primary" disabled={winRateFallback.requested} onClick={winRateFallback.onChoose}>先用基础路线</button>
      </div> : null}
      <p className={styles.privacy}><ShieldCheck aria-hidden="true" />Demo 文件和比赛回放只保存在本机</p>
    </section>
  );
}

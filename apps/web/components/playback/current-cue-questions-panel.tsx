"use client";

import {
  CURRENT_CUE_QUESTIONS, MAX_CUE_QUESTION_LENGTH,
  type CurrentCueQuestionState,
} from "../../lib/coaching/current-cue-questions";
import styles from "./teaching-diagnosis-panel.module.css";

export interface CurrentCueQuestionsPanelProps {
  state: CurrentCueQuestionState;
  onDraft: (text: string) => void;
  onAsk: (question?: string) => void;
}

/** Controlled by Host so a replay can unmount this surface without losing its draft or answers. */
export function CurrentCueQuestionsPanel({ state, onDraft, onAsk }: CurrentCueQuestionsPanelProps) {
  return (
    <section className={styles.panel} aria-labelledby="current-cue-questions-title">
      <h3 id="current-cue-questions-title">问问当前教学点</h3>
      <p className={styles.lede}>仅核对当前已展示的事实与限制，不重新分析或改判。记录仅在本页临时保留，最多4条，不写入复盘历史。</p>
      <div className={styles.quickGrid} role="group" aria-label="当前教学点的快捷问题">
        {CURRENT_CUE_QUESTIONS.map(question => <button key={question} className={styles.secondary} type="button" onClick={() => onAsk(question)}>{question}</button>)}
      </div>
      <form onSubmit={event => { event.preventDefault(); onAsk(); }}>
        <label className={styles.label} htmlFor="current-cue-question">你的问题（最多300字）</label>
        <textarea id="current-cue-question" value={state.draft} maxLength={MAX_CUE_QUESTION_LENGTH} rows={2}
          onChange={event => onDraft(event.target.value)} placeholder="例如：还有哪些未知条件？" />
        <div className={styles.actions}>
          <button className={styles.primary} type="submit" disabled={!state.draft.trim()}>询问当前教学点</button>
        </div>
      </form>
      {state.error ? <p role="alert" className={styles.error}>{state.error}</p> : null}
      <div aria-live="polite" aria-relevant="additions text">
        {state.turns.map(turn => (
          <article key={turn.question} className={`${styles.factBox} ${styles.questionTurn}`}>
            <span>你问：{turn.question}</span>
            <p className={styles.lede}>{turn.answer.text}</p>
            {turn.answer.items.length > 0 ? <ul className={styles.factList}>{turn.answer.items.map((item, index) => <li key={index}>{item.text}</li>)}</ul> : null}
            <p className={styles.muted}>来源：{turn.answer.source}</p>
          </article>
        ))}
      </div>
    </section>
  );
}

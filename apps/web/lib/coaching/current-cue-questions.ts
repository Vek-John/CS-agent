import type { CoachingSessionState, CueCase, NarrationBundle, ReviewPlan } from "@cs-coach/contracts";
import { CueCaseSchema } from "@cs-coach/coach-agent/client";
import { getCurrentCue, getCurrentSegment } from "@cs-coach/session";
import { observableSituation, playerFacingLimitation } from "./decision-presentation";
import { matchDisplayedCueResources, type CurrentCueResourceSource, type CueResourceKind, type VerifiedResourceText } from "./current-cue-resource-source";

export const MAX_CUE_QUESTION_LENGTH = 300;
export const CURRENT_CUE_QUESTIONS = ["这次判断依据是什么？", "当时有哪些已知事实？", "还有哪些未知条件？"] as const;

export interface CurrentCueQuestionInput {
  plan?: ReviewPlan;
  session?: CoachingSessionState;
  generation: number;
  diagnosticsEnabled: boolean;
  cueCase?: CueCase;
  presentableNarration?: NarrationBundle;
  busy: boolean;
  takenOver: boolean;
  resourceSource?: CurrentCueResourceSource;
}
interface CitedText { text: string; refs: readonly string[] }
export interface CurrentCueQuestionContext {
  key: string;
  facts: readonly CitedText[];
  basis: readonly CitedText[];
  limitations: readonly string[];
  limitationSource: string;
  resources: Partial<Record<CueResourceKind, VerifiedResourceText>>;
}
export interface CurrentCueAnswer {
  text: string;
  items: readonly CitedText[];
  source: string;
}
export interface CurrentCueQuestionState {
  key: string;
  draft: string;
  turns: readonly { question: string; answer: CurrentCueAnswer }[];
  error?: string;
}

const boundedText = (text: string) => text.trim().length > 0 && text.length <= 400;
const tick = (value: number | undefined): value is number => Number.isSafeInteger(value) && value! >= 0;

/** Read-only, page-local projection. It cannot submit diagnostics or issue playback commands. */
export function buildCurrentCueQuestionContext(input: CurrentCueQuestionInput): CurrentCueQuestionContext | undefined {
  const { plan, session } = input;
  if (!plan || !session || session.review_plan_id !== plan.id || session.phase !== "PAUSED_FOR_COACHING"
    || session.manual_cue_visit || input.takenOver || input.busy) return;
  const cue = getCurrentCue(plan, session);
  const segment = getCurrentSegment(plan, session);
  const gate = session.outcome_completion;
  if (!cue || !segment || cue.segment_id !== segment.id || !segment.cue_ids.includes(cue.id)
    || !session.revealed_cue_ids.includes(cue.id) || !gate || gate.cueId !== cue.id || gate.status !== "COMPLETE"
    || !tick(cue.decision_tick) || !tick(cue.outcome_end_tick) || gate.outcomeEndTick !== cue.outcome_end_tick
    || !tick(gate.completedAtTick) || gate.completedAtTick < cue.outcome_end_tick) return;
  const observable = cue.observableContext;
  if (!cue.assessment || !observable || observable.boundary !== "OBSERVABLE" || observable.source !== "DEMO_OBSERVER_EVIDENCE"
    || observable.state.demo_id !== plan.demo_id || observable.state.observer_player_id !== plan.player_id
    || observable.state.at_tick !== cue.decision_tick) return;

  let basisRefs: readonly string[];
  let limitations: readonly string[];
  let sourceRevision: unknown;
  let shownFactIds: ReadonlySet<string>;
  let limitationSource: string;
  let resources: CurrentCueQuestionContext["resources"] = {};
  if (input.diagnosticsEnabled && input.cueCase?.status !== "FALLBACK") {
    const parsed = CueCaseSchema.safeParse(input.cueCase);
    if (!parsed.success) return;
    const c = parsed.data;
    const r = c.diagnosticResult;
    if (c.cueId !== cue.id || (c.candidateId !== undefined && c.candidateId !== cue.candidate_id)
      || !["VERDICT_READY", "AWAITING_CONFIRMATION", "COMPLETED"].includes(c.status)
      || c.reflection?.cueId !== cue.id || c.hinge?.cueId !== cue.id || !r || r.cueId !== cue.id
      || r.hingeId !== c.hinge.hingeId || !c.verdict || c.verdict.hingeId !== c.hinge.hingeId
      || c.verdict.diagnosticResultId !== r.resultId || !c.transferRule) return;
    basisRefs = r.evidenceRefs;
    limitations = [...c.hinge.limitations, ...r.limitations, ...c.verdict.limitations];
    // The reflection surface displays these first three decision facts. Do not widen that surface here.
    shownFactIds = new Set(cue.facts.filter(f => f.availability === "DECISION" && f.available_at_tick <= cue.decision_tick && cue.observable_fact_refs.includes(f.id)).slice(0, 3).map(f => f.id));
    sourceRevision = [c.caseId, r.resultId, c.verdict.revision, c.status];
    limitationSource = "当前诊断已显示的限制";
    resources = matchDisplayedCueResources(input.resourceSource, plan, cue, r.measurements);
  } else {
    const n = input.presentableNarration;
    if (!n || n.cueId !== cue.id || n.candidateId !== cue.candidate_id) return;
    basisRefs = cue.assessment.supportingEvidenceRefs;
    shownFactIds = new Set(n.currentSituation.refs);
    limitations = [...observableSituation(cue).limitations, ...cue.assessment.limitations.map(playerFacingLimitation)].slice(0, 3);
    sourceRevision = n;
    limitationSource = "当前讲解已显示的限制";
  }
  const idCounts = new Map<string, number>();
  for (const fact of cue.facts) idCounts.set(fact.id, (idCounts.get(fact.id) ?? 0) + 1);
  const facts = cue.facts.filter(f => shownFactIds.has(f.id) && idCounts.get(f.id) === 1
    && f.source === "DEMO" && f.availability === "DECISION" && f.observed_by_player
    && tick(f.available_at_tick) && f.available_at_tick <= cue.decision_tick
    && cue.observable_fact_refs.includes(f.id) && boundedText(f.text)).slice(0, 6)
    .map(f => ({ text: f.text, refs: [f.id] }));
  const basis = facts.filter(f => f.refs.every(ref => basisRefs.includes(ref)));
  const shownLimitations = [...new Set(limitations.filter(Boolean).map(playerFacingLimitation))].slice(0, 4)
    .map(text => boundedText(text) ? text : "当前记录中的限制较长，请结合上方完整诊断查看；这里不截断后改变其含义。");
  return {
    key: JSON.stringify([input.generation, session.id, plan.id, cue.id, sourceRevision, facts, basis, shownLimitations, input.resourceSource?.revision, resources]),
    facts, basis, limitations: shownLimitations, limitationSource, resources,
  };
}

const normalize = (question: string) => question.trim().replace(/[？?。！!\s]/g, "");

/** Exact supported phrasings, not general semantic understanding or a keyword-driven advisor. */
export function answerGroundedCueQuestion(context: CurrentCueQuestionContext, question: string): CurrentCueAnswer {
  const q = normalize(question);
  const boundary = (text: string): CurrentCueAnswer => ({ text, items: [], source: "当前追问的能力边界" });
  if (!question.trim() || question.length > MAX_CUE_QUESTION_LENGTH) return boundary("请用1至300字提问当前教学点。");
  if (/(一定|肯定|必然|绝对|百分之百|100%).*(错|对|合理|失误)|为什么.*(错了|是错的)/.test(q)) {
    return boundary("不能预设这次选择一定对或错。追问不会重判你的选择；可以查看已核实事实、部分判断依据和仍缺少的条件。");
  }
  if (/职业|pro\b/i.test(q)) return boundary("这里没有接入可验证的职业案例，不能据此说明职业选手通常怎么做。");
  if (/语音|报点|队友报|叫我|战术|听到|脚步/.test(q)) return boundary("你补充的语音或战术只能作为假设，当前记录不能确认它。这条追问不会把它写成事实，也不会据此改判；如需复核原诊断，可使用上方的异议入口。");
  if (["再看一遍", "能再放一遍吗", "重播", "继续下一段"].includes(q)) return boundary("请使用讲解区已有的回看或继续按钮。追问文字不会直接控制播放。");
  const resourceQuestions: readonly [CueResourceKind, readonly string[]][] = [
    ["health", ["我当时多少血", "当时多少血", "当时血量是多少"]],
    ["armor", ["当时有多少护甲", "我当时有多少护甲"]],
    ["utility", ["当时有几颗道具", "我当时有几颗道具"]],
    ["ammo", ["弹匣当时还有几发", "当时弹匣还有几发"]],
  ];
  const resourceKind = resourceQuestions.find(([, questions]) => questions.includes(q))?.[0];
  if (resourceKind) {
    const resource = context.resources[resourceKind];
    const name = { health: "血量", armor: "护甲", utility: "道具数量", ammo: "决策前最近弹匣记录" }[resourceKind];
    return resource ? {
      text: resourceKind === "ammo"
        ? "这是决策前最近记录，不能保证决策瞬间的精确余量；采样后的换枪或换弹仍可能未知，备弹未知。不能仅据这个数值判错或建议换弹。"
        : "这个数值已在当前诊断中展示，并与当前可验证的本人资源记录一致；它本身不构成战术建议或新的判断。",
      items: [resource], source: "当前诊断数值证据与本人资源记录交叉核对",
    } : {
      text: `目前无法可靠核对${name}：缺少可匹配的已展示数值或合法来源，不能把未知补成0。${resourceKind === "ammo" ? "备弹也未知。" : ""}`,
      items: [], source: "当前资源的来源缺口",
    };
  }
  if (["这次判断依据是什么", "判断依据是什么", "这个判断的依据是什么"].includes(q)) {
    return {
      text: context.basis.length
        ? "以下是当前判断引用中能逐条核对的部分决策事实，尚不能完整解释整个判断，也不能仅凭这些记录认定你的选择一定错误。"
        : context.facts.length
          ? "目前只能列出已核实事实，尚不能完整解释这个判断。诊断中的数值证据仍请结合上方的原说明与限制查看。"
          : "当前没有可逐条引用的决策前事实，无法完整解释这个判断；不能补造它的依据。",
      items: context.basis.length ? context.basis : context.facts,
      source: context.basis.length ? "当前判断引用的决策前事实" : context.facts.length ? "当前已核实事实（不等于完整判断依据）" : "当前判断的来源缺口",
    };
  }
  if (["当时有哪些已知事实", "当时已知什么", "有哪些已知事实"].includes(q)) return {
    text: context.facts.length ? "下面只列当前已展示内容中可核实、且在决策时已可知的事实。之后的结果不用于反推当时知道什么。" : "当前已展示内容中没有可逐条核实的决策前事实，不能补造当时知道的信息。",
    items: context.facts, source: "当前教学点的决策前事实",
  };
  if (["还有哪些未知条件", "哪些条件还不知道", "还缺什么信息"].includes(q)) return {
    text: context.limitations.length ? "当前讲解仍保留以下限制；追问不会消除这些未知条件。" : "当前内容没有逐项列出更多未知条件，这不代表所有条件都已确认。",
    items: context.limitations.map(text => ({ text, refs: [] })), source: context.limitationSource,
  };
  return boundary("这句问法暂不支持可靠回答。可以问判断依据、已知事实或未知条件，也可以明确问“我当时多少血？”“当时有多少护甲？”“当时有几颗道具？”“弹匣当时还有几发？”。目前不能新增战术建议或回答其他教学点。");
}

export function currentCueQuestionState(state: CurrentCueQuestionState | undefined, context: CurrentCueQuestionContext): CurrentCueQuestionState {
  return state?.key === context.key ? state : { key: context.key, draft: "", turns: [] };
}

/** Both typing and submission recheck the live context; replay hides UI without erasing page-local state. */
export function updateCurrentCueQuestions(
  previous: CurrentCueQuestionState | undefined,
  requestedKey: string,
  context: CurrentCueQuestionContext | undefined,
  action: { type: "DRAFT"; text: string } | { type: "ASK"; question?: string },
): CurrentCueQuestionState | undefined {
  if (!context || context.key !== requestedKey) return previous;
  const current = currentCueQuestionState(previous, context);
  if (action.type === "DRAFT") return { ...current, draft: action.text.slice(0, MAX_CUE_QUESTION_LENGTH), error: undefined };
  const question = (action.question ?? current.draft).trim();
  if (!question || question.length > MAX_CUE_QUESTION_LENGTH) return { ...current, error: "请用1至300字提问当前教学点。" };
  const answer = answerGroundedCueQuestion(context, question);
  const turns = current.turns.some(turn => turn.question === question) ? current.turns : [...current.turns, { question, answer }].slice(-4);
  // Quick questions do not overwrite an independently edited draft.
  return { ...current, draft: action.question === undefined ? "" : current.draft, turns, error: undefined };
}

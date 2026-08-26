import { z } from "zod";
import type {
  CoachVerdict,
  CueCase,
  DiagnosticCapability,
  DiagnosticCapabilityKind,
  DiagnosticMeasurement,
  DiagnosticResult,
  DecisionResources,
  Fact,
  HingeCondition,
  LearningThread,
  PlayerActionFact,
  ReflectionGoal,
  ReflectionQuestionType,
  TransferRule,
  TeachingDiagnosisInput,
  TeachingDiagnosisOutput,
  UserClaim,
  UserClaimType,
  UserReflection,
  ClaimVerificationStatus,
  PedagogyMode,
  OutcomeFact,
} from "@cs-coach/contracts";
import {
  CLAIM_VERIFICATION_STATUSES,
  COACH_VERDICT_TYPES,
  CUE_CASE_STATUSES,
  DIAGNOSTIC_CAPABILITY_KINDS,
  HINGE_KINDS,
  LEARNING_THREAD_DIAGNOSIS_TYPES,
  LEARNING_THREAD_STATUSES,
  REFLECTION_GOALS,
  REFLECTION_QUESTION_TYPES,
  REFLECTION_RESPONSES,
  USER_CLAIM_TYPES,
} from "@cs-coach/contracts";

export const TEACHING_DIAGNOSIS_VERSION = "teaching-diagnosis.v1" as const;
export const CUE_CASE_VERSION = "cue-case.v1" as const;
export const MAX_REFLECTION_TEXT = 500;
export const MAX_DIAGNOSIS_LIMITATIONS = 12;

const IdSchema = z.string().min(1).max(160);
const TextSchema = z.string().min(1).max(800);
const ShortTextSchema = z.string().min(1).max(240);
const GoalSchema = z.enum(REFLECTION_GOALS);
const QuestionTypeSchema = z.enum(REFLECTION_QUESTION_TYPES);
const ResponseSchema = z.enum(REFLECTION_RESPONSES);
const ClaimTypeSchema = z.enum(USER_CLAIM_TYPES);
const VerificationSchema = z.enum(CLAIM_VERIFICATION_STATUSES);

export const UserReflectionSchema = z.object({
  cueId: IdSchema,
  rawText: z.string().max(MAX_REFLECTION_TEXT).optional(),
  selectedGoal: GoalSchema.optional(),
  reflectionId: IdSchema.optional(),
  questionType: QuestionTypeSchema.optional(),
  response: ResponseSchema.default("ANSWERED"),
  source: z.literal("USER"),
  limitations: z.array(ShortTextSchema).max(MAX_DIAGNOSIS_LIMITATIONS).default([]),
}).strict();
export type ParsedUserReflection = z.infer<typeof UserReflectionSchema>;

export const UserClaimSchema = z.object({
  claimId: IdSchema,
  type: ClaimTypeSchema,
  content: TextSchema,
  source: z.literal("USER"),
  verification: VerificationSchema,
  supportingRefs: z.array(IdSchema).max(32),
  contradictingRefs: z.array(IdSchema).max(32),
  limitations: z.array(ShortTextSchema).max(MAX_DIAGNOSIS_LIMITATIONS),
  cueId: IdSchema.optional(),
  originReflectionId: IdSchema.optional(),
}).strict();

const FactSchema = z.object({
  id: IdSchema,
  text: TextSchema,
  availability: z.enum(["DECISION", "OUTCOME"]),
  available_at_tick: z.number().int().nonnegative(),
  source: z.literal("DEMO"),
  observed_by_player: z.boolean(),
}).strict();
const ActionFactSchema = z.object({
  id: IdSchema,
  text: TextSchema,
  actorPlayerId: IdSchema,
  availableAtTick: z.number().int().nonnegative(),
  source: z.literal("DEMO"),
  evidenceRefs: z.array(IdSchema).max(32),
  limitations: z.array(ShortTextSchema).max(MAX_DIAGNOSIS_LIMITATIONS),
}).strict();
const OutcomeFactSchema = z.object({
  id: IdSchema,
  text: TextSchema,
  availableAtTick: z.number().int().nonnegative(),
  source: z.literal("DEMO"),
  outcomeKind: z.enum(["DEATH", "KILL", "HP_CHANGE", "BOMB", "UTILITY", "OTHER"]),
  evidenceRefs: z.array(IdSchema).max(32),
  limitations: z.array(ShortTextSchema).max(MAX_DIAGNOSIS_LIMITATIONS),
}).strict();
const PlayerStateSchema = z.object({
  player_id: IdSchema,
  tick: z.number().int().nonnegative(),
  side: z.enum(["T", "CT"]),
  health: z.number().finite().nonnegative(),
  armor: z.number().finite().nonnegative(),
  has_helmet: z.boolean(),
  money: z.number().finite().nonnegative().optional(),
  equipment_value: z.number().finite().nonnegative().optional(),
  inventory: z.array(z.object({ count: z.number().finite().nonnegative() }).passthrough()).max(32),
  active_item: z.object({ item_id: z.string().max(120), item_class: z.string().max(40) }).passthrough().optional(),
}).passthrough();

/** Identity-free resource projection used when the full decision frame stays in Host. */
export const DecisionResourcesSchema = z.object({
  health: z.number().finite().nonnegative().max(100),
  armor: z.number().finite().nonnegative().max(100),
  hasHelmet: z.boolean(),
  money: z.number().finite().nonnegative().max(10_000_000).optional(),
  equipmentValue: z.number().finite().nonnegative().max(10_000_000).optional(),
  inventoryCount: z.number().finite().nonnegative().max(64).optional(),
  evidenceRefs: z.array(IdSchema).max(32),
}).strict();

export const TeachingDiagnosisInputSchema = z.object({
  cueId: IdSchema,
  candidateId: IdSchema.optional(),
  cue: z.object({ id: IdSchema, primary_focus_code: z.string().max(160).optional(), limitations: z.array(ShortTextSchema).max(MAX_DIAGNOSIS_LIMITATIONS) }).strict().optional(),
  material: z.object({ candidateId: IdSchema, decisionFacts: z.array(FactSchema).max(32), playerActionFacts: z.array(ActionFactSchema).max(16), outcomeFacts: z.array(OutcomeFactSchema).max(16), advice: z.array(z.object({ id: IdSchema, text: TextSchema, trigger: TextSchema, fact_refs: z.array(IdSchema).max(32) }).strict()).max(16), limitations: z.array(ShortTextSchema).max(MAX_DIAGNOSIS_LIMITATIONS), economy: z.enum(["PISTOL", "ECO", "FORCE", "FULL", "UNKNOWN"]).optional(), contextCode: z.string().max(120).optional() }).strict().optional(),
  reflection: UserReflectionSchema,
  decisionFacts: z.array(FactSchema).max(32),
  playerActionFacts: z.array(ActionFactSchema).max(16),
  outcomeFacts: z.array(OutcomeFactSchema).max(16),
  decisionState: PlayerStateSchema.optional(),
  decisionResources: DecisionResourcesSchema.optional(),
  focusCode: z.string().max(160).optional(),
  economyClass: z.enum(["PISTOL", "ECO", "FORCE", "FULL", "UNKNOWN"]).optional(),
  // ThreadSchema is declared below so this lazy reference keeps the input
  // contract strict without introducing a duplicate (or unbounded) shape.
  existingThreads: z.array(z.lazy(() => ThreadSchema)).max(16).optional(),
  limitations: z.array(ShortTextSchema).max(MAX_DIAGNOSIS_LIMITATIONS).optional(),
}).strict();

const HingeSchema = z.object({
  hingeId: IdSchema,
  cueId: IdSchema,
  kind: z.enum(HINGE_KINDS),
  conditionCode: IdSchema,
  statement: TextSchema,
  claimRefs: z.array(IdSchema).max(32),
  evidenceRefs: z.array(IdSchema).max(32),
  verification: VerificationSchema,
  confidence: z.number().min(0).max(1),
  limitations: z.array(ShortTextSchema).max(MAX_DIAGNOSIS_LIMITATIONS),
}).strict();
const RecipeSchema = z.object({
  recipeId: IdSchema,
  title: ShortTextSchema,
  sections: z.array(z.enum(["CLAIM", "HINGE", "EVIDENCE", "VERDICT", "TRANSFER"])).max(5),
  visualHint: z.enum(["RESOURCE_CHIPS", "MAP_RELATION", "TIMELINE_WINDOW", "TEXT_ONLY"]).optional(),
}).strict();
const CapabilitySchema = z.object({
  id: z.enum(DIAGNOSTIC_CAPABILITY_KINDS),
  capabilityId: z.enum(DIAGNOSTIC_CAPABILITY_KINDS),
  kind: z.enum(DIAGNOSTIC_CAPABILITY_KINDS),
  cueId: IdSchema,
  hingeId: IdSchema,
  claimTypes: z.array(ClaimTypeSchema).max(8),
  boundEvidenceRefs: z.array(IdSchema).max(64),
  presentationRecipe: RecipeSchema,
  limitations: z.array(ShortTextSchema).max(MAX_DIAGNOSIS_LIMITATIONS),
}).strict();
const MeasurementSchema = z.object({ id: IdSchema, label: ShortTextSchema, value: z.union([z.number().finite(), z.string().max(120)]), unit: z.string().max(40).optional(), evidenceRefs: z.array(IdSchema).max(32) }).strict();
const DiagnosticResultSchema = z.object({
  resultId: IdSchema,
  capabilityId: z.enum(DIAGNOSTIC_CAPABILITY_KINDS),
  cueId: IdSchema,
  hingeId: IdSchema,
  status: VerificationSchema,
  evidenceRefs: z.array(IdSchema).max(64),
  measurements: z.array(MeasurementSchema).max(16),
  explanation: TextSchema,
  limitations: z.array(ShortTextSchema).max(MAX_DIAGNOSIS_LIMITATIONS),
}).strict();
const VerdictSchema = z.object({
  type: z.enum(COACH_VERDICT_TYPES),
  confidence: z.number().min(0).max(1),
  hingeId: IdSchema,
  diagnosticResultId: IdSchema.optional(),
  claimIds: z.array(IdSchema).max(32),
  evidenceRefs: z.array(IdSchema).max(64),
  limitations: z.array(ShortTextSchema).max(MAX_DIAGNOSIS_LIMITATIONS),
  revision: z.number().int().nonnegative().max(2),
  explanation: TextSchema,
}).strict();
const TransferRuleSchema = z.object({ ruleId: IdSchema, when: TextSchema, do: TextSchema, unless: TextSchema.optional(), refs: z.array(IdSchema).max(64), confidence: z.number().min(0).max(1), limitations: z.array(ShortTextSchema).max(MAX_DIAGNOSIS_LIMITATIONS) }).strict();
const ThreadSchema = z.object({
  threadId: IdSchema,
  scope: z.enum(["SESSION", "CROSS_DEMO"]),
  hingeCode: IdSchema,
  trigger: z.object({ situation: TextSchema, conditions: z.array(TextSchema).max(8) }).strict(),
  userModel: z.object({ goal: ShortTextSchema.optional(), belief: ShortTextSchema.optional(), expectedTeammateAction: ShortTextSchema.optional() }).strict(),
  diagnosis: z.object({ type: z.enum(LEARNING_THREAD_DIAGNOSIS_TYPES), summary: TextSchema, confidence: z.number().min(0).max(1) }).strict(),
  transferRule: TransferRuleSchema,
  evidenceCueIds: z.array(IdSchema).max(64),
  successfulCueIds: z.array(IdSchema).max(64),
  conflictingCueIds: z.array(IdSchema).max(64),
  status: z.enum(LEARNING_THREAD_STATUSES),
}).strict();
const CueCaseSchema = z.object({
  schemaVersion: z.literal(CUE_CASE_VERSION),
  caseId: IdSchema,
  cueId: IdSchema,
  candidateId: IdSchema.optional(),
  pedagogyMode: z.enum(["INTRODUCE", "CLARIFY", "CONTRAST", "CHECK_TRANSFER", "REINFORCE", "BRIEF_REPEAT", "DEFER"]),
  status: z.enum(CUE_CASE_STATUSES),
  reflection: UserReflectionSchema.optional(),
  claims: z.array(UserClaimSchema).max(16),
  hinge: HingeSchema.optional(),
  capabilities: z.array(CapabilitySchema).max(8),
  selectedCapabilityId: z.enum(DIAGNOSTIC_CAPABILITY_KINDS).optional(),
  diagnosticResult: DiagnosticResultSchema.optional(),
  verdict: VerdictSchema.optional(),
  transferRule: TransferRuleSchema.optional(),
  baselineNarrationAvailable: z.boolean(),
  attemptBudget: z.object({ reflection: z.number().int().min(0).max(1), diagnostic: z.number().int().min(0).max(1), disagreement: z.number().int().min(0).max(1), alternateDiagnostic: z.number().int().min(0).max(1) }).strict(),
  limitations: z.array(ShortTextSchema).max(MAX_DIAGNOSIS_LIMITATIONS),
}).strict();
const OutputSchema = z.object({ cueCase: CueCaseSchema, learningThread: ThreadSchema }).strict();
export const LearningThreadSchema = ThreadSchema;
export const TeachingDiagnosisOutputSchema = OutputSchema;

function unique(values: readonly string[]): string[] {
  return [...new Set(values.filter((value) => typeof value === "string" && value.trim()))];
}

function boundedText(value: string | undefined, max = 800): string {
  return (value ?? "").replace(/\s+/g, " ").trim().slice(0, max);
}

function stableToken(value: string): string {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

function reflectionId(cueId: string, reflection: UserReflection): string {
  return reflection.reflectionId?.trim() || `reflection-${stableToken(`${cueId}|${reflection.selectedGoal ?? "UNKNOWN"}|${reflection.rawText ?? ""}`)}`;
}

type ReflectionQuestionContext = Pick<TeachingDiagnosisInput, "focusCode" | "cue" | "material"> & { cueId?: string };

function questionTypeFor(input: ReflectionQuestionContext | undefined, reflection: UserReflection): ReflectionQuestionType {
  if (reflection.questionType) return reflection.questionType;
  const text = `${reflection.rawText ?? ""} ${input?.focusCode ?? input?.cue?.primary_focus_code ?? ""}`.toLowerCase();
  if (/队友|补枪|同步|跟上|叫我|语音|战术/.test(text)) return /语音|战术|叫我/.test(text) ? "TACTICAL_CONTEXT" : "TEAMMATE_EXPECTATION";
  if (/时间|来不及|时机|等/.test(text)) return "TIMING";
  if (/信息|听到|脚步|看到|报点|敌人/.test(text)) return "INFORMATION_JUDGMENT";
  if (/规则|应该|能不能|为什么/.test(text)) return "RULE_UNDERSTANDING";
  return "GOAL";
}

function disagreementQuestionType(reflection: UserReflection): ReflectionQuestionType | undefined {
  if (reflection.questionType) return reflection.questionType;
  // Voice/fixed-play/teammate-coordination claims are outside parsed Demo
  // facts. Route those to sync for the one bounded disagreement pass; a
  // hearing-only claim remains an information judgment instead.
  const text = reflection.rawText ?? "";
  if (/语音|叫我|报点|固定战术/.test(text)) return "TACTICAL_CONTEXT";
  if (/听到|脚步|声音|信息|看到|敌人/.test(text)) return "INFORMATION_JUDGMENT";
  return undefined;
}

function normalizedReflectionForInput(
  rawReflection: UserReflection | unknown,
  input?: ReflectionQuestionContext,
): UserReflection {
  const parsed = parseUserReflection(rawReflection, input?.cueId ?? input?.cue?.id);
  return parsed.questionType
    ? parsed
    : { ...parsed, questionType: questionTypeFor(input, parsed) };
}

/** Normalize optional user input at the trust seam. */
export function parseUserReflection(raw: unknown, cueId?: string): UserReflection {
  const value = raw && typeof raw === "object" ? { ...(raw as Record<string, unknown>), ...(cueId ? { cueId } : {}) } : raw;
  const parsed = UserReflectionSchema.parse(value);
  const text = boundedText(parsed.rawText, MAX_REFLECTION_TEXT);
  return {
    ...parsed,
    ...(text ? { rawText: text } : {}),
    reflectionId: reflectionId(parsed.cueId, parsed),
    limitations: unique(parsed.limitations),
    source: "USER",
  };
}

function claim(
  reflection: UserReflection,
  type: UserClaimType,
  content: string,
  limitations: readonly string[] = [],
  suffix = type.toLowerCase(),
): UserClaim {
  return UserClaimSchema.parse({
    claimId: `claim-${stableToken(`${reflection.cueId}|${reflectionId(reflection.cueId, reflection)}|${type}|${content}`)}-${suffix}`.slice(0, 160),
    cueId: reflection.cueId,
    originReflectionId: reflectionId(reflection.cueId, reflection),
    type,
    content: boundedText(content),
    source: "USER",
    verification: "UNTESTED",
    supportingRefs: [],
    contradictingRefs: [],
    limitations: unique(limitations),
  });
}

function inferGoalFromText(rawText: string | undefined): ReflectionGoal | undefined {
  const text = boundedText(rawText).toLowerCase();
  if (!text) return undefined;
  if (/补枪|帮队友|跟枪|trade/.test(text)) return "TRADE";
  if (/拿信息|探信息|找信息|摸信息|获取信息|get\s*info/.test(text)) return "GET_INFO";
  if (/抢空间|拿空间|首杀|前压|take\s*space/.test(text)) return "TAKE_SPACE";
  if (/拖时间|拖延|耗时间|delay/.test(text)) return "DELAY";
  if (/转点|转到|rotate/.test(text)) return "ROTATE";
  if (/保枪|保经济|save/.test(text)) return "SAVE";
  if (/执行战术|执行计划|按战术|execute/.test(text)) return "EXECUTE_PLAN";
  if (/纯执行|压枪|瞄准|手滑|操作失误|mechanical/.test(text)) return "MECHANICAL_ATTEMPT";
  return undefined;
}

/** Turn a short reflection into bounded, separately typed user assertions. */
export function buildUserClaims(rawReflection: UserReflection | unknown, input?: Partial<TeachingDiagnosisInput>): UserClaim[] {
  const reflection = normalizedReflectionForInput(rawReflection, input);
  const claims: UserClaim[] = [];
  const goal = reflection.selectedGoal ?? inferGoalFromText(reflection.rawText) ?? "UNKNOWN";
  const goalLabels: Record<ReflectionGoal, string> = {
    GET_INFO: "拿信息", TAKE_SPACE: "抢空间或首杀", TRADE: "给队友补枪", DELAY: "拖时间", ROTATE: "转点", SAVE: "保枪", EXECUTE_PLAN: "执行战术", MECHANICAL_ATTEMPT: "纯执行尝试", OTHER: "其他目标", UNKNOWN: "当时目标不确定",
  };
  claims.push(claim(reflection, "GOAL", `用户表示当时的目标是${goalLabels[goal]}。`, [], "goal"));
  const text = boundedText(reflection.rawText).toLowerCase();
  if (text && /队友|补枪|跟我|一起|同步/.test(text)) {
    claims.push(claim(reflection, "TEAMMATE_BELIEF", `用户补充：${boundedText(reflection.rawText)}。`, /语音|叫我|报点|战术/.test(text) ? ["Demo 无法验证队友语音、战术或是否确实同步。"] : [], "teammate"));
  }
  if (reflection.questionType === "TACTICAL_CONTEXT" || (text && /语音|叫我|报点|战术|固定/.test(text))) {
    claims.push(claim(reflection, "TACTICAL_CONTEXT", `用户补充了可能影响决策的语音或战术背景：${boundedText(reflection.rawText)}。`, ["Demo 无法直接验证语音或固定战术内容。"], "context"));
  }
  if (text && /时间|来不及|秒|倒计时|快没/.test(text)) claims.push(claim(reflection, "TIME_BELIEF", `用户认为当时存在时间压力：${boundedText(reflection.rawText)}。`, ["Demo 时间轴可以验证剩余时间，但不能验证用户主观感受。"], "time"));
  if (text && /钱|经济|没甲|头盔|道具|资源/.test(text)) claims.push(claim(reflection, "RESOURCE_BELIEF", `用户补充了资源判断：${boundedText(reflection.rawText)}。`, [], "resource"));
  if (text && /敌人|看到|听到|脚步|信息|报点/.test(text)) claims.push(claim(reflection, "ENEMY_BELIEF", `用户补充了当时对敌人或信息的判断：${boundedText(reflection.rawText)}。`, /听到|脚步/.test(text) ? ["Demo 声音发射不等于所选玩家确实听到。"] : [], "enemy"));
  if (text && /失误|压枪|瞄准|手滑|没按|执行/.test(text)) claims.push(claim(reflection, "EXECUTION_REPORT", `用户把这次处理描述为执行层尝试：${boundedText(reflection.rawText)}。`, [], "execution"));
  return claims.slice(0, 12);
}

function inputFocus(input: TeachingDiagnosisInput): string {
  return (input.focusCode ?? input.cue?.primary_focus_code ?? input.material?.contextCode ?? "").trim().toUpperCase();
}

function goalFromClaims(claims: readonly UserClaim[]): ReflectionGoal {
  const goal = claims.find((item) => item.type === "GOAL")?.content ?? "";
  if (/补枪/.test(goal)) return "TRADE";
  if (/信息/.test(goal)) return "GET_INFO";
  if (/抢空间/.test(goal)) return "TAKE_SPACE";
  if (/拖时间/.test(goal)) return "DELAY";
  if (/转点/.test(goal)) return "ROTATE";
  if (/保枪/.test(goal)) return "SAVE";
  if (/战术/.test(goal)) return "EXECUTE_PLAN";
  if (/执行/.test(goal)) return "MECHANICAL_ATTEMPT";
  return "UNKNOWN";
}

/** Selects a single condition whose truth would change the evaluation. */
export function selectHingeCondition(input: TeachingDiagnosisInput, claims: readonly UserClaim[]): HingeCondition {
  const goal = goalFromClaims(claims);
  const focus = inputFocus(input);
  let kind: HingeCondition["kind"] = "RISK";
  let conditionCode = "RISK_BUDGET";
  let statement = "在这次接触前，你是否有足够资源承受首个风险，并保留撤退或二次处理空间？";
  const hasClaim = (type: UserClaimType) => claims.some((claim) => claim.type === type);
  if (claims.some((claim) => claim.type === "TACTICAL_CONTEXT")) {
    kind = "SYNC";
    conditionCode = "TEAM_SYNC";
    statement = "用户补充的队友预期或战术/听觉信息是否成立，并且能在这次接触中改变可执行选项？";
  } else if (goal === "TRADE" || /TRADE|补枪|同步/.test(`${focus} ${claims.map((claim) => claim.content).join(" ")}`)) {
    kind = "TRADE";
    conditionCode = "TRADE_WINDOW";
    statement = "队友是否能在相近的接触窗口看到同一目标并及时响应？";
  } else if (goal === "GET_INFO" || /INFO|INFORMATION/.test(focus) || (hasClaim("ENEMY_BELIEF") && !hasClaim("TIME_BELIEF"))) {
    kind = "INFORMATION";
    conditionCode = "INFORMATION_BASIS";
    statement = "你当时是否有足够的已验证信息支持这次探信息动作？";
  } else if (goal === "DELAY" || /TIMING|DELAY/.test(focus) || hasClaim("TIME_BELIEF")) {
    kind = "TIMING";
    conditionCode = "TIMING_WINDOW";
    statement = "这次处理是否发生在仍能安全拖延、而不会丢失撤退窗口的时机？";
  } else if (hasClaim("RESOURCE_BELIEF")) {
    kind = "RISK";
    conditionCode = "RISK_BUDGET";
    statement = "你对血量、护甲、经济或道具资源的判断是否足以承受这次风险？";
  } else if (claims.some((claim) => claim.type === "TEAMMATE_BELIEF" || claim.type === "TACTICAL_CONTEXT")) {
    kind = "SYNC";
    conditionCode = "TEAM_SYNC";
    statement = "用户补充的队友预期是否成立，并且能在这次接触中改变可执行选项？";
  }
  const evidenceRefs = unique([
    ...input.decisionFacts.filter((fact) => fact.availability === "DECISION" && fact.available_at_tick >= 0).map((fact) => fact.id),
    ...input.playerActionFacts.map((fact) => fact.id),
  ]).slice(0, 32);
  return HingeSchema.parse({
    hingeId: `hinge-${input.cueId}-${conditionCode.toLowerCase()}`.slice(0, 160),
    cueId: input.cueId,
    kind,
    conditionCode,
    statement,
    claimRefs: claims.map((claim) => claim.claimId).slice(0, 16),
    evidenceRefs,
    verification: "UNTESTED",
    confidence: 0.82,
    limitations: kind === "TRADE" ? ["当前分析包没有逐玩家视线、阻挡和精确接触标记。"] : [],
  });
}

function capability(
  input: TeachingDiagnosisInput,
  hinge: HingeCondition,
  kind: DiagnosticCapabilityKind,
  claimTypes: readonly UserClaimType[],
  limitations: readonly string[] = [],
): DiagnosticCapability {
  const refs = unique([
    ...hinge.evidenceRefs,
    ...input.decisionFacts.map((fact) => fact.id),
    ...input.playerActionFacts.map((fact) => fact.id),
    ...input.outcomeFacts.map((fact) => fact.id),
  ]).slice(0, 64);
  const visualHint = kind === "VERIFY_RISK_BUDGET" ? "RESOURCE_CHIPS" : kind === "VERIFY_TRADE_ASSUMPTION" ? "MAP_RELATION" : "TEXT_ONLY";
  return CapabilitySchema.parse({
    id: kind,
    capabilityId: kind,
    kind,
    cueId: input.cueId,
    hingeId: hinge.hingeId,
    claimTypes: [...claimTypes],
    boundEvidenceRefs: refs,
    presentationRecipe: {
      recipeId: `recipe-${kind.toLowerCase()}`,
      title: kind === "VERIFY_RISK_BUDGET" ? "检查资源与可承受风险" : kind === "VERIFY_TRADE_ASSUMPTION" ? "检查补枪接触窗口" : "检查决策条件",
      sections: ["CLAIM", "HINGE", "EVIDENCE", "VERDICT", "TRANSFER"],
      visualHint,
    },
    limitations: unique(limitations),
  });
}

/** Build only pre-bound diagnostic capabilities; no ticks, coordinates or commands are accepted. */
export function buildDiagnosticCapabilities(input: TeachingDiagnosisInput, hinge: HingeCondition, claims: readonly UserClaim[]): DiagnosticCapability[] {
  const goal = goalFromClaims(claims);
  const capabilities: DiagnosticCapability[] = [];
  if (hinge.kind === "SYNC" || claims.some((claim) => claim.type === "TACTICAL_CONTEXT")) {
    capabilities.push(capability(input, hinge, "VERIFY_SYNC_ASSUMPTION", ["GOAL", "TEAMMATE_BELIEF", "TACTICAL_CONTEXT", "ENEMY_BELIEF"], ["Demo 无法验证用户补充的语音、固定战术或听觉信息。"]));
  } else if (goal === "TRADE" || hinge.kind === "TRADE") {
    capabilities.push(capability(input, hinge, "VERIFY_TRADE_ASSUMPTION", ["GOAL", "TEAMMATE_BELIEF", "TACTICAL_CONTEXT"], ["Demo 当前不能可靠验证同一目标视线、阻挡或语音同步。"]));
  } else if (hinge.kind === "INFORMATION") {
    capabilities.push(capability(input, hinge, "VERIFY_INFORMATION_ASSUMPTION", ["GOAL", "ENEMY_BELIEF"], ["Demo 可以提供部分可观察事件，但不能证明玩家实际听到或理解了信息。"]));
  } else if (hinge.kind === "TIMING") {
    // There is no deterministic timing-window comparator in this slice. Keep
    // the capability legal and explicit, but do not substitute the resource
    // checker for a different hinge.
    capabilities.push(capability(input, hinge, "VERIFY_EXPOSURE_ASSUMPTION", ["GOAL", "TIME_BELIEF"], ["当前版本没有可验证的时机窗口比较器；不能用资源状态代替时机证据。"]));
  }
  if (input.decisionState || input.decisionResources || input.economyClass || input.material?.economy) {
    capabilities.push(capability(input, hinge, "VERIFY_RISK_BUDGET", ["GOAL", "RESOURCE_BELIEF", "EXECUTION_REPORT"]));
  }
  if (capabilities.length === 0) {
    capabilities.push(capability(input, hinge, "VERIFY_RISK_BUDGET", ["GOAL"], ["决策帧没有足够资源字段，结果可能不可验证。"]));
  }
  return capabilities.slice(0, 4);
}

function factRefs(input: TeachingDiagnosisInput): string[] {
  return unique([
    ...input.decisionFacts.filter((fact) => fact.availability === "DECISION" && fact.observed_by_player).map((fact) => fact.id),
    ...input.playerActionFacts.map((fact) => fact.id),
    ...input.outcomeFacts.map((fact) => fact.id),
  ]).slice(0, 64);
}

function outcomeIsNegative(outcomes: readonly OutcomeFact[]): boolean {
  return outcomes.some((fact) =>
    fact.outcomeKind === "DEATH" ||
    (fact.outcomeKind === "HP_CHANGE" && /掉血|受伤|伤害|损失|health\s*(?:drop|loss|damage)/i.test(fact.text)) ||
    /被击杀|阵亡|死亡|掉血|受伤|受到伤害/.test(fact.text),
  );
}

function economyFrom(input: TeachingDiagnosisInput): TeachingDiagnosisInput["economyClass"] {
  return input.economyClass ?? input.material?.economy ?? "UNKNOWN";
}

function resourceSnapshot(input: TeachingDiagnosisInput): DecisionResources | undefined {
  if (input.decisionState) {
    const state = input.decisionState;
    return {
      health: state.health,
      armor: state.armor,
      hasHelmet: state.has_helmet,
      ...(state.money !== undefined ? { money: state.money } : {}),
      ...(state.equipment_value !== undefined ? { equipmentValue: state.equipment_value } : {}),
      inventoryCount: state.inventory.reduce((sum, item) => sum + Math.max(0, item.count), 0),
      evidenceRefs: unique([...(state.fact_refs ?? []), ...factRefs(input)]).slice(0, 32),
    };
  }
  return input.decisionResources;
}

function resourceMeasurements(input: TeachingDiagnosisInput, snapshot = resourceSnapshot(input)): DiagnosticMeasurement[] {
  if (!snapshot) return [];
  const refs = unique([...snapshot.evidenceRefs, ...factRefs(input)]).slice(0, 8);
  const measurements: DiagnosticMeasurement[] = [
    { id: `measurement-${input.cueId}-health`, label: "决策时血量", value: snapshot.health, unit: "HP", evidenceRefs: refs },
    { id: `measurement-${input.cueId}-armor`, label: "决策时护甲", value: snapshot.armor, unit: "甲", evidenceRefs: refs },
  ];
  if (snapshot.money !== undefined) measurements.push({ id: `measurement-${input.cueId}-money`, label: "决策时存款", value: snapshot.money, unit: "$", evidenceRefs: refs });
  if (snapshot.equipmentValue !== undefined) measurements.push({ id: `measurement-${input.cueId}-equipment`, label: "决策时装备价值", value: snapshot.equipmentValue, unit: "$", evidenceRefs: refs });
  if (snapshot.inventoryCount !== undefined) measurements.push({ id: `measurement-${input.cueId}-utility`, label: "决策时道具数量", value: snapshot.inventoryCount, unit: "颗", evidenceRefs: refs });
  return measurements;
}

function explicitInformationContradiction(input: TeachingDiagnosisInput): string[] {
  return input.decisionFacts
    .filter((fact) => fact.availability === "DECISION" && fact.observed_by_player)
    .filter((fact) => {
      const text = fact.text.replace(/\s+/g, "");
      return /(?:信息|报点|情报).*(?:错误|不成立|不准确|不对)|(?:敌人|目标).*(?:不在|不存在|并不存在)|(?:没有|未|没(?:有)?)(?:发现|看到)(?:敌人|目标)/.test(text);
    })
    .map((fact) => fact.id);
}

/** Deterministic evidence executor. It only consumes fields already present in the input. */
export function executeDiagnostic(
  capability: DiagnosticCapability,
  input: TeachingDiagnosisInput,
  hinge: HingeCondition,
  _claims: readonly UserClaim[] = [],
): DiagnosticResult {
  const refs = unique([...capability.boundEvidenceRefs, ...factRefs(input)]).slice(0, 64);
  const commonLimitations = unique([
    ...(input.limitations ?? []),
    ...(input.material?.limitations ?? []),
    ...capability.limitations,
  ]).slice(0, MAX_DIAGNOSIS_LIMITATIONS);
  if (capability.kind === "VERIFY_SYNC_ASSUMPTION") {
    return DiagnosticResultSchema.parse({
      resultId: `diagnostic-${input.cueId}-${capability.kind.toLowerCase()}`,
      capabilityId: capability.id,
      cueId: input.cueId,
      hingeId: hinge.hingeId,
      status: "UNVERIFIABLE",
      evidenceRefs: refs,
      measurements: [],
      explanation: "你补充的队友语音、固定战术或听到的脚步等信息可能改变判断；但 Demo 无法验证这条信息。若它成立，这次行为可以被合理解释为团队同步条件下的选择；在验证前不能把它当作 Demo 事实。",
      limitations: unique([...commonLimitations, "Demo 无法验证用户补充的语音、固定战术或听觉信息。", "若该信息成立，当前行为需要按团队同步条件重新解释。"]),
    });
  }
  if (capability.kind === "VERIFY_INFORMATION_ASSUMPTION") {
    const contradictionRefs = explicitInformationContradiction(input);
    if (contradictionRefs.length > 0) {
      return DiagnosticResultSchema.parse({
        resultId: `diagnostic-${input.cueId}-${capability.kind.toLowerCase()}`,
        capabilityId: capability.id,
        cueId: input.cueId,
        hingeId: hinge.hingeId,
        status: "CONTRADICTED",
        evidenceRefs: unique([...contradictionRefs, ...refs]).slice(0, 64),
        measurements: [],
        explanation: "Demo 的决策事实明确否定了这条敌人/信息假设；这不是把用户描述升级成事实，而是用可观察 Demo 事实标记该主张不成立。",
        limitations: unique([...commonLimitations, "仅对 Demo 明确记录的矛盾信息作出判断；玩家是否实际听到或理解信息仍无法验证。"]),
      });
    }
    return DiagnosticResultSchema.parse({
      resultId: `diagnostic-${input.cueId}-${capability.kind.toLowerCase()}`,
      capabilityId: capability.id,
      cueId: input.cueId,
      hingeId: hinge.hingeId,
      status: "UNVERIFIABLE",
      evidenceRefs: refs,
      measurements: [],
      explanation: "你补充的听觉或脚步信息可能改变判断；但 Demo 无法验证你当时是否实际听到、理解并据此行动。若这条信息成立，这次行为可以被合理解释为基于信息判断的选择；在验证前不能把它当作 Demo 事实。",
      limitations: unique([...commonLimitations, "Demo 无法验证玩家实际听到或理解的声音信息。", "若该信息成立，当前行为需要按信息判断条件重新解释。"]),
    });
  }
  if (capability.kind === "VERIFY_EXPOSURE_ASSUMPTION") {
    return DiagnosticResultSchema.parse({
      resultId: `diagnostic-${input.cueId}-${capability.kind.toLowerCase()}`,
      capabilityId: capability.id,
      cueId: input.cueId,
      hingeId: hinge.hingeId,
      status: "UNVERIFIABLE",
      evidenceRefs: refs,
      measurements: [],
      explanation: "这次判断的关键是时机和暴露窗口；当前 Demo 分析没有可靠的时机比较器，不能用资源状态或结果倒推时机是否正确。",
      limitations: unique([...commonLimitations, "缺少可验证的时机窗口、剩余时间与替代选项比较数据。"]),
    });
  }
  if (capability.kind === "VERIFY_TRADE_ASSUMPTION") {
    const explicitCoverageGap = [...input.decisionFacts.filter((fact) => fact.availability === "DECISION"), ...input.playerActionFacts]
      .filter((fact) => /队友(?:尚未|未|没(?:有)?|无法|不能|不在)|(?:无法|不能|未能|没(?:有)?)覆盖|(?:无法|不能|未能|没(?:有)?)同步|(?:不在|未在|没有在)同一(?:条)?枪线|(?:teammate|ally).*(?:not|cannot|can't|unable).*(?:position|cover|sync|trade|angle|line of sight)/i.test(fact.text.replace(/\s+/g, "")))
      .map((fact) => fact.id);
    const partiallySupported = explicitCoverageGap.length > 0;
    return DiagnosticResultSchema.parse({
      resultId: `diagnostic-${input.cueId}-${capability.kind.toLowerCase()}`,
      capabilityId: capability.id,
      cueId: input.cueId,
      hingeId: hinge.hingeId,
      status: partiallySupported ? "PARTIALLY_SUPPORTED" : "UNVERIFIABLE",
      evidenceRefs: refs,
      measurements: [],
      explanation: partiallySupported
        ? "Demo 的 DECISION/action 事实明确记录了队友未到位或无法形成覆盖；空间/时机部分可由 Demo 支持，但逐玩家 LOS、阻挡、语音仍未知。仍不能仅据此确认完整补枪。"
        : "你表示目标是补枪；当前 Demo 证据没有逐玩家同目标视线、阻挡或语音同步数据，不能把空间接近直接判成可补枪。",
      limitations: unique([...commonLimitations, "缺少队友视线、阻挡、精确接触时间和语音数据。"]),
    });
  }
  if (capability.kind !== "VERIFY_RISK_BUDGET") {
    return DiagnosticResultSchema.parse({
      resultId: `diagnostic-${input.cueId}-${capability.kind.toLowerCase()}`,
      capabilityId: capability.id,
      cueId: input.cueId,
      hingeId: hinge.hingeId,
      status: "UNVERIFIABLE",
      evidenceRefs: refs,
      measurements: [],
      explanation: "当前版本没有足够的确定性字段验证这个条件。",
      limitations: unique([...commonLimitations, "该诊断能力尚未接入可验证数据。"]),
    });
  }
  const resources = resourceSnapshot(input);
  const economy = economyFrom(input);
  if (!resources && economy === "UNKNOWN") {
    return DiagnosticResultSchema.parse({
      resultId: `diagnostic-${input.cueId}-risk-budget`,
      capabilityId: capability.id,
      cueId: input.cueId,
      hingeId: hinge.hingeId,
      status: "UNVERIFIABLE",
      evidenceRefs: refs,
      measurements: [],
      explanation: "决策帧没有可用的资源字段，暂时不能判断这次风险预算。",
      limitations: unique([...commonLimitations, "缺少血量、护甲、经济或装备字段。"]),
    });
  }
  const constrained = economy === "ECO" || economy === "FORCE" || Boolean(resources && (resources.health <= 45 || resources.armor <= 0 || !resources.hasHelmet));
  const negative = outcomeIsNegative(input.outcomeFacts);
  const status: ClaimVerificationStatus = constrained && negative ? "CONTRADICTED" : constrained ? "PARTIALLY_SUPPORTED" : "SUPPORTED";
  const resourceText = resources
    ? `${resources.health} HP、${resources.armor <= 0 ? "无护甲" : resources.hasHelmet ? `${resources.armor} 甲且有头盔` : `${resources.armor} 甲但没头盔`}`
    : `${economy} 经济语境`;
  const explanation = constrained
    ? `证据显示，决策时资源处于${resourceText}的受限状态；${negative ? "随后发生了负向接触结果。" : "但结果窗口本身不足以证明动作一定错误。"}`
    : `证据显示，决策时资源并未落入低预算门槛（${resourceText}）；这项风险条件基本成立。`;
  return DiagnosticResultSchema.parse({
    resultId: `diagnostic-${input.cueId}-risk-budget`,
    capabilityId: capability.id,
    cueId: input.cueId,
    hingeId: hinge.hingeId,
    status,
    evidenceRefs: refs,
    measurements: resourceMeasurements(input),
    explanation,
    limitations: unique([...commonLimitations, "资源状态能说明风险背景，但不能单独证明某个动作造成结果。"]),
  });
}

function explicitIrreversibleAction(input: TeachingDiagnosisInput): boolean {
  return input.playerActionFacts.some((fact) => {
    const text = fact.text.replace(/\s+/g, "");
    return /不可回撤|强行(?:接触|开火|对枪)|主动(?:拉|开火|接触)|拉出掩体|前压|继续(?:接了|留在).*(?:枪线|对枪)/.test(text);
  });
}

function updateClaimVerification(claims: readonly UserClaim[], result: DiagnosticResult): UserClaim[] {
  const evidenceRefs = unique(result.evidenceRefs).slice(0, 32);
  const relevantTypes = new Set<UserClaimType>(
    result.capabilityId === "VERIFY_TRADE_ASSUMPTION" || result.capabilityId === "VERIFY_SYNC_ASSUMPTION"
      ? ["TEAMMATE_BELIEF", "TACTICAL_CONTEXT"]
      : result.capabilityId === "VERIFY_INFORMATION_ASSUMPTION" || result.capabilityId === "VERIFY_EXPOSURE_ASSUMPTION"
        ? ["ENEMY_BELIEF", "TIME_BELIEF"]
        : result.capabilityId === "VERIFY_RISK_BUDGET"
          ? ["RESOURCE_BELIEF"]
          : result.capabilityId === "COMPARE_TWO_OPTIONS"
            ? ["GOAL", "TIME_BELIEF", "RESOURCE_BELIEF"]
            : [],
  );
  return claims.map((item) => {
    if (item.type === "GOAL") return { ...item, source: "USER", verification: "SUPPORTED" };
    if (!relevantTypes.has(item.type)) return { ...item, source: "USER" };
    const supporting = result.status === "SUPPORTED" || result.status === "PARTIALLY_SUPPORTED";
    const contradicting = result.status === "CONTRADICTED";
    return {
      ...item,
      source: "USER",
      verification: result.status,
      supportingRefs: supporting ? unique([...item.supportingRefs, ...evidenceRefs]).slice(0, 32) : item.supportingRefs,
      contradictingRefs: contradicting ? unique([...item.contradictingRefs, ...evidenceRefs]).slice(0, 32) : item.contradictingRefs,
      limitations: unique([...item.limitations, "用户补充信息仍属于 USER claim，Demo 未将其升级为事实。"]),
    };
  });
}

/** Convert evidence status into one explicit teaching verdict. */
export function synthesizeCoachVerdict(
  input: TeachingDiagnosisInput,
  claims: readonly UserClaim[],
  hinge: HingeCondition,
  result: DiagnosticResult,
  revision = 0,
): CoachVerdict {
  const goal = goalFromClaims(claims);
  let type: CoachVerdict["type"] = "INCONCLUSIVE";
  const beliefIncorrect = hinge.kind === "INFORMATION" &&
    result.status === "CONTRADICTED" &&
    claims.some((claim) => claim.type === "ENEMY_BELIEF");
  const actionGoalMismatch = ["SAVE", "DELAY", "GET_INFO"].includes(goal) &&
    result.status === "CONTRADICTED" &&
    explicitIrreversibleAction(input);
  if (beliefIncorrect) type = "BELIEF_INCORRECT";
  else if (actionGoalMismatch) type = "ACTION_GOAL_MISMATCH";
  else if (result.status === "CONTRADICTED") type = goal === "MECHANICAL_ATTEMPT" ? "EXECUTION_ONLY" : "GOAL_VALID_CONDITION_FAILED";
  else if (result.status === "SUPPORTED") type = outcomeIsNegative(input.outcomeFacts) ? "EXECUTION_ONLY" : "GOAL_AND_ACTION_ALIGNED";
  else if (result.status === "PARTIALLY_SUPPORTED") type = "GOAL_VALID_CONDITION_FAILED";
  if (hinge.kind === "SYNC" && result.status === "UNVERIFIABLE") type = "TEAM_EXECUTION";
  const confidenceBase = result.status === "SUPPORTED" ? 0.84 : result.status === "CONTRADICTED" ? 0.82 : result.status === "PARTIALLY_SUPPORTED" ? 0.62 : 0.38;
  const confidence = Math.max(0.15, Math.min(0.95, confidenceBase - (revision > 0 ? 0.14 : 0)));
  const limitations = unique([
    ...result.limitations,
    ...(revision > 0 ? ["用户提出了异议；新增信息未必能由 Demo 验证，因此已降低置信度。"] : []),
  ]).slice(0, MAX_DIAGNOSIS_LIMITATIONS);
  const syncUnverifiable = hinge.kind === "SYNC" && result.status === "UNVERIFIABLE";
  const informationUnverifiable = hinge.kind === "INFORMATION" && result.status === "UNVERIFIABLE";
  const explanation = syncUnverifiable
    ? "你补充的信息可能改变判断；Demo 无法验证这条语音、固定战术或听觉信息。若它成立，这次行为可以被合理解释为团队同步/执行条件问题，而不是直接归因于个人决策错误。"
    : informationUnverifiable
      ? "你补充的信息可能改变判断；Demo 无法验证你是否实际听到或理解了这条声音信息。若它成立，这次行为可以被合理解释为基于信息判断的选择，但当前不能把它当作 Demo 事实。"
    : type === "GOAL_AND_ACTION_ALIGNED"
    ? "目标与这次行动方向一致；如果结果不理想，目前更像执行层问题。"
    : type === "GOAL_VALID_CONDITION_FAILED"
      ? "目标本身可以成立，但决定它是否可行的关键条件没有成立。"
    : type === "EXECUTION_ONLY"
        ? "决策条件基本成立，当前证据更支持把问题归为执行，而不是意识判断。"
        : type === "BELIEF_INCORRECT"
          ? "Demo 的可观察事实明确否定了你当时的敌人/信息判断；这是信息模型问题，不把你的语音感受当作 Demo 事实。"
          : type === "ACTION_GOAL_MISMATCH"
            ? "你描述的目标需要保留空间或信息，但 Demo 记录的是不可回撤的主动接触；这次行动没有服务于你说的目标。"
        : type === "TEAM_EXECUTION"
          ? "这更像团队同步或执行条件问题；Demo 无法把用户补充的队友信息当作事实。"
          : "当前证据不足以确定这是决策错误、执行问题还是团队同步问题。";
  return VerdictSchema.parse({
    type,
    confidence,
    hingeId: hinge.hingeId,
    diagnosticResultId: result.resultId,
    claimIds: claims.map((claim) => claim.claimId).slice(0, 32),
    evidenceRefs: unique([...result.evidenceRefs, ...hinge.evidenceRefs]).slice(0, 64),
    limitations,
    revision,
    explanation,
  });
}

export function createTransferRule(input: TeachingDiagnosisInput, hinge: HingeCondition, result: DiagnosticResult, verdict: CoachVerdict): TransferRule {
  const refs = unique([...result.evidenceRefs, ...hinge.evidenceRefs]).slice(0, 64);
  const isTrade = hinge.kind === "TRADE";
  const isSync = hinge.kind === "SYNC";
  const isInformation = hinge.kind === "INFORMATION";
  const isTiming = hinge.kind === "TIMING";
  const when = isSync
    ? "准备依据队友语音、固定战术或听到的声音进入接触前"
    : isInformation ? "准备依据听到、看到或报点的信息进入接触前"
      : isTiming ? "准备继续拖延、等待信息或等待队友动作前"
        : isTrade ? "准备和队友一起进入同一条枪线前" : "准备在资源受限或未知枪线中主动接触前";
  const doText = isSync
    ? "先把这条补充信息保留为 USER claim；若它成立，再确认队友的可执行位置和接触窗口，否则保留退路。"
    : isInformation
      ? "先把这条听觉或信息判断保留为 USER claim；若它成立，再确认信息是否足以支持前压，否则保留验证和撤退空间。"
    : isTiming
      ? "先确认剩余时间、撤退窗口和等待的替代方案；当前没有可靠时机比较证据时，不把结果倒推成时机判断。"
    : isTrade
      ? "先确认队友能在相近接触窗口看到同一目标；只靠空间距离不够。"
    : result.status === "CONTRADICTED"
      ? "低血量、没头甲或 ECO/强起时，先让高资源队友接首枪，自己留第二身位和撤退路线。"
      : "先扫一眼自己的血量、护甲和经济，再决定是否把这次接触升级成不可回撤的动作。";
  return TransferRuleSchema.parse({
    ruleId: `rule-${input.cueId}-${hinge.conditionCode.toLowerCase()}`.slice(0, 160),
    when,
    do: doText,
    ...(result.status === "UNVERIFIABLE"
      ? { unless: isSync ? "Demo 无法验证这条语音、战术或听觉信息；若它成立，你的行为可以被合理解释，但当前结论保持条件化。" : isInformation ? "Demo 无法验证你是否实际听到或理解这条声音信息；若它成立，你的行为可以被合理解释，但当前结论保持条件化。" : isTiming ? "Demo 无法可靠比较这次时机与替代选项；当前结论保持条件化。" : "如果存在 Demo 无法验证的语音或固定战术，先把它当作额外条件，而不是默认事实。" }
      : {}),
    refs,
    confidence: Math.max(0.2, Math.min(0.9, verdict.confidence)),
    limitations: unique([...result.limitations, ...(verdict.type === "INCONCLUSIVE" ? ["这条规则是条件化建议，不代表已确定归因。"] : [])]).slice(0, MAX_DIAGNOSIS_LIMITATIONS),
  });
}

function threadType(hinge: HingeCondition, verdict: CoachVerdict): LearningThread["diagnosis"]["type"] {
  if (verdict.type === "EXECUTION_ONLY") return "EXECUTION";
  if (hinge.kind === "TRADE" || hinge.kind === "SYNC") return "TEAM_MODEL";
  if (hinge.kind === "INFORMATION") return "INFORMATION_MODEL";
  if (hinge.kind === "TIMING") return "TIMING";
  if (verdict.type === "INCONCLUSIVE") return "UNVERIFIABLE";
  return "RISK_MODEL";
}

export function updateLearningThread(
  existing: readonly LearningThread[] = [],
  input: TeachingDiagnosisInput,
  hinge: HingeCondition,
  verdict: CoachVerdict,
  transferRule: TransferRule,
  claims: readonly UserClaim[] = [],
): LearningThread {
  const prior = existing.find((thread) => thread.scope === "SESSION" && thread.hingeCode === hinge.conditionCode);
  const evidenceCueIds = unique([...(prior?.evidenceCueIds ?? []), input.cueId]).slice(-64);
  const successfulCueIds = verdict.type === "GOAL_AND_ACTION_ALIGNED" || verdict.type === "EXECUTION_ONLY"
    ? unique([...(prior?.successfulCueIds ?? []), input.cueId]).slice(-64)
    : [...(prior?.successfulCueIds ?? [])].slice(-64);
  const conflictingCueIds = verdict.type === "GOAL_VALID_CONDITION_FAILED" || verdict.type === "INCONCLUSIVE"
    ? unique([...(prior?.conflictingCueIds ?? []), input.cueId]).slice(-64)
    : [...(prior?.conflictingCueIds ?? [])].slice(-64);
  const occurrence = evidenceCueIds.length;
  const status: LearningThread["status"] = occurrence > 1 ? "REPEATED" : verdict.type === "INCONCLUSIVE" ? "OPEN" : "TAUGHT";
  const goalClaim = input.reflection.selectedGoal ?? inferGoalFromText(input.reflection.rawText) ?? "UNKNOWN";
  const teammateClaim = claims.find((item) => item.type === "TEAMMATE_BELIEF");
  return ThreadSchema.parse({
    threadId: prior?.threadId ?? `thread-${hinge.conditionCode.toLowerCase()}-${stableToken(input.cueId)}`.slice(0, 160),
    scope: "SESSION",
    hingeCode: hinge.conditionCode,
    trigger: { situation: hinge.statement, conditions: [hinge.conditionCode] },
    userModel: {
      goal: goalClaim,
      ...(input.reflection.rawText ? { belief: boundedText(input.reflection.rawText, 240) } : {}),
      ...(teammateClaim ? { expectedTeammateAction: boundedText(input.reflection.rawText ?? teammateClaim.content, 240) } : {}),
    },
    diagnosis: { type: threadType(hinge, verdict), summary: verdict.explanation, confidence: verdict.confidence },
    transferRule,
    evidenceCueIds,
    successfulCueIds,
    conflictingCueIds,
    status,
  });
}

function normalizedInput(input: TeachingDiagnosisInput): TeachingDiagnosisInput {
  const parsed = TeachingDiagnosisInputSchema.parse(input);
  const normalizedReflection = normalizedReflectionForInput(parsed.reflection, parsed);
  return {
    ...parsed,
    reflection: normalizedReflection,
    existingThreads: parsed.existingThreads ?? [],
    limitations: unique(parsed.limitations ?? []),
  } as TeachingDiagnosisInput;
}

/** Full single-cue deterministic teaching chain. */
export function diagnoseCue(rawInput: TeachingDiagnosisInput): TeachingDiagnosisOutput {
  const input = normalizedInput(rawInput);
  const reflection = normalizedReflectionForInput(input.reflection, input);
  const claims = buildUserClaims(reflection, input);
  const hinge = selectHingeCondition(input, claims);
  const capabilities = buildDiagnosticCapabilities(input, hinge, claims);
  const selected = capabilities[0];
  if (!selected) throw new Error("No legal diagnostic capability is available.");
  const result = executeDiagnostic(selected, input, hinge, claims);
  const verifiedHinge = HingeSchema.parse({ ...hinge, verification: result.status });
  const verifiedClaims = updateClaimVerification(claims, result);
  const verdict = synthesizeCoachVerdict(input, verifiedClaims, verifiedHinge, result);
  const transferRule = createTransferRule(input, verifiedHinge, result, verdict);
  const prior = (input.existingThreads ?? []).filter((thread): thread is LearningThread => Boolean(thread && typeof thread === "object" && "threadId" in thread));
  const learningThread = updateLearningThread(prior, { ...input, reflection }, verifiedHinge, verdict, transferRule, verifiedClaims);
  const priorMatch = prior.some((thread) => thread.hingeCode === verifiedHinge.conditionCode);
  const pedagogyMode: PedagogyMode = result.status === "UNVERIFIABLE" ? "DEFER" : priorMatch ? "CLARIFY" : "INTRODUCE";
  const limitations = unique([
    ...(input.limitations ?? []),
    ...reflection.limitations,
    ...result.limitations,
    ...(reflection.response === "SKIPPED" ? ["用户跳过了反思；本次不应把 Baseline 讲解升级为用户主张。"] : []),
  ]).slice(0, MAX_DIAGNOSIS_LIMITATIONS);
  const cueCase = CueCaseSchema.parse({
    schemaVersion: CUE_CASE_VERSION,
    caseId: `case-${input.cueId}-${stableToken(reflection.reflectionId ?? reflection.cueId)}`.slice(0, 160),
    cueId: input.cueId,
    ...(input.candidateId ? { candidateId: input.candidateId } : {}),
    pedagogyMode,
    status: reflection.response === "SKIPPED" ? "FALLBACK" : "AWAITING_CONFIRMATION",
    reflection,
    claims: verifiedClaims,
    hinge: verifiedHinge,
    capabilities,
    selectedCapabilityId: selected.id,
    diagnosticResult: result,
    verdict,
    transferRule,
    baselineNarrationAvailable: true,
    attemptBudget: { reflection: 1, diagnostic: 1, disagreement: 0, alternateDiagnostic: 0 },
    limitations,
  });
  return OutputSchema.parse({ cueCase, learningThread });
}

export const diagnoseTeachingCue = diagnoseCue;

export interface ReviseTeachingDiagnosisInput {
  previous: TeachingDiagnosisOutput;
  input: TeachingDiagnosisInput;
  disagreement: UserReflection;
}

/** One bounded disagreement pass; unsupported additions lower confidence. */
export function reviseDiagnosis(raw: ReviseTeachingDiagnosisInput): TeachingDiagnosisOutput {
  const previous = OutputSchema.parse(raw.previous);
  const input = normalizedInput(raw.input);
  const disagreement = parseUserReflection({
    ...raw.disagreement,
    cueId: input.cueId,
    response: "ANSWERED",
    source: "USER",
  });
  if (previous.cueCase.attemptBudget.disagreement >= 1) return previous;
  const mergedText = [input.reflection.rawText, disagreement.rawText].filter(Boolean).join("；");
  const mergedReflection = parseUserReflection({
    ...input.reflection,
    cueId: input.cueId,
    reflectionId: `${input.reflection.reflectionId ?? "reflection"}-revision`,
    rawText: mergedText || undefined,
    selectedGoal: disagreement.selectedGoal ?? input.reflection.selectedGoal,
    questionType: disagreementQuestionType(disagreement) ?? input.reflection.questionType,
    source: "USER",
    response: "ANSWERED",
    limitations: unique([...input.reflection.limitations, ...disagreement.limitations, "这是用户补充的异议信息，仍属于 USER claim。"]),
  });
  const revised = diagnoseCue({ ...input, reflection: mergedReflection, existingThreads: [raw.previous.learningThread, ...(input.existingThreads ?? [])] });
  if (!revised.cueCase.verdict) return previous;
  const loweredVerdict: CoachVerdict = {
    ...revised.cueCase.verdict,
    revision: 1,
    confidence: Math.max(0.15, revised.cueCase.verdict.confidence - 0.12),
    limitations: unique([...revised.cueCase.verdict.limitations, "用户异议后的置信度已下调。"]),
  };
  const revisedCase: CueCase = {
    ...revised.cueCase,
    caseId: previous.cueCase.caseId,
    status: "DISAGREED",
    verdict: loweredVerdict,
    attemptBudget: { ...revised.cueCase.attemptBudget, disagreement: 1, alternateDiagnostic: revised.cueCase.selectedCapabilityId === previous.cueCase.selectedCapabilityId ? 0 : 1 },
    limitations: unique([...revised.cueCase.limitations, "异议内容没有被写入 Demo 事实。"]),
  };
  // A revised hinge is still the same cue-level learning thread. Keep its
  // identity and historical evidence so the Session reducer replaces the
  // original thread instead of creating a second parallel thread. The
  // diagnosis summary/confidence must follow the lowered revised verdict.
  const mergedLearningThread = ThreadSchema.parse({
    ...revised.learningThread,
    threadId: previous.learningThread.threadId,
    diagnosis: {
      ...revised.learningThread.diagnosis,
      summary: loweredVerdict.explanation,
      confidence: loweredVerdict.confidence,
    },
    evidenceCueIds: unique([
      ...previous.learningThread.evidenceCueIds,
      ...revised.learningThread.evidenceCueIds,
    ]).slice(-64),
    successfulCueIds: unique([
      ...previous.learningThread.successfulCueIds,
      ...revised.learningThread.successfulCueIds,
    ]).slice(-64),
    conflictingCueIds: unique([
      ...previous.learningThread.conflictingCueIds,
      ...revised.learningThread.conflictingCueIds,
    ]).slice(-64),
  });
  return OutputSchema.parse({
    cueCase: revisedCase,
    learningThread: mergedLearningThread,
  });
}

export const reviseTeachingDiagnosis = reviseDiagnosis;

export function assertTeachingDiagnosisOutput(value: unknown): TeachingDiagnosisOutput {
  return OutputSchema.parse(value);
}

export { CueCaseSchema, DiagnosticResultSchema, VerdictSchema, TransferRuleSchema, HingeSchema };
export type {
  TeachingDiagnosisInput,
  TeachingDiagnosisOutput,
  UserReflection,
  UserClaim,
  CueCase,
  LearningThread,
  HingeCondition,
  DiagnosticCapability,
  DiagnosticResult,
  DecisionResources,
  CoachVerdict,
  TransferRule,
} from "@cs-coach/contracts";

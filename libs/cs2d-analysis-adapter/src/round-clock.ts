import type { DecisionSnapshot } from "@cs-coach/contracts";
import type { Cs2dFrame, Cs2dRound } from "./index";

/** Local parser evidence only; never send these network internals to a model. */
export interface Cs2dRoundClockSample {
  readonly source: "SOURCE2_GAMERULES";
  readonly sampledAtTick: number;
  readonly serverTick: number;
  readonly tickInterval: number | null;
  readonly roundDurationSeconds: number | null;
  readonly roundStartTimeSeconds: number | null;
  readonly roundsPlayed: number | null;
  readonly freeze: boolean | null;
  readonly warmup: boolean | null;
  readonly bombPlanted: boolean | null;
  readonly roundWinStatus: number | null;
  readonly paused: boolean | null;
  readonly totalPausedTicks: number | null;
  readonly pauseObserved: boolean;
  readonly clockContinuous: boolean;
}

const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);

export function readRoundClock(round: Cs2dRound, frame: Cs2dFrame | undefined, decisionTick: number, tickRate: number): DecisionSnapshot["clock"] {
  const unknown = (phase: "FREEZE" | "LIVE" | "POST_ROUND" | "UNKNOWN", reason: string, refs: string[] = []): DecisionSnapshot["clock"] => ({
    value: { phase, elapsedSeconds: null, remainingSeconds: null }, boundary: "OBSERVABLE", evidenceRefs: refs, limitations: [reason],
  });
  const sample = frame?.clock;
  if (!sample || sample.source !== "SOURCE2_GAMERULES" || !Number.isSafeInteger(sample.sampledAtTick) ||
    sample.sampledAtTick !== frame?.tick || sample.sampledAtTick > decisionTick || sample.sampledAtTick < round.freezeStartTick ||
    !finite(tickRate) || tickRate <= 0 || decisionTick - sample.sampledAtTick > Math.ceil(tickRate / 2) ||
    sample.roundsPlayed !== round.number - 1) return unknown("UNKNOWN", "缺少与当前回合匹配且足够新的公开时钟采样，不能用最终回合长度反推。");
  const refs = [`cs2d-r${round.number}-clock-${sample.sampledAtTick}`];
  if (sample.warmup !== false) return unknown("UNKNOWN", "热身或比赛阶段尚未确认。", refs);
  if (sample.freeze === true) return unknown("FREEZE", "冻结阶段不使用正常回合倒计时。", refs);
  if (finite(sample.roundWinStatus) && sample.roundWinStatus > 0) return unknown("POST_ROUND", "回合已经结束，普通回合倒计时不再适用。", refs);
  if (sample.freeze !== false || sample.roundWinStatus !== 0) return unknown("UNKNOWN", "尚不能确认当前为正常回合阶段。", refs);
  if (sample.bombPlanted !== false || (round.events ?? []).some(event => event.type.startsWith("bomb_") && event.tick >= round.freezeStartTick && event.tick <= decisionTick)) {
    return unknown("LIVE", "植包后不沿用普通回合倒计时；本轮不推算C4剩余时间。", refs);
  }
  if (sample.paused !== false || sample.pauseObserved !== false || sample.totalPausedTicks !== 0 || sample.clockContinuous !== true) {
    return unknown("LIVE", "暂停或服务器时钟连续性未经确认，不猜测暂停补偿。", refs);
  }
  if (!Number.isSafeInteger(sample.serverTick) || sample.serverTick < 0 || sample.serverTick >= 0xffff_ffff ||
    !finite(sample.tickInterval) || sample.tickInterval <= 0 || sample.tickInterval > 1 ||
    !Number.isSafeInteger(sample.roundDurationSeconds) || !finite(sample.roundDurationSeconds) || sample.roundDurationSeconds <= 0 ||
    !finite(sample.roundStartTimeSeconds) || sample.roundStartTimeSeconds < 0) return unknown("LIVE", "公开时钟字段缺失或时间域无效。", refs);
  const elapsed = sample.serverTick * sample.tickInterval - sample.roundStartTimeSeconds;
  const remaining = sample.roundDurationSeconds - elapsed;
  if (!finite(elapsed) || elapsed < 0 || remaining <= 0 || remaining > sample.roundDurationSeconds) return unknown("LIVE", "时钟起点或剩余时间不一致，不能当作零秒。", refs);
  return { value: { phase: "LIVE", elapsedSeconds: elapsed, remainingSeconds: remaining }, boundary: "OBSERVABLE", evidenceRefs: refs,
    limitations: ["数值来自决策前最近一次采样，存在采样间隔误差；约秒表达不复刻HUD取整规则。"] };
}

export function publicRoundClockFact(clock: DecisionSnapshot["clock"]): string | undefined {
  const remaining = clock.value?.remainingSeconds;
  if (!finite(remaining) || remaining <= 0 || clock.value?.phase !== "LIVE" || clock.boundary !== "OBSERVABLE") return undefined;
  return `决策前最近采样的回合剩余时间${remaining < 1 ? "不足1秒" : `约${Math.ceil(remaining)}秒`}。`;
}

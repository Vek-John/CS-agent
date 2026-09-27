/** A retained own-pawn sample, not movement speed, airborne state or shot-time evidence. */
export interface GroundSampleEvidence {
  version: 1;
  source: "SOURCE2_PAWN_FLAGS";
  phase: "TICK_START";
  sampledAtTick: number;
  playerId: string;
  value: "FLAG_SET" | "FLAG_UNSET" | null;
}

export function isGroundSampleEvidence(value: unknown): value is GroundSampleEvidence {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>;
  return Object.keys(v).sort().join(",") === "phase,playerId,sampledAtTick,source,value,version" &&
    v.version === 1 && v.source === "SOURCE2_PAWN_FLAGS" && v.phase === "TICK_START" &&
    typeof v.sampledAtTick === "number" && Number.isSafeInteger(v.sampledAtTick) && v.sampledAtTick >= 0 &&
    typeof v.playerId === "string" && v.playerId.trim().length > 0 && v.playerId.length <= 160 &&
    (v.value === null || v.value === "FLAG_SET" || v.value === "FLAG_UNSET");
}

export function groundSampleText(value: GroundSampleEvidence["value"]): string {
  const fact = value === "FLAG_SET" ? "最近采样记录到地面接触。" : value === "FLAG_UNSET" ? "最近采样未记录到地面接触。" : "最近采样无法确认地面接触状态。";
  return `${fact}这不代表开火瞬间的移动状态。`;
}

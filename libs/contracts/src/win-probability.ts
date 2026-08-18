import type { TeamSide } from "./index";

export type WinProbabilityEconomyClass = "PISTOL" | "ECO" | "FORCE" | "FULL" | "UNKNOWN";

export interface WinProbabilityModelManifest {
  provider: "CS_NET";
  revision: string;
  assetUrl: string;
  assetSha256: string;
  assetBytes: number;
  quantization: "INT8" | "FP32";
  temperature: number;
  sourceCommit: string;
  featureVersion: string;
}

export interface WinProbabilitySample {
  tick: number;
  probability: number;
  roundNumber: number;
  side: TeamSide;
  source: "CS_NET";
}

export interface WinProbabilityTerminalPoint {
  tick: number;
  probability: 0 | 1;
  winner: TeamSide;
  source: "ROUND_WINNER";
}

export interface WinProbabilityRound {
  roundNumber: number;
  startTick: number;
  endTick: number;
  winner: TeamSide | null;
  economy: {
    ct: WinProbabilityEconomyClass;
    t: WinProbabilityEconomyClass;
    ctValue: number;
    tValue: number;
  };
  samples: readonly WinProbabilitySample[];
  terminal?: WinProbabilityTerminalPoint;
}

export interface WinProbabilitySwing {
  id: string;
  tick: number;
  before: number;
  after: number;
  delta: number;
  direction: "UP" | "DOWN" | "FLAT";
  cause: "PLAYER_DEATH" | "ROUND_RESULT";
  victimSide?: TeamSide;
  selectedPlayerDeath?: boolean;
  economy?: WinProbabilityEconomyClass;
}

export interface WinProbabilityTimelineV1 {
  version: "win-probability-timeline.v1";
  status: "AVAILABLE" | "UNAVAILABLE";
  model: WinProbabilityModelManifest;
  tickRate: number;
  rounds: readonly WinProbabilityRound[];
  swings: readonly WinProbabilitySwing[];
  limitations: readonly string[];
  unavailableReason?: string;
}

export interface OutcomeImpact {
  cueId: string;
  beforeProbability: number;
  afterProbability: number;
  delta: number;
  percentagePoints: number;
  relativeChange: number | null;
  attribution: "SELECTED_PLAYER_DEATH" | "CONCURRENT_EVENTS" | "ROUND_CONTEXT" | "MODEL_SWING";
  confidence: "HIGH" | "MEDIUM" | "LOW";
  text: string;
  limitations: readonly string[];
}

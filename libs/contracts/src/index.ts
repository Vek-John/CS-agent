import type { MatchEvent, PlayerStateSample } from "./match";
import type { WorldPoint } from "./geometry";

export const REVIEW_MODES = [
  "SKIP",
  "BRIEF",
  "OBSERVE",
  "DEEP_DIVE",
  "HABIT_CHECK"
] as const;

export type ReviewMode = (typeof REVIEW_MODES)[number];
export type TeamSide = "T" | "CT";
export type EvidenceAvailability = "DECISION" | "OUTCOME";
export type EvidenceSource = "DEMO" | "RULE" | "PRO_SCENE";

export interface Point2D {
  x: number;
  y: number;
}

export interface MatchPlayer {
  player_id: string;
  display_name: string;
  side: TeamSide;
  is_selected: boolean;
}

export interface PlayerTrackSample extends Point2D {
  tick: number;
  alive: boolean;
  /**
   * @deprecated Compatibility bridge for the first synthetic vertical slice.
   * Migrate renderer and coaching code to ObservableState.claims, where the
   * source, timing, precision, sharing scope, confidence and evidence are
   * explicit. Remove this field after the fixture slice is migrated.
   */
  observed_by_selected: boolean;
}

export interface PlayerTrack {
  player_id: string;
  samples: PlayerTrackSample[];
}

export interface RoundTimeline {
  round_number: number;
  start_tick: number;
  freeze_end_tick: number;
  end_tick: number;
  score_before: readonly [number, number];
  score_after: readonly [number, number];
  winner: TeamSide;
}

export interface MatchTimeline {
  id: string;
  demo_id: string;
  source_kind: "SYNTHETIC_FIXTURE" | "PARSED_DEMO";
  map_name: "de_mirage";
  tick_rate: number;
  start_tick: number;
  end_tick: number;
  selected_player_id: string;
  players: MatchPlayer[];
  tracks: PlayerTrack[];
  /**
   * Canonical full-match facts for parsed demos. Optional only while the
   * synthetic vertical slice migrates away from its legacy tracks shape.
   */
  player_state_tracks?: readonly PlayerStateSample[];
  match_events?: readonly MatchEvent[];
  rounds: RoundTimeline[];
  timeline_version: string;
}

export interface Fact {
  id: string;
  text: string;
  availability: EvidenceAvailability;
  available_at_tick: number;
  source: "DEMO";
  observed_by_player: boolean;
}

export interface Inference {
  id: string;
  text: string;
  confidence: number;
  fact_refs: string[];
}

export interface Advice {
  id: string;
  text: string;
  trigger: string;
  fact_refs: string[];
  /** Stable deterministic rule provenance for generated advice. */
  rule_id?: string;
}

export interface Evidence {
  id: string;
  source: EvidenceSource;
  label: string;
  sample_count?: number;
  fact_refs: string[];
}

export type Annotation =
  | {
      id: string;
      type: "POINT";
      coordinate_space: "RADAR_PERCENT";
      point: Point2D;
      label: string;
    }
  | {
      id: string;
      type: "LINE";
      coordinate_space: "RADAR_PERCENT";
      from: Point2D;
      to: Point2D;
      label: string;
    }
  | {
      id: string;
      type: "AREA";
      coordinate_space: "RADAR_PERCENT";
      center: Point2D;
      radius: number;
      label: string;
    }
  | {
      id: string;
      type: "POINT";
      coordinate_space: "WORLD";
      point: WorldPoint;
      label: string;
    }
  | {
      id: string;
      type: "LINE";
      coordinate_space: "WORLD";
      from: WorldPoint;
      to: WorldPoint;
      label: string;
    }
  | {
      id: string;
      type: "AREA";
      coordinate_space: "WORLD";
      center: WorldPoint;
      /** Radius is in world units when coordinate_space is WORLD. */
      radius: number;
      label: string;
    };

export interface CoachCue {
  id: string;
  segment_id: string;
  cue_type: "DECISION" | "HABIT_RECHECK";
  title: string;
  question: string;
  decision_tick: number;
  reveal_tick: number;
  outcome_start_tick: number;
  outcome_end_tick: number;
  facts: Fact[];
  inferences: Inference[];
  advice: Advice[];
  evidence: Evidence[];
  observable_fact_refs: string[];
  /** Optional direct link to the state used to pause the evidence canvas. */
  observable_state_id?: string;
  annotations: Annotation[];
  confidence: number;
  limitations: string[];
}

export interface ReviewSegment {
  id: string;
  round_number: number;
  start_tick: number;
  end_tick: number;
  mode: ReviewMode;
  reason_code: string;
  display_reason: string;
  playback_speed: number;
  cue_ids: string[];
  expandable: boolean;
}

export interface HabitCluster {
  id: string;
  title: string;
  taxonomy_id: string;
  cue_ids: string[];
  occurrence_count: number;
  opportunity_count: number;
}

export interface GenerationManifest {
  fixture_id?: string;
  parser_version: string;
  observation_version: string;
  signal_version: string;
  planner_version: string;
  /** Explicitly records the MVP subject-selection policy. */
  analysis_subject_selection?: "FIRST_TIMELINE_PLAYER_DEFAULT" | "EXPLICIT_PLAYER";
  analysis_subject_player_id?: string;
  limitations?: string[];
}

export interface ReviewPlan {
  id: string;
  demo_id: string;
  player_id: string;
  status: "BUILDING" | "STARTABLE" | "COMPLETE" | "FAILED";
  match_timeline_version: string;
  observation_version: string;
  signal_version: string;
  planner_version: string;
  estimated_duration_seconds: number;
  available_until_round: number;
  full_match_index_ready: boolean;
  global_aggregation_ready: boolean;
  segments: ReviewSegment[];
  cues: CoachCue[];
  habit_clusters: HabitCluster[];
  generation_manifest: GenerationManifest;
}

export type CoachingSessionPhase =
  | "INTRO"
  | "PLAYING"
  | "SKIPPING"
  | "PAUSED_FOR_COACHING"
  | "REVEALING"
  | "REPLAYING"
  | "WRAP_UP"
  | "COMPLETED";

export interface SessionUserEvent {
  id: string;
  type:
    | "STARTED"
    | "SEGMENT_SKIPPED"
    | "SKIP_EXPANDED"
    | "OUTCOME_REVEALED"
    | "OUTCOME_REPLAYED"
    | "QUESTION_ASKED"
    | "SESSION_COMPLETED";
  segment_id?: string;
  cue_id?: string;
  at_tick: number;
  detail?: string;
}

export interface CoachingSessionState {
  id: string;
  review_plan_id: string;
  phase: CoachingSessionPhase;
  current_segment_index: number;
  current_cue_id?: string;
  current_tick: number;
  consumed_cue_ids: string[];
  revealed_cue_ids: string[];
  expanded_segment_ids: string[];
  user_events: SessionUserEvent[];
}

export interface SessionSummary {
  positive: string;
  habit_title: string;
  habit_occurrences: number;
  representative_rounds: number[];
  next_match_goal: string;
  checkpoints: string[];
}

export interface QuestionAnswer {
  text: string;
  citation_refs: string[];
  limitation?: string;
}

export * from "./geometry";
export * from "./assets";
export * from "./map";
export * from "./match";
export * from "./observation";

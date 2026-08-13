"""Browser-facing ReplayBundle models.

The parser-facing rows in this module remain facts.  The observation and
review-plan rows are separate, explicitly derived products so that a raw
global parser event cannot silently become player knowledge or coaching
evidence.
"""

from __future__ import annotations

from typing import Any, Literal

from pydantic import ConfigDict, Field, field_validator

from .models import ParseWarning, StrictModel, TeamSide, WorldPoint


class ReplayInventoryItem(StrictModel):
    item_name: str | None = None
    item_id: int | None = None
    count: int | None = None
    count_source: Literal["PARSER_DIRECT", "UNAVAILABLE"] = "UNAVAILABLE"


class C4CarrierState(StrictModel):
    """A deterministic derivation, never a direct parser fact."""

    value: bool | None = None
    derived_from: list[str] = Field(default_factory=list)
    confidence: float = 0.0
    limitations: list[str] = Field(default_factory=list)

    @field_validator("confidence")
    @classmethod
    def validate_confidence(cls, value: float) -> float:
        if not 0.0 <= value <= 1.0:
            raise ValueError("confidence must be between 0 and 1")
        return value


class ReplayStateSample(StrictModel):
    """One sampled parser state at a canonical tick."""

    tick: int
    sample_reasons: list[Literal["STRIDE", "ROUND_BOUNDARY", "EVENT_TICK"]] = Field(default_factory=list)
    world_position: WorldPoint | None = None
    yaw: float | None = None
    pitch: float | None = None
    side: TeamSide | None = None
    team_number: int | None = None
    alive: bool | None = None
    health: float | None = None
    armor: float | None = None
    has_helmet: bool | None = None
    money: int | None = None
    active_weapon: str | None = None
    active_weapon_handle: int | None = None
    inventory: list[ReplayInventoryItem] = Field(default_factory=list)
    inventory_bitmask: int | None = None
    inventory_quantities: dict[str, int] | None = None
    total_ammo_left: float | None = None
    has_defuse_kit: bool | None = None
    c4_carrier: C4CarrierState = Field(default_factory=C4CarrierState)
    bomb_planted: bool | None = None
    bomb_dropped: bool | None = None
    bomb_site: int | None = None
    bomb_zone: int | None = None
    missing_fields: list[str] = Field(default_factory=list)

    @field_validator("tick")
    @classmethod
    def validate_tick(cls, value: int) -> int:
        if isinstance(value, bool) or value < 0:
            raise ValueError("tick must be a non-negative integer")
        return int(value)


class PlayerStateTrack(StrictModel):
    player_id: str
    canonical_round_number: int
    samples: list[ReplayStateSample] = Field(default_factory=list)


class ReplayPlayer(StrictModel):
    player_id: str
    display_name: str | None = None
    initial_team: TeamSide | None = None
    initial_team_number: int | None = None


class ReplayRound(StrictModel):
    canonical_round_number: int
    source_round_number: int | None = None
    half_number: int | None = None
    start_tick: int
    freeze_end_tick: int | None = None
    end_tick: int | None = None
    winner: TeamSide | None = None
    state_track_count: int = 0
    event_count: int = 0


class ReplayMatchMetadata(StrictModel):
    map_name: str | None = None
    demo_version_name: str | None = None
    patch_version: str | None = None
    parser_version: str
    source_file_name: str
    source_size_bytes: int
    source_sha256: str
    start_tick: int | None = None
    end_tick: int | None = None
    tick_rate: float | None = None
    score: dict[str, int] | None = None


class ReplayEvent(StrictModel):
    id: str
    event_type: str
    tick: int
    actor_player_id: str | None = None
    target_player_id: str | None = None
    world_origin: WorldPoint | None = None
    item_id: str | None = None
    payload: dict[str, Any] = Field(default_factory=dict)
    source_parser_event: str
    fact_confidence: float = 1.0
    fact_refs: list[str] = Field(default_factory=list)
    missing_fields: list[str] = Field(default_factory=list)

    @field_validator("fact_confidence")
    @classmethod
    def validate_fact_confidence(cls, value: float) -> float:
        if not 0.0 <= value <= 1.0:
            raise ValueError("fact_confidence must be between 0 and 1")
        return value


class GrenadeSample(StrictModel):
    tick: int
    world_position: WorldPoint
    sample_kind: Literal["START", "TURN", "STRIDE", "LIFECYCLE", "END"]


class GrenadeTrack(StrictModel):
    track_id: str
    # ``id``/``points`` mirror the existing browser ReplayBundle boundary;
    # ``track_id``/``samples`` remain the explicit Python names.
    id: str | None = None
    item_id: str | None = None
    points: list[GrenadeSample] = Field(default_factory=list)
    canonical_round_number: int | None = None
    grenade_entity_id: int | None = None
    grenade_type: str
    thrower_player_id: str | None = None
    thrower_display_name: str | None = None
    start_tick: int | None = None
    end_tick: int | None = None
    detonate_tick: int | None = None
    expire_tick: int | None = None
    samples: list[GrenadeSample] = Field(default_factory=list)
    sampling_strategy: str
    max_tick_gap: int | None = None
    max_chord_distance: float | None = None
    parser_grenade_types: list[str] = Field(default_factory=list)
    fact_refs: list[str] = Field(default_factory=list)
    limitations: list[str] = Field(default_factory=list)


class FieldCoverageEntry(StrictModel):
    available_count: int
    total_count: int
    ratio: float
    source: str
    limitations: list[str] = Field(default_factory=list)


class EventCoverageEntry(StrictModel):
    count: int
    direct_world_origin_count: int
    joined_world_origin_count: int
    source: str
    limitations: list[str] = Field(default_factory=list)


class GrenadeCoverage(StrictModel):
    input_rows: int
    canonical_rows: int = 0
    valid_position_rows: int = 0
    lifecycle_event_rows: int = 0
    output_tracks: int
    output_samples: int
    retained_ratio: float
    tracks_with_detonate: int = 0
    tracks_with_expire: int = 0
    source: str
    limitations: list[str] = Field(default_factory=list)


class FieldCoverage(StrictModel):
    trajectory: dict[str, FieldCoverageEntry] = Field(default_factory=dict)
    events: dict[str, EventCoverageEntry] = Field(default_factory=dict)
    grenades: GrenadeCoverage


class GenerationManifest(StrictModel):
    schema_version: str = "replay-bundle.v1"
    builder_version: str
    parser_version: str
    deterministic: bool = True
    sampling_stride_ticks: int
    trajectory_sampling_strategy: str
    preserved_round_boundary_ticks: int
    preserved_event_ticks: int
    grenade_sampling_strategy: str
    source_sha256: str
    source_size_bytes: int
    observation_version: str | None = None
    signal_version: str | None = None
    planner_version: str | None = None
    analysis_subject_selection: Literal["FIRST_TIMELINE_PLAYER_DEFAULT", "EXPLICIT_PLAYER"] | None = None
    analysis_subject_player_id: str | None = None
    limitations: list[str] = Field(default_factory=list)


class ReplayActiveItem(StrictModel):
    item_id: str
    item_class: str


class ReplayInventoryEntry(StrictModel):
    item_id: str
    item_class: str
    count: int


class ReplayMatchPlayer(StrictModel):
    player_id: str
    display_name: str
    side: TeamSide
    is_selected: bool


class ReplayTrackSample(StrictModel):
    tick: int
    x: float
    y: float
    alive: bool
    observed_by_selected: bool = False


class ReplayPlayerTrack(StrictModel):
    player_id: str
    samples: list[ReplayTrackSample] = Field(default_factory=list)


class ReplayRoundTimeline(StrictModel):
    round_number: int
    start_tick: int
    freeze_end_tick: int
    end_tick: int
    score_before: tuple[int, int]
    score_after: tuple[int, int]
    winner: TeamSide


class ReplayMatchTimeline(StrictModel):
    id: str
    demo_id: str
    source_kind: Literal["SYNTHETIC_FIXTURE", "PARSED_DEMO"]
    map_name: str
    tick_rate: float
    start_tick: int
    end_tick: int
    selected_player_id: str
    players: list[ReplayMatchPlayer]
    tracks: list[ReplayPlayerTrack] = Field(default_factory=list)
    rounds: list[ReplayRoundTimeline]
    timeline_version: str


class ReplayPlayerStateSample(StrictModel):
    """The frozen cross-end PlayerStateSample shape.

    Required fields stay required at the JSON boundary. If the parser cannot
    provide one, the builder omits that row and records a warning instead of
    writing a made-up value.
    """

    player_id: str
    tick: int
    side: TeamSide
    world_position: WorldPoint
    yaw: float
    pitch: float
    alive: bool
    health: float
    armor: float
    has_helmet: bool
    money: int | None = None
    active_item: ReplayActiveItem | None = None
    inventory: list[ReplayInventoryEntry] = Field(default_factory=list)
    has_defuse_kit: bool | None = None
    carries_c4: bool | None = None
    fact_refs: list[str] = Field(default_factory=list)
    missing_fields: list[str] = Field(default_factory=list)


class ReplayObservationClaim(StrictModel):
    """One observer-bound, runtime-safe knowledge claim.

    ``spatial_estimate`` is intentionally a JSON object at this boundary: the
    builder only emits the contract's coarse estimate variants and never puts
    a hidden opponent's parser position into a claim.
    """

    id: str
    claim_type: Literal[
        "PLAYER_POSITION",
        "PLAYER_PRESENCE",
        "SOUND_SOURCE",
        "DAMAGE_DIRECTION",
        "UTILITY_STATE",
        "BOMB_STATE",
        "LAST_KNOWN_POSITION",
        "TEAM_REPORT",
        "USER_CONTEXT",
    ]
    knowledge_kind: Literal["OBSERVED", "INFERRED", "USER_ASSERTED"]
    source_type: Literal[
        "DIRECT_VISION",
        "SPOTTED",
        "FOOTSTEP",
        "GUNSHOT",
        "DAMAGE_DIRECTION",
        "UTILITY",
        "BOMB",
        "LAST_KNOWN",
        "TEAM_SHARED",
        "USER_CONTEXT",
    ]
    subject_ref: str | None = None
    context_ref: str | None = None
    subject_resolution: Literal["EXACT_PLAYER", "TEAM_ONLY", "UNKNOWN_ACTOR"]
    available_from_tick: int
    evidence_tick: int
    expires_at_tick: int | None = None
    spatial_estimate: dict[str, Any]
    confidence: float
    sharing_scope: Literal["SELF", "VERIFIED_TEAM_SHARED", "USER_CONTEXT_ONLY"]
    evidence_refs: list[str] = Field(default_factory=list)
    audibility_assessment: dict[str, Any] | None = None
    derived_by: str
    limitations: list[str] = Field(default_factory=list)


class ReplayObservableState(StrictModel):
    """Observer knowledge at one canonical tick."""

    id: str
    demo_id: str
    timeline_version: str
    observer_player_id: str
    at_tick: int
    observation_version: str
    claims: list[ReplayObservationClaim] = Field(default_factory=list)
    limitations: list[str] = Field(default_factory=list)


class ReplayReviewFact(StrictModel):
    id: str
    text: str
    availability: Literal["DECISION", "OUTCOME"]
    available_at_tick: int
    source: Literal["DEMO"] = "DEMO"
    observed_by_player: bool


class ReplayReviewInference(StrictModel):
    id: str
    text: str
    confidence: float
    fact_refs: list[str] = Field(default_factory=list)


class ReplayReviewAdvice(StrictModel):
    id: str
    text: str
    trigger: str
    fact_refs: list[str] = Field(default_factory=list)
    rule_id: str | None = None


class ReplayReviewEvidence(StrictModel):
    id: str
    source: Literal["DEMO", "RULE", "USER_CONTEXT"]
    label: str
    sample_count: int | None = None
    fact_refs: list[str] = Field(default_factory=list)


class ReplayReviewAnnotation(StrictModel):
    id: str
    type: Literal["POINT", "LINE", "AREA"]
    coordinate_space: Literal["WORLD", "RADAR_PERCENT"]
    label: str
    point: dict[str, float] | None = None
    from_: dict[str, float] | None = Field(default=None, alias="from")
    to: dict[str, float] | None = None
    center: dict[str, float] | None = None
    radius: float | None = None

    model_config = ConfigDict(extra="forbid", populate_by_name=True)


class ReplayReviewCue(StrictModel):
    id: str
    segment_id: str
    cue_type: Literal["DECISION", "HABIT_RECHECK"]
    title: str
    question: str
    decision_tick: int
    reveal_tick: int
    outcome_start_tick: int
    outcome_end_tick: int
    facts: list[ReplayReviewFact] = Field(default_factory=list)
    inferences: list[ReplayReviewInference] = Field(default_factory=list)
    advice: list[ReplayReviewAdvice] = Field(default_factory=list)
    evidence: list[ReplayReviewEvidence] = Field(default_factory=list)
    observable_fact_refs: list[str] = Field(default_factory=list)
    observable_state_id: str | None = None
    annotations: list[ReplayReviewAnnotation] = Field(default_factory=list)
    confidence: float
    limitations: list[str] = Field(default_factory=list)


class ReplayReviewSegment(StrictModel):
    id: str
    round_number: int
    start_tick: int
    end_tick: int
    mode: Literal["SKIP", "BRIEF", "OBSERVE", "DEEP_DIVE", "HABIT_CHECK"]
    reason_code: str
    display_reason: str
    playback_speed: float
    cue_ids: list[str] = Field(default_factory=list)
    expandable: bool


class ReplayHabitCluster(StrictModel):
    id: str
    title: str
    taxonomy_id: str
    cue_ids: list[str] = Field(default_factory=list)
    occurrence_count: int
    opportunity_count: int


class ReviewGenerationManifest(StrictModel):
    parser_version: str
    observation_version: str
    signal_version: str
    planner_version: str
    provider: Literal["DETERMINISTIC_TEMPLATE", "DEEPSEEK"] = "DETERMINISTIC_TEMPLATE"
    model: str | None = None
    prompt_version: str = "deterministic-coach-template/1.1.0"
    status: Literal["DISABLED", "SUCCEEDED", "FALLBACK"] = "DISABLED"
    narration_deterministic: bool = True
    analysis_subject_selection: Literal["FIRST_TIMELINE_PLAYER_DEFAULT", "EXPLICIT_PLAYER"]
    analysis_subject_player_id: str
    limitations: list[str] = Field(default_factory=list)


class ReplayReviewPlan(StrictModel):
    id: str
    demo_id: str
    player_id: str
    status: Literal["BUILDING", "STARTABLE", "COMPLETE", "FAILED"]
    match_timeline_version: str
    observation_version: str
    signal_version: str
    planner_version: str
    estimated_duration_seconds: int
    available_until_round: int
    full_match_index_ready: bool
    global_aggregation_ready: bool
    segments: list[ReplayReviewSegment] = Field(default_factory=list)
    cues: list[ReplayReviewCue] = Field(default_factory=list)
    habit_clusters: list[ReplayHabitCluster] = Field(default_factory=list)
    generation_manifest: ReviewGenerationManifest


class ReplayBundle(StrictModel):
    """A deterministic browser replay artifact plus derived teaching data."""

    model_config = ConfigDict(extra="forbid")

    bundle_id: str
    schema_version: str = "replay-bundle.v1"
    match_timeline: ReplayMatchTimeline
    player_state_tracks: list[ReplayPlayerStateSample] = Field(default_factory=list)
    observable_states: list[ReplayObservableState] = Field(default_factory=list)
    review_plan: ReplayReviewPlan | None = None
    events: list[ReplayEvent] = Field(default_factory=list)
    grenade_tracks: list[GrenadeTrack] = Field(default_factory=list)
    coverage: FieldCoverage
    warnings: list[ParseWarning] = Field(default_factory=list)
    generation_manifest: GenerationManifest

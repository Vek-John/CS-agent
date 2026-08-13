"""Pydantic v2 models for normalized, parser-verifiable Demo facts."""

from __future__ import annotations

from enum import Enum
from typing import Any

from pydantic import BaseModel, ConfigDict, Field, field_validator


def _normalize_identifier(value: Any) -> str:
    if value is None or isinstance(value, bool):
        raise ValueError("player_id must be a non-empty identifier")
    if isinstance(value, float) and value.is_integer():
        value = int(value)
    text = str(value).strip()
    if not text or text.lower() in {"nan", "none", "null"}:
        raise ValueError("player_id must be a non-empty identifier")
    return text


def _normalize_tick(value: Any) -> int:
    if value is None or isinstance(value, bool):
        raise ValueError("tick must be an integer")
    if isinstance(value, float):
        if not value.is_integer():
            raise ValueError("tick must be an integer")
        value = int(value)
    try:
        result = int(value)
    except (TypeError, ValueError) as exc:
        raise ValueError("tick must be an integer") from exc
    if result < 0:
        raise ValueError("tick must be non-negative")
    return result


def _normalize_positive_integer(value: Any, field_name: str) -> int:
    if value is None or isinstance(value, bool):
        raise ValueError(f"{field_name} must be a positive integer")
    if isinstance(value, float):
        if not value.is_integer():
            raise ValueError(f"{field_name} must be a positive integer")
        value = int(value)
    try:
        result = int(value)
    except (TypeError, ValueError) as exc:
        raise ValueError(f"{field_name} must be a positive integer") from exc
    if result < 1:
        raise ValueError(f"{field_name} must be a positive integer")
    return result


class StrictModel(BaseModel):
    model_config = ConfigDict(extra="forbid")


class TeamSide(str, Enum):
    T = "T"
    CT = "CT"


class ParseWarning(StrictModel):
    """A non-fatal loss of information or parser compatibility issue."""

    code: str
    message: str
    field: str | None = None
    details: dict[str, Any] = Field(default_factory=dict)


class ParseResult(StrictModel):
    parser_version: str
    warnings: list[ParseWarning] = Field(default_factory=list)


class DemoMetadata(ParseResult):
    path: str
    file_size_bytes: int
    map_name: str | None = None
    demo_version_name: str | None = None
    patch_version: str | None = None
    header: dict[str, Any] = Field(default_factory=dict)


class PlayerRecord(StrictModel):
    """Player-table identity and initial/summary team metadata."""

    player_id: str
    display_name: str | None = None
    team: TeamSide | None = None
    team_number: int | None = None

    @field_validator("player_id", mode="before")
    @classmethod
    def validate_player_id(cls, value: Any) -> str:
        return _normalize_identifier(value)


class PlayersResult(ParseResult):
    players: list[PlayerRecord] = Field(default_factory=list)


class RoundRecord(StrictModel):
    """A deterministic round identity plus parser-provided optional metadata.

    ``canonical_round_number`` is assigned by chronological valid
    ``round_start`` boundaries. It is an adapter identity, not a claim that
    demoparser2 exposed a raw round number. ``source_round_number`` is kept
    separately and remains ``None`` when the parser did not provide it.
    """

    canonical_round_number: int
    source_round_number: int | None = None
    half_number: int | None = None
    start_tick: int
    freeze_end_tick: int | None = None
    end_tick: int | None = None
    winner: TeamSide | None = None

    @field_validator("canonical_round_number", "source_round_number", mode="before")
    @classmethod
    def validate_round_numbers(cls, value: Any, info: Any) -> int | None:
        if value is None:
            return None
        return _normalize_positive_integer(value, info.field_name)

    @field_validator("half_number", mode="before")
    @classmethod
    def validate_half_number(cls, value: Any) -> int | None:
        if value is None:
            return None
        return _normalize_positive_integer(value, "half_number")

    @field_validator("start_tick", "freeze_end_tick", "end_tick", mode="before")
    @classmethod
    def validate_ticks(cls, value: Any) -> int | None:
        if value is None:
            return None
        return _normalize_tick(value)


class RoundsResult(ParseResult):
    rounds: list[RoundRecord] = Field(default_factory=list)


class EventParticipant(StrictModel):
    player_id: str | None = None
    display_name: str | None = None

    @field_validator("player_id", mode="before")
    @classmethod
    def validate_optional_player_id(cls, value: Any) -> str | None:
        if value is None:
            return None
        return _normalize_identifier(value)


class WorldPoint(StrictModel):
    """A world position copied from direct parser fields on one event row."""

    x: float
    y: float
    z: float


class EventRecord(StrictModel):
    """A parser event containing facts only; no inference or advice fields.

    ``world_origin`` is populated only from direct coordinates on this event
    row. It is not joined from the actor's trajectory.
    """

    event_type: str
    tick: int
    canonical_round_number: int | None = None
    source_round_number: int | None = None
    actor: EventParticipant | None = None
    target: EventParticipant | None = None
    assister: EventParticipant | None = None
    winner: TeamSide | None = None
    site: str | None = None
    weapon: str | None = None
    world_origin: WorldPoint | None = None
    details: dict[str, Any] = Field(default_factory=dict)

    @field_validator("canonical_round_number", "source_round_number", mode="before")
    @classmethod
    def validate_event_round_numbers(cls, value: Any, info: Any) -> int | None:
        if value is None:
            return None
        return _normalize_positive_integer(value, info.field_name)

    @field_validator("tick", mode="before")
    @classmethod
    def validate_event_tick(cls, value: Any) -> int:
        return _normalize_tick(value)


class EventsResult(ParseResult):
    events: list[EventRecord] = Field(default_factory=list)


class TrajectorySample(StrictModel):
    """A per-player tick snapshot of parser-exposed world state.

    Optional fields remain ``None`` when demoparser2 does not expose a direct
    fact. In particular, ``c4_carrier`` and ``inventory_quantities`` are not
    inferred from distance, events, or item names.
    ``side`` is normalized from this same row's ``team_number`` and can change
    when a player changes sides.
    """

    player_id: str
    tick: int
    x: float | None = None
    y: float | None = None
    z: float | None = None
    pitch: float | None = None
    yaw: float | None = None
    health: float | None = None
    team_number: int | None = None
    side: TeamSide | None = None
    is_alive: bool | None = None
    current_weapon: str | None = None
    active_weapon_handle: int | None = None
    inventory_names: list[str] | None = None
    inventory_item_ids: list[int] | None = None
    inventory_bitmask: int | None = None
    inventory_quantities: dict[str, int] | None = None
    total_ammo_left: float | None = None
    armor: float | None = None
    has_helmet: bool | None = None
    has_defuser: bool | None = None
    money: int | None = None
    c4_carrier: bool | None = None
    bomb_planted: bool | None = None
    bomb_dropped: bool | None = None
    bomb_site: int | None = None
    bomb_zone: int | None = None

    @field_validator("player_id", mode="before")
    @classmethod
    def validate_trajectory_player_id(cls, value: Any) -> str:
        return _normalize_identifier(value)

    @field_validator("tick", mode="before")
    @classmethod
    def validate_trajectory_tick(cls, value: Any) -> int:
        return _normalize_tick(value)


class TrajectoryResult(ParseResult):
    samples: list[TrajectorySample] = Field(default_factory=list)
    fields: list[str] = Field(default_factory=list)


class GrenadeTrajectoryRow(StrictModel):
    """One row returned by demoparser2 0.42 ``parse_grenades``.

    Rows with no finite coordinates are retained as parser lifecycle rows, but
    downstream trajectory samples are emitted only from real finite x/y/z
    values or direct lifecycle event coordinates.
    """

    grenade_type: str
    grenade_entity_id: int
    tick: int
    thrower_player_id: str | None = None
    thrower_display_name: str | None = None
    world_position: WorldPoint | None = None


class GrenadesResult(ParseResult):
    rows: list[GrenadeTrajectoryRow] = Field(default_factory=list)
    fields: list[str] = Field(default_factory=list)

"""A small stable boundary around demoparser2 0.42.0.

The adapter deliberately returns only facts that can be traced to parser output.
It does not calculate observations, teaching signals, inferences, or advice.
"""

from __future__ import annotations

import math
import re
from collections.abc import Callable, Iterable, Mapping, Sequence
from importlib.metadata import PackageNotFoundError, version as package_version
from pathlib import Path
from typing import Any

from .errors import (
    DemoFileError,
    DemoParseError,
    DemoParserUnavailableError,
    DemoRequestError,
)
from .models import (
    DemoMetadata,
    EventParticipant,
    EventRecord,
    EventsResult,
    GrenadeTrajectoryRow,
    GrenadesResult,
    ParseWarning,
    PlayerRecord,
    PlayersResult,
    RoundRecord,
    RoundsResult,
    TeamSide,
    TrajectoryResult,
    TrajectorySample,
    WorldPoint,
)


ParserFactory = Callable[[str], Any]

DEFAULT_TRAJECTORY_FIELDS = (
    "x",
    "y",
    "z",
    "pitch",
    "yaw",
    "health",
    "team_number",
    "is_alive",
)

# Keep the original lightweight default above. Callers that need the complete
# parser-exposed full-state snapshot can opt in with this explicit field set.
FULL_STATE_FIELDS = DEFAULT_TRAJECTORY_FIELDS + (
    "current_weapon",
    "active_weapon_handle",
    "inventory_names",
    "inventory_item_ids",
    "inventory_bitmask",
    "inventory_quantities",
    "total_ammo_left",
    "armor",
    "has_helmet",
    "has_defuser",
    "money",
    "c4_carrier",
    "bomb_planted",
    "bomb_dropped",
    "bomb_site",
    "bomb_zone",
)

GRENADE_FIELDS = (
    "grenade_type",
    "grenade_entity_id",
    "x",
    "y",
    "z",
    "tick",
    "steamid",
    "name",
)

_TRAJECTORY_FIELD_MAP = {
    "x": "X",
    "y": "Y",
    "z": "Z",
    "pitch": "pitch",
    "yaw": "yaw",
    "health": "health",
    "team_number": "team_num",
    "is_alive": "is_alive",
    "current_weapon": "weapon_name",
    "active_weapon_handle": "active_weapon",
    "inventory_names": "inventory",
    "inventory_item_ids": "inventory_as_ids",
    "inventory_bitmask": "inventory_as_bitmask",
    # demoparser2 exposes the inventory entries but no reliable per-item
    # quantity field through parse_ticks 0.42.0.
    "inventory_quantities": None,
    "total_ammo_left": "total_ammo_left",
    "armor": "armor_value",
    "has_helmet": "has_helmet",
    "has_defuser": "has_defuser",
    "money": "CCSPlayerController.CCSPlayerController_InGameMoneyServices.m_iAccount",
    # No direct per-player C4 carrier field was exposed by this parser build.
    "c4_carrier": None,
    "bomb_planted": "CCSGameRulesProxy.CCSGameRules.m_bBombPlanted",
    "bomb_dropped": "CCSGameRulesProxy.CCSGameRules.m_bBombDropped",
    "bomb_site": "CCSGameRulesProxy.CCSGameRules.m_iBombSite",
    "bomb_zone": "CCSPlayerPawn.m_nWhichBombZone",
}

_DETAIL_FIELD_MAP = {
    "dmg_health": "damage_health",
    "dmg_armor": "damage_armor",
    "health": "health_after",
    "armor": "armor_after",
    "thrusmoke": "through_smoke",
    "assistedflash": "assisted_flash",
    "attackerblind": "attacker_blind",
    "attackerinair": "attacker_in_air",
    "noreplay": "no_replay",
    "noscope": "no_scope",
    "hitgroup": "hit_group",
    "player_count": "player_count",
    "fraglimit": "frag_limit",
    "timelimit": "time_limit",
    "inventory_slot": "inventory_slot",
    "item_name": "item_name",
    "was_sold": "was_sold",
    "paint_seed": "paint_seed",
    "skin_id": "skin_id",
}

_KNOWN_BOUNDARY_EVENTS = (
    "round_start",
    "round_freeze_end",
    "round_end",
    "round_officially_ended",
)

# These are direct coordinates on the event row. The adapter never fills an
# event position from an actor trajectory or another event.
_EVENT_WORLD_ORIGIN_FIELDS = (
    ("X", "Y", "Z"),
    ("x", "y", "z"),
    ("origin_x", "origin_y", "origin_z"),
    ("ent_origin_x", "ent_origin_y", "ent_origin_z"),
)


class _WarningCollector:
    def __init__(self) -> None:
        self._warnings: list[ParseWarning] = []
        self._keys: set[tuple[str, str, str | None]] = set()

    def add(
        self,
        code: str,
        message: str,
        *,
        field: str | None = None,
        details: Mapping[str, Any] | None = None,
    ) -> None:
        key = (code, message, field)
        if key in self._keys:
            return
        self._keys.add(key)
        self._warnings.append(
            ParseWarning(
                code=code,
                message=message,
                field=field,
                details=dict(details or {}),
            )
        )

    def values(self) -> list[ParseWarning]:
        return list(self._warnings)


def _is_missing(value: Any) -> bool:
    if value is None:
        return True
    if isinstance(value, float):
        return math.isnan(value)
    try:
        comparison = value != value
    except Exception:
        return False
    return isinstance(comparison, bool) and comparison


def _clean_value(value: Any) -> Any:
    """Convert pandas/numpy scalar values into JSON-friendly Python values."""
    if _is_missing(value):
        return None
    if isinstance(value, Mapping):
        return {str(key): _clean_value(item) for key, item in value.items()}
    if isinstance(value, (list, tuple)):
        return [_clean_value(item) for item in value]
    if isinstance(value, bytes):
        return value.decode("utf-8", errors="replace")
    to_list_method = getattr(value, "tolist", None)
    if callable(to_list_method):
        try:
            return _clean_value(to_list_method())
        except (TypeError, ValueError):
            pass
    item_method = getattr(value, "item", None)
    if callable(item_method):
        try:
            return _clean_value(item_method())
        except (TypeError, ValueError):
            pass
    return value


def _records(value: Any) -> list[dict[str, Any]]:
    if value is None:
        return []
    if hasattr(value, "to_dicts"):
        rows = value.to_dicts()
    elif hasattr(value, "to_dict"):
        try:
            rows = value.to_dict(orient="records")
        except TypeError:
            rows = value.to_dict()
            if isinstance(rows, Mapping):
                rows = [rows]
    elif isinstance(value, Mapping):
        rows = [value]
    else:
        rows = value

    if not isinstance(rows, Iterable) or isinstance(rows, (str, bytes)):
        return []
    normalized: list[dict[str, Any]] = []
    for row in rows:
        if isinstance(row, Mapping):
            normalized.append({str(key): _clean_value(item) for key, item in row.items()})
    return normalized


def _first(row: Mapping[str, Any], *keys: str) -> Any:
    for key in keys:
        if key in row and not _is_missing(row[key]):
            return row[key]
    return None


def _as_text(value: Any) -> str | None:
    if _is_missing(value):
        return None
    text = str(value).strip()
    return text or None


def _as_int(value: Any) -> int | None:
    if _is_missing(value) or isinstance(value, bool):
        return None
    if isinstance(value, float):
        if not value.is_integer():
            return None
        return int(value)
    try:
        text = str(value).strip()
        if re.fullmatch(r"[-+]?\d+", text):
            return int(text)
        result = int(value)
        if str(result) == text:
            return result
        return None
    except (TypeError, ValueError, OverflowError):
        return None


def _required_int(
    value: Any,
    *,
    collector: _WarningCollector,
    code: str,
    field: str,
    context: Mapping[str, Any] | None = None,
    non_negative: bool = True,
) -> int | None:
    result = _as_int(value)
    if result is None or (non_negative and result < 0):
        collector.add(
            code,
            f"Could not normalize {field} to a non-negative integer.",
            field=field,
            details=dict(context or {}),
        )
        return None
    return result


def _player_id(value: Any) -> str | None:
    if _is_missing(value) or isinstance(value, bool):
        return None
    if isinstance(value, float) and value.is_integer():
        value = int(value)
    text = str(value).strip()
    if not text or text.lower() in {"nan", "none", "null"}:
        return None
    return text


def _team_side(value: Any) -> TeamSide | None:
    if _is_missing(value):
        return None
    integer = _as_int(value)
    if integer == 2:
        return TeamSide.T
    if integer == 3:
        return TeamSide.CT
    text = str(value).strip().lower()
    if text in {"t", "terrorist", "terrorists", "team_t", "team2", "2"}:
        return TeamSide.T
    if text in {"ct", "counter-terrorist", "counter-terrorists", "team_ct", "team3", "3"}:
        return TeamSide.CT
    return None


def _boolean(value: Any) -> bool | None:
    if _is_missing(value):
        return None
    if isinstance(value, bool):
        return value
    integer = _as_int(value)
    if integer in {0, 1}:
        return bool(integer)
    text = str(value).strip().lower()
    if text in {"true", "yes", "on"}:
        return True
    if text in {"false", "no", "off"}:
        return False
    return None


def _number(value: Any) -> float | None:
    if _is_missing(value):
        return None
    try:
        result = float(value)
    except (TypeError, ValueError, OverflowError):
        return None
    return result if math.isfinite(result) else None


def _string_list(value: Any) -> list[str] | None:
    if _is_missing(value):
        return None
    value = _clean_value(value)
    if not isinstance(value, (list, tuple)):
        return None
    return [str(item) for item in value if not _is_missing(item)]


def _integer_list(value: Any) -> list[int] | None:
    if _is_missing(value):
        return None
    value = _clean_value(value)
    if not isinstance(value, (list, tuple)):
        return None
    result: list[int] = []
    for item in value:
        normalized = _as_int(item)
        if normalized is not None:
            result.append(normalized)
    return result


class DemoParserAdapter:
    """Normalize demoparser2 output without leaking parser-specific models."""

    def __init__(
        self,
        *,
        parser_factory: ParserFactory | None = None,
        parser_version: str | None = None,
    ) -> None:
        self._parser_factory = parser_factory or self._default_parser_factory
        if parser_version:
            self._parser_version = parser_version
        elif parser_factory is not None:
            self._parser_version = "injected"
        else:
            self._parser_version = self._installed_parser_version()

    @property
    def parser_version(self) -> str:
        return self._parser_version

    @staticmethod
    def _installed_parser_version() -> str:
        try:
            return package_version("demoparser2")
        except PackageNotFoundError as exc:
            raise DemoParserUnavailableError(
                "demoparser2 is not installed; install workers/analysis dependencies "
                "with Python 3.12 before constructing the default adapter."
            ) from exc

    @staticmethod
    def _default_parser_factory(path: str) -> Any:
        try:
            from demoparser2 import DemoParser
        except ImportError as exc:
            raise DemoParserUnavailableError(
                "demoparser2 could not be imported; install demoparser2==0.42.0 "
                "in the Python 3.12 analysis environment."
            ) from exc
        return DemoParser(path)

    @staticmethod
    def _validate_path(path: str | Path) -> Path:
        if not isinstance(path, (str, Path)):
            raise DemoFileError("Demo path must be a string or pathlib.Path.")
        candidate = Path(path).expanduser()
        if not candidate.exists():
            raise DemoFileError(
                f"Demo file does not exist: {candidate}",
                path=str(candidate),
            )
        if not candidate.is_file():
            raise DemoFileError(
                f"Demo path is not a regular file: {candidate}",
                path=str(candidate),
            )
        try:
            candidate.stat()
        except OSError as exc:
            raise DemoFileError(
                f"Demo file cannot be inspected: {candidate} ({exc})",
                path=str(candidate),
            ) from exc
        return candidate.resolve()

    def _new_parser(self, path: str | Path) -> tuple[Path, Any]:
        candidate = self._validate_path(path)
        try:
            return candidate, self._parser_factory(str(candidate))
        except DemoParserUnavailableError:
            raise
        except Exception as exc:
            raise DemoParseError(
                f"demoparser2 could not open Demo {candidate}: {exc}",
                path=str(candidate),
            ) from exc

    @staticmethod
    def _call_parser(parser: Any, method: str, *args: Any, path: Path, **kwargs: Any) -> Any:
        try:
            operation = getattr(parser, method)
        except AttributeError as exc:
            raise DemoParseError(
                f"Parser does not expose required operation {method!r}.",
                path=str(path),
            ) from exc
        try:
            return operation(*args, **kwargs)
        except Exception as exc:
            raise DemoParseError(
                f"Parser operation {method!r} failed for {path}: {exc}",
                path=str(path),
            ) from exc

    def inspect(self, path: str | Path) -> DemoMetadata:
        candidate, parser = self._new_parser(path)
        collector = _WarningCollector()
        header_value = self._call_parser(parser, "parse_header", path=candidate)
        header = _clean_value(header_value) if isinstance(header_value, Mapping) else {}
        if not header:
            collector.add("HEADER_EMPTY", "Parser returned no Demo header fields.")
        map_name = _as_text(header.get("map_name"))
        if map_name is None:
            collector.add("MAP_NAME_UNAVAILABLE", "Demo header did not expose map_name.", field="map_name")
        return DemoMetadata(
            path=str(candidate),
            file_size_bytes=candidate.stat().st_size,
            map_name=map_name,
            demo_version_name=_as_text(header.get("demo_version_name")),
            patch_version=_as_text(header.get("patch_version")),
            header=header,
            parser_version=self.parser_version,
            warnings=collector.values(),
        )

    def read_players(self, path: str | Path) -> PlayersResult:
        candidate, parser = self._new_parser(path)
        collector = _WarningCollector()
        rows = _records(self._call_parser(parser, "parse_player_info", path=candidate))
        players: list[PlayerRecord] = []
        seen: set[str] = set()
        for row in rows:
            player_id = _player_id(_first(row, "steamid", "steam_id", "player_id"))
            if player_id is None:
                collector.add(
                    "PLAYER_ID_UNAVAILABLE",
                    "Player row has no usable Steam ID and was skipped.",
                    field="player_id",
                )
                continue
            if player_id in seen:
                collector.add(
                    "DUPLICATE_PLAYER_ID",
                    "Parser returned the same player ID more than once.",
                    field="player_id",
                    details={"player_id": player_id},
                )
                continue
            seen.add(player_id)
            team_number = _as_int(_first(row, "team_number", "team_num", "team"))
            if _first(row, "team_number", "team_num", "team") is not None and team_number is None:
                collector.add("TEAM_NUMBER_UNAVAILABLE", "Player team number was not an integer.", field="team_number")
            team = _team_side(team_number if team_number is not None else _first(row, "team"))
            players.append(
                PlayerRecord(
                    player_id=player_id,
                    display_name=_as_text(_first(row, "name", "player_name", "display_name")),
                    team=team,
                    team_number=team_number,
                )
            )
        if not players:
            collector.add("PLAYERS_EMPTY", "Parser returned no usable player rows.")
        return PlayersResult(
            parser_version=self.parser_version,
            warnings=collector.values(),
            players=players,
        )

    def _event_rows(self, parser: Any, event_name: str, *, path: Path) -> list[dict[str, Any]]:
        value = self._call_parser(parser, "parse_event", event_name, path=path)
        # parse_event returns an empty list for an event absent from a Demo.
        if isinstance(value, list) and value and all(isinstance(item, tuple) and len(item) == 2 for item in value):
            rows: list[dict[str, Any]] = []
            for _, frame in value:
                rows.extend(_records(frame))
            return rows
        return _records(value)

    @staticmethod
    def _raw_round_number(row: Mapping[str, Any]) -> tuple[bool, int | None]:
        key = next((key for key in ("round", "round_number", "source_round_number") if key in row), None)
        if key is None or _is_missing(row[key]):
            return key is not None, None
        value = _as_int(row[key])
        return True, value if value is not None and value > 0 else None

    @staticmethod
    def _raw_half_number(row: Mapping[str, Any]) -> tuple[bool, int | None]:
        key = next((key for key in ("half", "half_number", "match_half") if key in row), None)
        if key is None or _is_missing(row[key]):
            return key is not None, None
        value = _as_int(row[key])
        return True, value if value is not None and value > 0 else None

    def _read_rounds_from_parser(
        self,
        parser: Any,
        *,
        path: Path,
    ) -> tuple[list[RoundRecord], list[ParseWarning]]:
        collector = _WarningCollector()
        starts = self._event_rows(parser, "round_start", path=path)
        freezes = self._event_rows(parser, "round_freeze_end", path=path)
        ends = self._event_rows(parser, "round_end", path=path)
        official_ends = self._event_rows(parser, "round_officially_ended", path=path)

        all_boundary_rows = (*starts, *freezes, *ends, *official_ends)
        if not starts:
            collector.add(
                "ROUND_START_UNAVAILABLE",
                "Parser returned no round_start boundaries; no round records were created.",
            )
        has_source_round_field = any(self._raw_round_number(row)[0] for row in all_boundary_rows)
        if not has_source_round_field:
            collector.add(
                "ROUND_NUMBER_UNAVAILABLE",
                "Parser did not expose source round numbers; source_round_number remains null. "
                "Canonical round identities are still assigned from valid round_start order.",
                field="source_round_number",
            )
        has_half_field = any(self._raw_half_number(row)[0] for row in all_boundary_rows)
        if not has_half_field:
            collector.add(
                "HALF_NUMBER_UNAVAILABLE",
                "Parser did not expose half numbers; half_number remains null.",
                field="half_number",
            )
        if not freezes:
            collector.add(
                "FREEZE_END_UNAVAILABLE",
                "Parser returned no round_freeze_end boundaries; freeze_end_tick remains null where absent.",
                field="freeze_end_tick",
            )
        if not ends:
            collector.add(
                "ROUND_END_UNAVAILABLE",
                "Parser returned no round_end boundaries; end_tick and winner remain null where absent.",
            )

        states: list[dict[str, Any]] = []
        by_source_number: dict[int, dict[str, Any]] = {}

        def remember_source_number(state: dict[str, Any], source_number: int | None) -> None:
            if source_number is None:
                return
            existing_source = state["source_round_number"]
            if existing_source is not None and existing_source != source_number:
                collector.add(
                    "ROUND_SOURCE_NUMBER_CONFLICT",
                    "Boundary rows exposed conflicting source round numbers for one canonical round.",
                    field="source_round_number",
                    details={
                        "canonical_round_number": state.get("canonical_round_number"),
                        "existing": existing_source,
                        "incoming": source_number,
                    },
                )
                return
            state["source_round_number"] = source_number
            existing_state = by_source_number.get(source_number)
            if existing_state is None:
                by_source_number[source_number] = state
            elif existing_state is not state:
                collector.add(
                    "DUPLICATE_ROUND_NUMBER",
                    "Parser returned more than one canonical round for the same source round number.",
                    field="source_round_number",
                    details={"source_round_number": source_number},
                )

        def report_half_number(row: Mapping[str, Any], boundary: str) -> int | None:
            has_half, half_number = self._raw_half_number(row)
            if has_half and half_number is None:
                collector.add(
                    "HALF_NUMBER_INVALID",
                    f"A {boundary} row exposed an unusable half number; half_number remains null.",
                    field="half_number",
                )
            return half_number

        for row in starts:
            tick = _required_int(
                _first(row, "tick"),
                collector=collector,
                code="ROUND_START_TICK_INVALID",
                field="start_tick",
            )
            if tick is None:
                continue
            raw_has_source, source_round_number = self._raw_round_number(row)
            if raw_has_source and source_round_number is None:
                collector.add(
                    "ROUND_NUMBER_INVALID",
                    "A round_start row exposed an unusable source round number; source_round_number remains null.",
                    field="source_round_number",
                )
            state = {
                "canonical_round_number": None,
                "source_round_number": None,
                "half_number": report_half_number(row, "round_start"),
                "start_tick": tick,
                "freeze_end_tick": None,
                "end_tick": None,
                "winner": None,
            }
            states.append(state)
            remember_source_number(state, source_round_number)
        states.sort(key=lambda item: item["start_tick"])
        for canonical_round_number, state in enumerate(states, start=1):
            state["canonical_round_number"] = canonical_round_number
        if not states:
            collector.add(
                "CANONICAL_ROUND_UNAVAILABLE",
                "No valid round_start boundary was available; canonical round identities remain unavailable.",
                field="canonical_round_number",
            )

        def chronological_state(tick: int, boundary: str) -> dict[str, Any] | None:
            if boundary == "end_tick":
                # Round ends are attached strictly before a same-tick next
                # round_start. This makes [start, end) event ownership stable.
                candidates = [
                    state
                    for state in states
                    if state["start_tick"] < tick and state[boundary] is None
                ]
                if candidates:
                    return candidates[-1]
                # A zero-length first round is unusual but deterministic:
                # choose the earliest start at the same tick, not the next one.
                same_tick = [
                    state
                    for state in states
                    if state["start_tick"] == tick and state[boundary] is None
                ]
                return same_tick[0] if same_tick else None
            candidates = [
                state
                for state in states
                if state["start_tick"] <= tick and state[boundary] is None
            ]
            return candidates[-1] if candidates else None

        def choose_state(row: Mapping[str, Any], boundary: str) -> dict[str, Any] | None:
            raw_has_source, source_round_number = self._raw_round_number(row)
            if raw_has_source and source_round_number is None:
                collector.add(
                    "ROUND_NUMBER_INVALID",
                    f"A {boundary} row exposed an unusable source round number; source_round_number remains null.",
                    field="source_round_number",
                )
            if source_round_number is not None:
                state = by_source_number.get(source_round_number)
                if state is not None and state[boundary] is None:
                    return state
                collector.add(
                    "ROUND_BOUNDARY_UNMATCHED",
                    f"{boundary} row could not be matched to an unused round_start by source round number; "
                    "chronological fallback was attempted.",
                    field="source_round_number",
                    details={
                        "source_round_number": source_round_number,
                        "tick": _clean_value(row.get("tick")),
                    },
                )
            tick = _as_int(_first(row, "tick"))
            if tick is None:
                collector.add(
                    "ROUND_BOUNDARY_TICK_INVALID",
                    f"{boundary} row has no usable tick and was ignored.",
                    field="tick",
                )
                return None
            state = chronological_state(tick, boundary)
            if state is None:
                collector.add(
                    "ROUND_BOUNDARY_UNMATCHED",
                    f"{boundary} row could not be matched chronologically to a round_start.",
                    details={"tick": tick},
                )
                return None
            remember_source_number(state, source_round_number)
            return state

        for row in sorted(freezes, key=lambda item: _as_int(_first(item, "tick")) or -1):
            tick = _as_int(_first(row, "tick"))
            if tick is None:
                collector.add("ROUND_BOUNDARY_TICK_INVALID", "round_freeze_end row has no usable tick.", field="tick")
                continue
            state = choose_state(row, "freeze_end_tick")
            if state is not None:
                state["freeze_end_tick"] = tick
                half_number = report_half_number(row, "round_freeze_end")
                if state["half_number"] is None:
                    state["half_number"] = half_number

        for row in sorted(ends, key=lambda item: _as_int(_first(item, "tick")) or -1):
            tick = _as_int(_first(row, "tick"))
            if tick is None:
                collector.add("ROUND_BOUNDARY_TICK_INVALID", "round_end row has no usable tick.", field="tick")
                continue
            winner_raw = _first(row, "winner")
            winner = _team_side(winner_raw)
            if winner is None:
                if winner_raw is not None:
                    collector.add(
                        "WINNER_UNNORMALIZED",
                        "round_end winner could not be normalized to T or CT.",
                        field="winner",
                    )
                collector.add(
                    "ROUND_END_INCOMPLETE",
                    "Ignored a round_end row without a usable winner so it cannot consume a canonical round boundary.",
                    field="winner",
                    details={
                        "tick": tick,
                        "source_round_number": _clean_value(
                            _first(row, "round", "round_number", "source_round_number")
                        ),
                    },
                )
                continue
            state = choose_state(row, "end_tick")
            if state is None:
                continue
            state["end_tick"] = tick
            state["winner"] = winner
            half_number = report_half_number(row, "round_end")
            if state["half_number"] is None:
                state["half_number"] = half_number

        # Some versions expose officially-ended ticks without a usable round_end.
        for row in sorted(official_ends, key=lambda item: _as_int(_first(item, "tick")) or -1):
            tick = _as_int(_first(row, "tick"))
            if tick is None:
                continue
            state = choose_state(row, "end_tick")
            if state is not None and state["end_tick"] is None:
                state["end_tick"] = tick
                collector.add(
                    "ROUND_END_FALLBACK",
                    "Used round_officially_ended tick because round_end did not provide an end tick.",
                    field="end_tick",
                )

        rounds: list[RoundRecord] = []
        for state in states:
            start_tick = state["start_tick"]
            freeze_tick = state["freeze_end_tick"]
            end_tick = state["end_tick"]
            if freeze_tick is not None and freeze_tick < start_tick:
                collector.add("ROUND_TICK_ORDER_INVALID", "freeze_end_tick precedes start_tick; value omitted.")
                freeze_tick = None
            if end_tick is not None and end_tick < start_tick:
                collector.add("ROUND_TICK_ORDER_INVALID", "end_tick precedes start_tick; value omitted.")
                end_tick = None
            rounds.append(
                RoundRecord(
                    canonical_round_number=state["canonical_round_number"],
                    source_round_number=state["source_round_number"],
                    half_number=state["half_number"],
                    start_tick=start_tick,
                    freeze_end_tick=freeze_tick,
                    end_tick=end_tick,
                    winner=state["winner"],
                )
            )
        return rounds, collector.values()

    def read_rounds(self, path: str | Path) -> RoundsResult:
        candidate, parser = self._new_parser(path)
        rounds, warnings = self._read_rounds_from_parser(parser, path=candidate)
        return RoundsResult(
            parser_version=self.parser_version,
            warnings=warnings,
            rounds=rounds,
        )

    @staticmethod
    def _canonical_round_for_tick(
        rounds: Sequence[RoundRecord],
        tick: int,
        event_type: str,
    ) -> int | None:
        """Assign an event to a canonical round using stable boundary rules.

        Ordinary events use half-open intervals ``[start_tick, end_tick)``.
        A shared ``round_end``/next ``round_start`` tick therefore belongs to
        the next ordinary interval, while the explicit boundary events belong
        to their own boundary record. If there is no next start, an ordinary
        event exactly at the final end tick falls back to that ending round.
        """

        if event_type == "round_start":
            candidates = [item for item in rounds if item.start_tick == tick]
            return candidates[-1].canonical_round_number if candidates else None
        if event_type in {"round_end", "round_officially_ended"}:
            candidates = [item for item in rounds if item.end_tick == tick]
            return candidates[-1].canonical_round_number if candidates else None

        candidates = [
            item
            for item in rounds
            if item.start_tick <= tick and (item.end_tick is None or tick < item.end_tick)
        ]
        if candidates:
            return candidates[-1].canonical_round_number
        ending_candidates = [item for item in rounds if item.end_tick == tick]
        return ending_candidates[-1].canonical_round_number if ending_candidates else None

    @staticmethod
    def _participant(row: Mapping[str, Any], *prefixes: str) -> EventParticipant | None:
        for prefix in prefixes:
            player_id = _player_id(_first(row, f"{prefix}_steamid", f"{prefix}_steam_id", f"{prefix}_player_id"))
            name = _as_text(_first(row, f"{prefix}_name", f"{prefix}_player_name"))
            if player_id is not None or name is not None:
                return EventParticipant(player_id=player_id, display_name=name)
        return None

    @staticmethod
    def _detail_key(key: str) -> str:
        if key in _DETAIL_FIELD_MAP:
            return _DETAIL_FIELD_MAP[key]
        if key.isidentifier():
            return key
        return re.sub(r"[^a-zA-Z0-9]+", "_", key).strip("_").lower()

    @classmethod
    def _event_details(cls, row: Mapping[str, Any]) -> dict[str, Any]:
        consumed = {
            "tick",
            "round",
            "round_number",
            "source_round_number",
            "half",
            "half_number",
            "match_half",
            "winner",
            "site",
            "weapon",
            "user_name",
            "user_steamid",
            "user_steam_id",
            "user_player_id",
            "attacker_name",
            "attacker_steamid",
            "attacker_steam_id",
            "attacker_player_id",
            "assister_name",
            "assister_steamid",
            "assister_steam_id",
            "assister_player_id",
        }
        return {
            cls._detail_key(key): _clean_value(value)
            for key, value in row.items()
            if key not in consumed and _clean_value(value) is not None
        }

    @classmethod
    def _event_world_origin(
        cls,
        row: Mapping[str, Any],
        event_name: str,
        collector: _WarningCollector,
    ) -> WorldPoint | None:
        """Read a position only from a complete direct event-row triplet."""

        partial_groups: list[dict[str, Any]] = []
        invalid_groups: list[dict[str, Any]] = []
        for fields in _EVENT_WORLD_ORIGIN_FIELDS:
            present = [field for field in fields if field in row and not _is_missing(row[field])]
            if not present:
                continue
            if len(present) != 3:
                partial_groups.append(
                    {
                        "fields": list(fields),
                        "present": present,
                        "missing": [field for field in fields if field not in present],
                    }
                )
                continue
            coordinates = [_number(row[field]) for field in fields]
            if all(coordinate is not None for coordinate in coordinates):
                return WorldPoint(
                    x=coordinates[0],
                    y=coordinates[1],
                    z=coordinates[2],
                )
            invalid_groups.append(
                {
                    "fields": list(fields),
                    "values": [_clean_value(row[field]) for field in fields],
                }
            )

        if invalid_groups:
            collector.add(
                "EVENT_WORLD_ORIGIN_INVALID",
                f"Event {event_name!r} exposed direct world-origin fields that were not numeric.",
                field="world_origin",
                details={"event_type": event_name, "groups": invalid_groups},
            )
        elif partial_groups:
            collector.add(
                "EVENT_WORLD_ORIGIN_INCOMPLETE",
                f"Event {event_name!r} exposed an incomplete direct world-origin field group.",
                field="world_origin",
                details={"event_type": event_name, "groups": partial_groups},
            )
        else:
            collector.add(
                "EVENT_WORLD_ORIGIN_UNAVAILABLE",
                f"Event {event_name!r} did not expose direct world-origin coordinates; value remains null.",
                field="world_origin",
                details={
                    "event_type": event_name,
                    "candidate_field_groups": [list(fields) for fields in _EVENT_WORLD_ORIGIN_FIELDS],
                },
            )
        return None

    def read_events(
        self,
        path: str | Path,
        event_names: str | Sequence[str] | None = None,
    ) -> EventsResult:
        candidate, parser = self._new_parser(path)
        collector = _WarningCollector()
        rounds, round_warnings = self._read_rounds_from_parser(parser, path=candidate)
        for warning in round_warnings:
            collector.add(
                warning.code,
                warning.message,
                field=warning.field,
                details=warning.details,
            )

        if event_names is None:
            available = self._call_parser(parser, "list_game_events", path=candidate)
            names = [str(name) for name in available]
            for boundary in _KNOWN_BOUNDARY_EVENTS:
                if boundary not in names:
                    names.append(boundary)
        elif isinstance(event_names, str):
            names = [event_names]
        else:
            names = [str(name) for name in event_names]
        names = list(dict.fromkeys(name for name in names if name.strip()))
        if not names:
            raise DemoRequestError("event_names must contain at least one non-empty event name.")

        available_names: set[str] = set()
        listed = self._call_parser(parser, "list_game_events", path=candidate)
        if isinstance(listed, Iterable) and not isinstance(listed, (str, bytes)):
            available_names = {str(name) for name in listed}

        events: list[EventRecord] = []
        for event_name in names:
            rows = self._event_rows(parser, event_name, path=candidate)
            if not rows:
                if event_name not in available_names:
                    collector.add(
                        "EVENT_UNAVAILABLE",
                        f"Parser returned no rows for requested event {event_name!r}.",
                        details={"event_type": event_name},
                    )
                continue
            for row in rows:
                tick = _required_int(
                    _first(row, "tick"),
                    collector=collector,
                    code="EVENT_TICK_INVALID",
                    field="tick",
                    context={"event_type": event_name},
                )
                if tick is None:
                    continue
                raw_has_round, raw_round = self._raw_round_number(row)
                if raw_has_round and raw_round is None:
                    collector.add(
                        "ROUND_NUMBER_INVALID",
                        "An event exposed an unusable source round number; source_round_number remains null.",
                        field="source_round_number",
                    )
                canonical_round_number = self._canonical_round_for_tick(rounds, tick, event_name)
                if canonical_round_number is None:
                    collector.add(
                        "CANONICAL_ROUND_UNAVAILABLE",
                        f"Event {event_name!r} could not be assigned to a canonical round by boundaries.",
                        field="canonical_round_number",
                        details={"event_type": event_name, "tick": tick},
                    )
                winner_raw = _first(row, "winner")
                winner = _team_side(winner_raw)
                if winner_raw is not None and winner is None:
                    collector.add("WINNER_UNNORMALIZED", "Event winner could not be normalized to T or CT.", field="winner")
                if event_name in {"player_death", "player_hurt"}:
                    actor = self._participant(row, "attacker")
                    target = self._participant(row, "user")
                else:
                    actor = self._participant(row, "user", "player", "attacker")
                    target = None
                world_origin = self._event_world_origin(row, event_name, collector)
                events.append(
                    EventRecord(
                        event_type=event_name,
                        tick=tick,
                        canonical_round_number=canonical_round_number,
                        source_round_number=raw_round,
                        actor=actor,
                        target=target,
                        assister=self._participant(row, "assister"),
                        winner=winner,
                        site=_as_text(_first(row, "site")),
                        weapon=_as_text(_first(row, "weapon")),
                        world_origin=world_origin,
                        details=self._event_details(row),
                    )
                )
        events.sort(key=lambda event: (event.tick, event.event_type))
        return EventsResult(
            parser_version=self.parser_version,
            warnings=collector.values(),
            events=events,
        )

    def read_grenades(
        self,
        path: str | Path,
        *,
        max_rows: int | None = None,
    ) -> GrenadesResult:
        """Normalize demoparser2 0.42 ``parse_grenades`` rows.

        The parser returns both projectile trajectory rows and post-lifecycle
        entity rows whose coordinates are NaN.  We retain both categories at
        this fact boundary; the ReplayBundle reducer later uses only finite
        coordinates for samples and event rows for detonate/expire metadata.
        """

        candidate, parser = self._new_parser(path)
        collector = _WarningCollector()
        if max_rows is not None and (
            isinstance(max_rows, bool) or not isinstance(max_rows, int) or max_rows < 0
        ):
            raise DemoRequestError("max_rows must be a non-negative integer or None.")
        raw_rows = _records(self._call_parser(parser, "parse_grenades", path=candidate))
        rows: list[GrenadeTrajectoryRow] = []
        for ordinal, raw in enumerate(raw_rows):
            grenade_type = _as_text(_first(raw, "grenade_type", "type"))
            if grenade_type is None:
                collector.add(
                    "GRENADE_TYPE_UNAVAILABLE",
                    "A parse_grenades row had no grenade_type and was skipped.",
                    field="grenade_type",
                )
                continue
            entity_id = _as_int(_first(raw, "grenade_entity_id", "entityid", "entity_id"))
            if entity_id is None:
                collector.add(
                    "GRENADE_ENTITY_ID_UNAVAILABLE",
                    "A parse_grenades row had no usable grenade entity ID and was skipped.",
                    field="grenade_entity_id",
                )
                continue
            tick = _as_int(_first(raw, "tick"))
            if tick is None or tick < 0:
                collector.add(
                    "GRENADE_TICK_INVALID",
                    "A parse_grenades row had no usable non-negative tick and was skipped.",
                    field="tick",
                )
                continue

            coordinate_values = [_number(raw.get(field)) for field in ("x", "y", "z")]
            present_coordinates = [
                field for field in ("x", "y", "z") if raw.get(field) is not None
            ]
            world_position: WorldPoint | None = None
            if all(value is not None for value in coordinate_values):
                world_position = WorldPoint(
                    x=coordinate_values[0],
                    y=coordinate_values[1],
                    z=coordinate_values[2],
                )
            elif present_coordinates:
                collector.add(
                    "GRENADE_WORLD_POSITION_INCOMPLETE",
                    "A parse_grenades row exposed an incomplete/non-numeric x/y/z triplet; no sample was emitted.",
                    field="world_position",
                    details={"row_ordinal": ordinal, "present": present_coordinates},
                )

            thrower_id = _player_id(_first(raw, "steamid", "thrower_steamid", "thrower_player_id"))
            thrower_name = _as_text(_first(raw, "name", "thrower_name"))
            rows.append(
                GrenadeTrajectoryRow(
                    grenade_type=grenade_type,
                    grenade_entity_id=entity_id,
                    tick=tick,
                    thrower_player_id=thrower_id,
                    thrower_display_name=thrower_name,
                    world_position=world_position,
                )
            )

        rows.sort(
            key=lambda row: (
                row.tick,
                row.grenade_entity_id,
                row.grenade_type,
                row.thrower_player_id or "",
            )
        )
        if max_rows is not None and len(rows) > max_rows:
            total = len(rows)
            rows = rows[:max_rows]
            collector.add(
                "GRENADE_ROWS_TRUNCATED",
                "Grenade parser rows were truncated by max_rows; no files were written by the adapter.",
                field="grenade_trajectory",
                details={"total_rows": total, "max_rows": max_rows},
            )
        return GrenadesResult(
            parser_version=self.parser_version,
            warnings=collector.values(),
            rows=rows,
            fields=list(GRENADE_FIELDS),
        )

    @staticmethod
    def _normalize_requested_ids(values: Sequence[str] | None) -> list[int] | None:
        if not values:
            return None
        if isinstance(values, str):
            values = [values]
        normalized: list[int] = []
        for value in values:
            player_id = _player_id(value)
            if player_id is None:
                raise DemoRequestError("player_ids must contain non-empty Steam ID values.")
            try:
                normalized.append(int(player_id))
            except ValueError as exc:
                raise DemoRequestError(
                    f"player_ids must contain numeric Steam IDs; got {value!r}."
                ) from exc
        return normalized

    @staticmethod
    def _normalize_requested_ticks(values: Sequence[int] | None) -> list[int] | None:
        if not values:
            return None
        if isinstance(values, int):
            values = [values]
        normalized: list[int] = []
        for value in values:
            tick = _as_int(value)
            if tick is None or tick < 0:
                raise DemoRequestError(f"ticks must contain non-negative integers; got {value!r}.")
            normalized.append(tick)
        return normalized

    def read_trajectory(
        self,
        path: str | Path,
        *,
        player_ids: Sequence[str] | None = None,
        ticks: Sequence[int] | None = None,
        fields: Sequence[str] | None = None,
        max_samples: int | None = None,
    ) -> TrajectoryResult:
        candidate, parser = self._new_parser(path)
        collector = _WarningCollector()
        requested_fields = list(fields or DEFAULT_TRAJECTORY_FIELDS)
        if isinstance(fields, str):
            requested_fields = [fields]
        unknown = [field for field in requested_fields if field not in _TRAJECTORY_FIELD_MAP]
        if unknown:
            raise DemoRequestError(
                f"Unsupported trajectory fields {unknown!r}; supported fields are {sorted(_TRAJECTORY_FIELD_MAP)}."
            )
        requested_fields = list(dict.fromkeys(requested_fields))
        normalized_ids = self._normalize_requested_ids(player_ids)
        normalized_ticks = self._normalize_requested_ticks(ticks)
        if max_samples is not None and (
            isinstance(max_samples, bool)
            or not isinstance(max_samples, int)
            or max_samples < 0
        ):
            raise DemoRequestError("max_samples must be a non-negative integer or None.")

        parser_fields = [
            parser_field
            for field in requested_fields
            if (parser_field := _TRAJECTORY_FIELD_MAP[field]) is not None
        ]
        # ``side`` is a per-row derivation, so team_num is fetched even when
        # callers did not request the team_number output field. PlayerRecord's
        # team is only a player-table summary and is never used as a fallback.
        if "team_num" not in parser_fields:
            parser_fields.append("team_num")
        for field in requested_fields:
            if _TRAJECTORY_FIELD_MAP[field] is None:
                collector.add(
                    "TRAJECTORY_FIELD_UNAVAILABLE",
                    f"demoparser2 0.42.0 exposes no direct trajectory field for {field!r}; values remain null.",
                    field=field,
                )
        rows = _records(
            self._call_parser(
                parser,
                "parse_ticks",
                parser_fields,
                path=candidate,
                players=normalized_ids,
                ticks=normalized_ticks,
            )
        )
        present_fields: set[str] = set()
        for row in rows:
            present_fields.update(row)
        for field in requested_fields:
            parser_field = _TRAJECTORY_FIELD_MAP[field]
            if parser_field is None:
                continue
            if rows and parser_field not in present_fields:
                collector.add(
                    "TRAJECTORY_FIELD_UNAVAILABLE",
                    f"Parser did not return requested trajectory field {field!r}; values remain null.",
                    field=field,
                )

        samples: list[TrajectorySample] = []
        for row in rows:
            player_id = _player_id(_first(row, "steamid", "steam_id", "player_id"))
            if player_id is None:
                collector.add("TRAJECTORY_PLAYER_ID_UNAVAILABLE", "Trajectory row has no usable Steam ID and was skipped.")
                continue
            tick = _required_int(
                _first(row, "tick"),
                collector=collector,
                code="TRAJECTORY_TICK_INVALID",
                field="tick",
            )
            if tick is None:
                continue
            values: dict[str, Any] = {"player_id": player_id, "tick": tick}
            for field in requested_fields:
                parser_field = _TRAJECTORY_FIELD_MAP[field]
                raw = (
                    _first(row, parser_field, "team_number")
                    if field == "team_number" and parser_field is not None
                    else row.get(parser_field) if parser_field is not None else None
                )
                if field in {"inventory_names", "inventory_item_ids"}:
                    normalized = (
                        _string_list(raw)
                        if field == "inventory_names"
                        else _integer_list(raw)
                    )
                    if raw is not None and normalized is None:
                        collector.add(
                            "TRAJECTORY_INVENTORY_INVALID",
                            f"Trajectory field {field!r} was not a list.",
                            field=field,
                        )
                elif field == "inventory_bitmask" or field in {"active_weapon_handle", "money", "bomb_site", "bomb_zone"}:
                    normalized = _as_int(raw)
                    if raw is not None and normalized is None:
                        collector.add("TRAJECTORY_INTEGER_INVALID", f"Trajectory field {field!r} was not an integer.", field=field)
                elif field in {"has_helmet", "has_defuser", "c4_carrier", "bomb_planted", "bomb_dropped"}:
                    normalized = _boolean(raw)
                    if raw is not None and normalized is None:
                        collector.add("TRAJECTORY_BOOLEAN_INVALID", f"Trajectory field {field!r} was not boolean-like.", field=field)
                elif field in {"current_weapon"}:
                    normalized = _as_text(raw)
                elif field == "team_number":
                    normalized = _as_int(raw)
                    if raw is not None and normalized is None:
                        collector.add("TRAJECTORY_TEAM_INVALID", "Trajectory team_number was not an integer.", field=field)
                elif field == "is_alive":
                    normalized = _boolean(raw)
                    if raw is not None and normalized is None:
                        collector.add("TRAJECTORY_ALIVE_INVALID", "Trajectory is_alive was not boolean-like.", field=field)
                else:
                    normalized = _number(raw)
                    if raw is not None and normalized is None:
                        collector.add("TRAJECTORY_VALUE_INVALID", f"Trajectory field {field!r} was not numeric.", field=field)
                values[field] = normalized
            raw_team_number = _first(row, "team_num", "team_number")
            normalized_team_number = _as_int(raw_team_number)
            if raw_team_number is not None and normalized_team_number is None:
                collector.add(
                    "TRAJECTORY_TEAM_INVALID",
                    "Trajectory team_number was not an integer; side remains null.",
                    field="team_number",
                )
            side = _team_side(normalized_team_number)
            if raw_team_number is None:
                collector.add(
                    "TRAJECTORY_SIDE_UNAVAILABLE",
                    "Trajectory row did not expose team_number; side remains null.",
                    field="side",
                )
            elif side is None:
                collector.add(
                    "TRAJECTORY_SIDE_UNAVAILABLE",
                    "Trajectory row team_number was not 2 or 3; side remains null.",
                    field="side",
                    details={"team_number": _clean_value(raw_team_number)},
                )
            values["side"] = side
            samples.append(TrajectorySample(**values))

        if max_samples is not None and len(samples) > max_samples:
            total = len(samples)
            samples = samples[:max_samples]
            collector.add(
                "TRAJECTORY_TRUNCATED",
                "Trajectory result was truncated by max_samples; no samples were written to disk.",
                details={"total_samples": total, "max_samples": max_samples},
            )
        return TrajectoryResult(
            parser_version=self.parser_version,
            warnings=collector.values(),
            samples=samples,
            fields=requested_fields,
        )

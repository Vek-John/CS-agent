"""Build the deterministic parsed Demo ReplayBundle and its derived MVP data.

Parser rows remain ground-truth facts.  ObservableState, teaching signals,
and ReviewPlan are generated in separate deterministic passes with their own
canonical-range and future-information checks.
"""

from __future__ import annotations

import argparse
import gzip
import hashlib
import json
import time
from collections import Counter
from pathlib import Path
from typing import Any

from .adapter import FULL_STATE_FIELDS, DemoParserAdapter
from .errors import DemoParseError, DemoRequestError
from .grenades import GRENADE_SAMPLING_STRATEGY, build_grenade_tracks
from .inspect_demo import inspect_demo, validate_demo_file
from .models import EventRecord, GrenadesResult, ParseWarning, RoundRecord, TeamSide, TrajectorySample, WorldPoint
from .observation import OBSERVATION_VERSION, build_observable_states
from .replay_models import (
    EventCoverageEntry,
    FieldCoverage,
    FieldCoverageEntry,
    GenerationManifest,
    GrenadeCoverage,
    ReplayActiveItem,
    ReplayBundle,
    ReplayEvent,
    ReplayInventoryEntry,
    ReplayMatchPlayer,
    ReplayMatchTimeline,
    ReplayPlayerStateSample,
    ReplayRoundTimeline,
)
from .review_planner import PLANNER_VERSION, build_review_plan
from .teaching_signals import SIGNAL_VERSION, detect_teaching_signals


BUILDER_VERSION = "0.6.0"
DEFAULT_SAMPLING_STRIDE_TICKS = 24
DEFAULT_TICK_RATE = 64.0

# Keep this list explicit.  It is the parser-event allowlist for the first
# browser bundle, not a coaching taxonomy.  ``read_events`` still maps any
# unexpected requested event to OTHER.
EVENT_NAMES = (
    "round_start",
    "round_freeze_end",
    "round_end",
    "round_officially_ended",
    "player_spawn",
    "player_death",
    "player_hurt",
    "player_footstep",
    "weapon_fire",
    "fire_bullets",
    "weapon_reload",
    "item_pickup",
    "item_equip",
    "player_blind",
    "hegrenade_detonate",
    "flashbang_detonate",
    "smokegrenade_detonate",
    "smokegrenade_expired",
    "inferno_startburn",
    "inferno_expire",
    "bomb_beginplant",
    "bomb_planted",
    "bomb_pickup",
    "bomb_dropped",
    "bomb_begindefuse",
    "bomb_defused",
    "bomb_exploded",
)

_EVENT_TYPE_MAP = {
    "round_start": "ROUND_START",
    "round_freeze_end": "OTHER",
    "round_end": "ROUND_END",
    "round_officially_ended": "ROUND_END",
    "player_spawn": "PLAYER_SPAWN",
    "player_death": "PLAYER_DEATH",
    "player_hurt": "DAMAGE",
    "player_footstep": "FOOTSTEP",
    "player_sound": "FOOTSTEP",
    "footstep": "FOOTSTEP",
    "weapon_fire": "WEAPON_FIRE",
    "fire_bullets": "GUNSHOT",
    "weapon_reload": "RELOAD",
    "item_pickup": "ITEM_PICKUP",
    "item_drop": "ITEM_DROP",
    "item_equip": "OTHER",
    "player_blind": "UTILITY",
    "grenade_throw": "GRENADE_THROW",
    "hegrenade_detonate": "GRENADE_DETONATE",
    "flashbang_detonate": "GRENADE_DETONATE",
    "smokegrenade_detonate": "GRENADE_DETONATE",
    "smokegrenade_expired": "UTILITY",
    "inferno_startburn": "UTILITY",
    "inferno_expire": "UTILITY",
    "bomb_beginplant": "BOMB_PLANT",
    "bomb_planted": "BOMB_PLANT",
    "bomb_pickup": "BOMB_PICKUP",
    "bomb_dropped": "BOMB_DROP",
    "bomb_begindefuse": "BOMB_DEFUSE",
    "bomb_defused": "BOMB_DEFUSE",
    "bomb_exploded": "OTHER",
}

# demoparser2's display names are direct parser facts, but the browser
# contract expects canonical item IDs.  Keeping these IDs short is also
# important for a flat 16-tick bundle: the same item is repeated many times.
_ITEM_ID_ALIASES = {
    "ak-47": "weapon_ak47",
    "ak 47": "weapon_ak47",
    "knife": "weapon_knife",
    "knife_t": "weapon_knife_t",
    "bowie knife": "weapon_knife_survival_bowie",
    "huntsman knife": "weapon_knife_tactical",
    "m9 bayonet": "weapon_knife_m9_bayonet",
    "c4 explosive": "weapon_c4",
    "glock-18": "weapon_glock",
    "p2000": "weapon_hkp2000",
    "usp-s": "weapon_usp_silencer",
    "m4a4": "weapon_m4a1",
    "m4a1-s": "weapon_m4a1_silencer",
    "mac-10": "weapon_mac10",
    "ssg 08": "weapon_ssg08",
    "cz75-auto": "weapon_cz75a",
    "r8 revolver": "weapon_revolver",
    "five-seven": "weapon_fiveseven",
    "desert eagle": "weapon_deagle",
    "high explosive grenade": "weapon_hegrenade",
    "smoke grenade": "weapon_smokegrenade",
    "flashbang": "weapon_flashbang",
    "incendiary grenade": "weapon_incgrenade",
    "molotov cocktail": "weapon_molotov",
    "decoy grenade": "weapon_decoy",
}


def _canonical_item_id(item_name: str) -> str:
    """Map a parser display name to a stable, compact item ID."""

    normalized = " ".join(item_name.strip().lower().replace("_", " ").split())
    if normalized in _ITEM_ID_ALIASES:
        return _ITEM_ID_ALIASES[normalized]
    if normalized.startswith("weapon "):
        normalized = normalized[len("weapon ") :]
    compact = "_".join(part for part in normalized.replace("-", " ").split() if part)
    return f"weapon_{compact}" if compact else "weapon_unknown"


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _warning(
    code: str,
    message: str,
    *,
    field: str | None = None,
    details: dict[str, Any] | None = None,
) -> ParseWarning:
    return ParseWarning(code=code, message=message, field=field, details=details or {})


def _dedupe_warnings(warnings: list[ParseWarning]) -> list[ParseWarning]:
    result: list[ParseWarning] = []
    seen: set[str] = set()
    for warning in warnings:
        key = json.dumps(warning.model_dump(mode="json"), sort_keys=True, separators=(",", ":"))
        if key not in seen:
            seen.add(key)
            result.append(warning)
    return result


def _round_boundary_ticks(rounds: list[RoundRecord]) -> set[int]:
    ticks: set[int] = set()
    for item in rounds:
        ticks.add(item.start_tick)
        if item.freeze_end_tick is not None:
            ticks.add(item.freeze_end_tick)
        if item.end_tick is not None:
            ticks.add(item.end_tick)
    return ticks


def _state_ticks(rounds: list[RoundRecord], stride: int) -> list[int]:
    """Return a bounded deterministic sampling grid plus round boundaries.

    Event ticks are intentionally not added in this first bundle.  The
    manifest records that limitation; the canonical event list remains
    complete and is independently indexed by its own ticks.
    """

    if stride < 1:
        raise DemoRequestError("sampling_stride_ticks must be a positive integer")
    start_tick = min((item.start_tick for item in rounds), default=0)
    complete_ends = [item.end_tick for item in rounds if item.end_tick is not None]
    end_tick = max(complete_ends, default=start_tick)
    ticks = set(range(start_tick, end_tick + 1, stride))
    ticks.update(_round_boundary_ticks(rounds))
    return sorted(tick for tick in ticks if start_tick <= tick <= end_tick)


def _item_class(item_name: str) -> str:
    lowered = item_name.strip().lower()
    if "c4" in lowered or "bomb" in lowered:
        return "c4"
    if "knife" in lowered:
        return "knife"
    if any(token in lowered for token in ("grenade", "molotov", "incendiary", "flashbang", "smoke", "decoy")):
        return "grenade"
    if any(token in lowered for token in ("ak47", "m4a", "awp", "ssg", "scar", "g3sg1", "galil", "famas", "aug", "sg556")):
        return "rifle"
    if any(token in lowered for token in ("mp", "mac10", "p90", "ump", "bizon", "mp5")):
        return "smg"
    if any(token in lowered for token in ("nova", "xm1014", "mag7", "sawedoff")):
        return "shotgun"
    if any(token in lowered for token in ("deagle", "glock", "usp", "p250", "five-seven", "tec-9", "cz75", "dual")):
        return "pistol"
    return "weapon"


def _world_position(sample: TrajectorySample) -> WorldPoint | None:
    if sample.x is None or sample.y is None or sample.z is None:
        return None
    return WorldPoint(x=sample.x, y=sample.y, z=sample.z)


def _inventory_items(sample: TrajectorySample) -> list[ReplayInventoryEntry]:
    """Adapt direct parser inventory names/IDs with the required fallback.

    demoparser2 exposes membership but not per-item quantities.  The browser
    contract requires a count, so each observed entry gets count=1; the
    global coverage/manifest records that quantities are unavailable.
    """

    if sample.inventory_names is not None:
        return [
            ReplayInventoryEntry(item_id=_canonical_item_id(name), item_class=_item_class(name), count=1)
            for name in sample.inventory_names
            if name.strip()
        ]
    if sample.inventory_item_ids is not None:
        return [
            ReplayInventoryEntry(item_id=str(item_id), item_class="weapon", count=1)
            for item_id in sample.inventory_item_ids
        ]
    return []


def _contains_c4(names: list[str] | None) -> bool:
    # This deliberately accepts only the direct inventory_names fact.  IDs,
    # distance, bomb events, and current weapon are not carrier inference.
    return bool(names and any("c4" in name.lower() for name in names))


def _build_state_sample(
    sample: TrajectorySample,
    *,
    player_ordinals: dict[str, int],
    warnings: list[ParseWarning],
) -> ReplayPlayerStateSample | None:
    required = {
        "side": sample.side,
        "world_position": _world_position(sample),
        "yaw": sample.yaw,
        "pitch": sample.pitch,
        "alive": sample.is_alive,
        "health": sample.health,
        "armor": sample.armor,
        "has_helmet": sample.has_helmet,
    }
    missing_required = [name for name, value in required.items() if value is None]
    if missing_required:
        warnings.append(
            _warning(
                "REPLAY_SAMPLE_REQUIRED_FIELD_MISSING",
                "A parser trajectory row was omitted because a required PlayerStateSample field was unavailable.",
                field="player_state_tracks",
                details={"player_id": sample.player_id, "tick": sample.tick, "fields": missing_required},
            )
        )
        return None

    missing_fields: list[str] = []
    active_item = None
    if sample.current_weapon:
        active_item = ReplayActiveItem(
            item_id=_canonical_item_id(sample.current_weapon),
            item_class=_item_class(sample.current_weapon),
        )
    else:
        missing_fields.append("active_item")
    if sample.money is None:
        missing_fields.append("money")

    inventory = _inventory_items(sample)
    if sample.inventory_names is None and sample.inventory_item_ids is None:
        missing_fields.append("inventory")

    carries_c4: bool | None = True if _contains_c4(sample.inventory_names) else None
    if carries_c4 is None:
        missing_fields.append("carries_c4")
    if sample.has_defuser is None:
        missing_fields.append("has_defuse_kit")

    return ReplayPlayerStateSample(
        player_id=sample.player_id,
        tick=sample.tick,
        side=required["side"],
        world_position=required["world_position"],
        yaw=required["yaw"],
        pitch=required["pitch"],
        alive=required["alive"],
        health=required["health"],
        armor=required["armor"],
        has_helmet=required["has_helmet"],
        money=sample.money,
        active_item=active_item,
        inventory=inventory,
        has_defuse_kit=sample.has_defuser,
        carries_c4=carries_c4,
        fact_refs=[f"ps:{player_ordinals.get(sample.player_id, 0)}:{sample.tick}"],
        missing_fields=missing_fields,
    )


def _event_item_id(event: EventRecord) -> str | None:
    if event.weapon:
        return _canonical_item_id(event.weapon)
    value = event.details.get("item_name", event.details.get("item"))
    return _canonical_item_id(str(value)) if value is not None else None


def _event_payload(event: EventRecord) -> dict[str, Any]:
    payload: dict[str, Any] = {}
    if event.winner is not None:
        payload["winner"] = event.winner.value
    if event.site is not None:
        payload["site"] = event.site

    # Keep direct, useful event facts while dropping parser bookkeeping and
    # duplicate coordinates.  The complete event row is still represented by
    # its actor/target/item/world_origin/source_parser_event fields.
    common = {
        "damage_health",
        "damage_armor",
        "health_after",
        "armor_after",
        "hit_group",
        "headshot",
        "through_smoke",
        "assisted_flash",
        "attacker_blind",
        "attacker_in_air",
        "no_scope",
        "penetrated",
        "distance",
        "sound_type",
        "silenced",
        "item",
        "weptype",
        "entityid",
    }
    bullet = {
        "item_def_index",
        "weapon_id",
        "attack_type",
        "mode",
        "angles_x",
        "angles_y",
        "num_bullets_remaining",
        "inaccuracy",
        "spread",
        "recoil_index",
    }
    allowed = common | (bullet if event.event_type == "fire_bullets" else set())
    for key in sorted(allowed):
        value = event.details.get(key)
        if value not in (None, ""):
            payload[key] = value
    return payload


def _event_model(event: EventRecord, ordinal: int) -> ReplayEvent:
    missing_fields: list[str] = []
    if event.world_origin is None:
        missing_fields.append("world_origin")
    return ReplayEvent(
        id=f"e:{ordinal}",
        event_type=_EVENT_TYPE_MAP.get(event.event_type, "OTHER"),
        tick=event.tick,
        actor_player_id=event.actor.player_id if event.actor else None,
        target_player_id=event.target.player_id if event.target else None,
        world_origin=event.world_origin,
        item_id=_event_item_id(event),
        payload=_event_payload(event),
        source_parser_event=event.event_type,
        fact_confidence=1.0,
        fact_refs=[f"e:{ordinal}"],
        missing_fields=missing_fields,
    )


def _build_round_timelines(
    rounds: list[RoundRecord],
    *,
    warnings: list[ParseWarning],
) -> list[ReplayRoundTimeline]:
    result: list[ReplayRoundTimeline] = []
    score_t = 0
    score_ct = 0
    for item in rounds:
        if item.end_tick is None or item.winner is None:
            raise DemoParseError(
                f"Round {item.canonical_round_number} lacks required end_tick or winner facts."
            )
        freeze_end_tick = item.freeze_end_tick
        if freeze_end_tick is None:
            # The final fixture round ends with no parser freeze-end row.  The
            # loader requires a number, so use the parsed round_start as a
            # lower-bound fallback and make the limitation explicit.
            freeze_end_tick = item.start_tick
            warnings.append(
                _warning(
                    "REPLAY_FREEZE_END_FALLBACK",
                    "round_freeze_end was unavailable; freeze_end_tick uses the parsed round_start lower bound.",
                    field="match_timeline.rounds.freeze_end_tick",
                    details={"round_number": item.canonical_round_number, "fallback_tick": item.start_tick},
                )
            )
        before = (score_t, score_ct)
        if item.winner == TeamSide.T:
            score_t += 1
        else:
            score_ct += 1
        result.append(
            ReplayRoundTimeline(
                round_number=item.canonical_round_number,
                start_tick=item.start_tick,
                freeze_end_tick=freeze_end_tick,
                end_tick=item.end_tick,
                score_before=before,
                score_after=(score_t, score_ct),
                winner=item.winner,
            )
        )
    return result


def _build_coverage(
    state_samples: list[ReplayPlayerStateSample],
    parser_events: list[EventRecord],
    *,
    grenade_coverage=None,
) -> FieldCoverage:
    total = len(state_samples)

    def available(field: str) -> int:
        return sum(1 for item in state_samples if getattr(item, field) is not None)

    trajectory_fields = (
        "world_position",
        "side",
        "yaw",
        "pitch",
        "alive",
        "health",
        "armor",
        "has_helmet",
        "money",
        "active_item",
        "inventory",
        "has_defuse_kit",
        "carries_c4",
    )
    trajectory: dict[str, FieldCoverageEntry] = {}
    for field in trajectory_fields:
        if field == "inventory":
            count = sum(1 for item in state_samples if item.inventory)
            source = "PARSER_NAMES_IDS_COUNT_FALLBACK_1"
            limitations = ["parser did not expose per-item quantities; each direct entry is emitted as count=1"]
        elif field == "carries_c4":
            count = available(field)
            source = "PARSER_INVENTORY_NAMES_DIRECT"
            limitations = ["false/unknown states omit carries_c4 and record it in missing_fields"]
        else:
            count = available(field)
            source = "PARSER_DIRECT"
            limitations = []
        trajectory[field] = FieldCoverageEntry(
            available_count=count,
            total_count=total,
            ratio=(count / total if total else 0.0),
            source=source,
            limitations=limitations,
        )

    event_counts = Counter(event.event_type for event in parser_events)
    direct_origin_counts = Counter(event.event_type for event in parser_events if event.world_origin is not None)
    events = {
        event_name: EventCoverageEntry(
            count=event_counts.get(event_name, 0),
            direct_world_origin_count=direct_origin_counts.get(event_name, 0),
            joined_world_origin_count=0,
            source="PARSER_ADAPTER_DIRECT_EVENT_FIELDS",
            limitations=(
                []
                if direct_origin_counts.get(event_name, 0)
                else ["direct event world_origin unavailable for rows observed"]
            ),
        )
        for event_name in EVENT_NAMES
    }
    if grenade_coverage is None:
        from .replay_models import GrenadeCoverage

        grenade_coverage = GrenadeCoverage(
            input_rows=0,
            canonical_rows=0,
            valid_position_rows=0,
            lifecycle_event_rows=0,
            output_tracks=0,
            output_samples=0,
            retained_ratio=0.0,
            source="NOT_REQUESTED",
            limitations=["grenade trajectory was not requested by the adapter"],
        )
    return FieldCoverage(
        trajectory=trajectory,
        events=events,
        grenades=grenade_coverage,
    )


def build_replay_bundle(
    input_path: str | Path,
    *,
    sampling_stride_ticks: int = DEFAULT_SAMPLING_STRIDE_TICKS,
    selected_player_id: str | None = None,
    parser: DemoParserAdapter | None = None,
) -> ReplayBundle:
    source = Path(input_path).expanduser().resolve()
    adapter = parser or DemoParserAdapter()
    metadata = adapter.inspect(source)
    players_result = adapter.read_players(source)
    rounds_result = adapter.read_rounds(source)
    events_result = adapter.read_events(source, EVENT_NAMES)
    rounds = rounds_result.rounds
    if not rounds:
        raise DemoParseError("Cannot build ReplayBundle without canonical rounds.", path=str(source))
    if not players_result.players:
        raise DemoParseError("Cannot build ReplayBundle without players.", path=str(source))

    source_sha256 = _sha256(source)
    bundle_id = f"replay:{source_sha256[:16]}:v1"
    selected = selected_player_id if selected_player_id is not None else players_result.players[0].player_id
    if not selected.strip():
        raise DemoRequestError("selected_player_id must be a non-empty player ID when provided.")
    if selected not in {player.player_id for player in players_result.players}:
        raise DemoRequestError(f"selected_player_id is not present in the Demo: {selected}")

    parser_events = events_result.events
    read_grenades = getattr(adapter, "read_grenades", None)
    if callable(read_grenades):
        grenades_result: GrenadesResult = read_grenades(source)
    else:
        grenades_result = GrenadesResult(
            parser_version=metadata.parser_version,
            rows=[],
            warnings=[
                _warning(
                    "GRENADE_TRAJECTORY_UNAVAILABLE",
                    "The configured parser adapter does not expose read_grenades; grenade_tracks remains empty.",
                    field="grenade_tracks",
                )
            ],
            fields=[],
        )
    boundary_ticks = _round_boundary_ticks(rounds)
    ticks = _state_ticks(rounds, sampling_stride_ticks)
    trajectory = adapter.read_trajectory(source, ticks=ticks, fields=FULL_STATE_FIELDS)

    warnings = list(metadata.warnings) + list(players_result.warnings) + list(rounds_result.warnings)
    warnings.extend(events_result.warnings)
    warnings.extend(grenades_result.warnings)
    warnings.extend(trajectory.warnings)
    warnings.extend(
        [
            _warning(
                "REPLAY_INVENTORY_QUANTITIES_FALLBACK",
                "Inventory membership comes from direct parser names/IDs; each entry uses count=1 because quantities are unavailable.",
                field="inventory_quantities",
            ),
            _warning(
                "REPLAY_C4_DIRECT_NAME_ONLY",
                "carries_c4 is emitted only when direct inventory_names contains C4; no distance or event inference is used.",
                field="carries_c4",
            ),
            _warning(
                "REPLAY_TICK_RATE_BASELINE",
                "The parser header did not expose tick_rate; the CS2 baseline 64.0 is recorded with this limitation.",
                field="tick_rate",
            ),
            _warning(
                "REPLAY_EVENT_TICKS_NOT_FORCED",
                f"State sampling uses a {sampling_stride_ticks}-tick grid plus parsed round boundaries; event ticks remain in events but are not forced into state samples.",
                field="player_state_tracks",
            ),
        ]
    )

    state_samples: list[ReplayPlayerStateSample] = []
    player_ordinals = {
        player.player_id: ordinal
        for ordinal, player in enumerate(players_result.players, start=1)
    }
    for sample in trajectory.samples:
        built = _build_state_sample(sample, player_ordinals=player_ordinals, warnings=warnings)
        if built is not None:
            state_samples.append(built)
    state_samples.sort(key=lambda item: (item.tick, item.player_id))

    observed_side_by_player: dict[str, TeamSide] = {}
    for item in state_samples:
        observed_side_by_player.setdefault(item.player_id, item.side)
    replay_players: list[ReplayMatchPlayer] = []
    for player in players_result.players:
        side = player.team or observed_side_by_player.get(player.player_id)
        if side is None:
            side = TeamSide.T
            warnings.append(
                _warning(
                    "REPLAY_PLAYER_SIDE_FALLBACK",
                    "No parser side was available for the MatchTimeline player summary; T is a schema fallback only.",
                    field="match_timeline.players.side",
                    details={"player_id": player.player_id},
                )
            )
        replay_players.append(
            ReplayMatchPlayer(
                player_id=player.player_id,
                display_name=player.display_name or player.player_id,
                side=side,
                is_selected=player.player_id == selected,
            )
        )

    round_timelines = _build_round_timelines(rounds, warnings=warnings)
    match_start = min(item.start_tick for item in rounds)
    match_end = max(item.end_tick for item in rounds if item.end_tick is not None)
    match_timeline = ReplayMatchTimeline(
        id=bundle_id,
        demo_id=source_sha256,
        source_kind="PARSED_DEMO",
        map_name=metadata.map_name or "de_mirage",
        tick_rate=DEFAULT_TICK_RATE,
        start_tick=match_start,
        end_tick=match_end,
        selected_player_id=selected,
        players=replay_players,
        tracks=[],
        rounds=round_timelines,
        timeline_version="replay-bundle.v1",
    )
    replay_events = [_event_model(event, ordinal) for ordinal, event in enumerate(parser_events, start=1)]
    outside_events = [
        event
        for event in replay_events
        if not (match_start <= event.tick < match_end)
    ]
    if outside_events:
        warnings.append(
            _warning(
                "REPLAY_EVENT_OUTSIDE_CANONICAL_RANGE",
                "Raw parser events outside [match_timeline.start_tick, match_timeline.end_tick) are retained as facts but excluded from analysis products.",
                field="events",
                details={
                    "count": len(outside_events),
                    "event_ids": [event.id for event in outside_events[:32]],
                    "ticks": [event.tick for event in outside_events[:32]],
                    "canonical_range": [match_start, match_end],
                },
            )
        )
    grenade_build = build_grenade_tracks(
        timeline=match_timeline,
        rows=grenades_result.rows,
        events=replay_events,
    )
    warnings.extend(grenade_build.warnings)
    coverage = _build_coverage(
        state_samples,
        parser_events,
        grenade_coverage=grenade_build.coverage,
    )
    signals = detect_teaching_signals(
        timeline=match_timeline,
        selected_player_id=selected,
        events=replay_events,
        warnings=warnings,
    )
    checkpoint_ticks = {
        round_timeline.freeze_end_tick
        for round_timeline in round_timelines
        if match_start <= round_timeline.freeze_end_tick < match_end
    }
    checkpoint_ticks.update(signal.decision_tick for signal in signals)
    checkpoint_ticks.update(signal.event_tick for signal in signals)
    observable_states = build_observable_states(
        timeline=match_timeline,
        observer_player_id=selected,
        state_samples=state_samples,
        events=replay_events,
        checkpoint_ticks=checkpoint_ticks,
        warnings=warnings,
    )
    review_plan = build_review_plan(
        timeline=match_timeline,
        selected_player_id=selected,
        state_samples=state_samples,
        events=replay_events,
        observable_states=observable_states,
        signals=signals,
        parser_version=metadata.parser_version,
        analysis_subject_selection=(
            "EXPLICIT_PLAYER" if selected_player_id is not None else "FIRST_TIMELINE_PLAYER_DEFAULT"
        ),
    )
    limitations = [
        f"player_state_tracks uses a {sampling_stride_ticks}-tick grid plus parsed round boundary ticks; it is not lossless full-tick state",
        "event ticks remain in events but are not forced into state samples in this first minimal bundle",
        "grenade tracks use demoparser2 parse_grenades rows plus matched detonate/expire events; rows without finite coordinates are not emitted as samples",
        "inventory quantities are unavailable; direct inventory entries use count=1 and the limitation is recorded in coverage and generation_manifest",
        "carries_c4 is emitted only for direct inventory_names containing C4; otherwise it is omitted with missing_fields",
        "tick_rate is recorded as the CS2 64.0 baseline because the parser header does not expose it",
        "parser lacks observer-scoped spotted/visibility and team-share facts; no hidden enemy coordinates are emitted",
        "sound claims are only POSSIBLY_AUDIBLE from observer/actor state joins and conservative distance gates; occlusion and simultaneous noise are not modeled",
        "utility/bomb hidden ground-truth positions are not converted into uncertain observer claims without observable evidence",
        "ReviewPlan is a deterministic rule-based MVP with contact-survival review opportunities; death does not prove a bad decision",
        (
            "analysis subject was explicitly selected by the user; this bundle does not claim all-player coaching support"
            if selected_player_id is not None
            else "analysis subject defaults to the first timeline player; this bundle does not claim all-player coaching support"
        ),
    ]
    manifest = GenerationManifest(
        builder_version=BUILDER_VERSION,
        parser_version=metadata.parser_version,
        deterministic=True,
        sampling_stride_ticks=sampling_stride_ticks,
        trajectory_sampling_strategy=f"every {sampling_stride_ticks} ticks plus parsed round boundary ticks",
        preserved_round_boundary_ticks=len(boundary_ticks),
        preserved_event_ticks=0,
        grenade_sampling_strategy=GRENADE_SAMPLING_STRATEGY,
        source_sha256=source_sha256,
        source_size_bytes=source.stat().st_size,
        observation_version=OBSERVATION_VERSION,
        signal_version=SIGNAL_VERSION,
        planner_version=PLANNER_VERSION,
        analysis_subject_selection=(
            "EXPLICIT_PLAYER" if selected_player_id is not None else "FIRST_TIMELINE_PLAYER_DEFAULT"
        ),
        analysis_subject_player_id=selected,
        limitations=limitations,
    )
    return ReplayBundle(
        bundle_id=bundle_id,
        schema_version="replay-bundle.v1",
        match_timeline=match_timeline,
        player_state_tracks=state_samples,
        events=replay_events,
        grenade_tracks=grenade_build.tracks,
        observable_states=observable_states,
        review_plan=review_plan,
        coverage=coverage,
        warnings=_dedupe_warnings(warnings),
        generation_manifest=manifest,
    )


def _compact_json_value(value: Any) -> Any:
    """Make numeric JSON deterministic and compact without losing replay facts."""

    if isinstance(value, float):
        rounded = round(value, 3)
        return int(rounded) if rounded.is_integer() else rounded
    if isinstance(value, list):
        return [_compact_json_value(item) for item in value]
    if isinstance(value, dict):
        return {key: _compact_json_value(item) for key, item in value.items()}
    return value


def _bundle_payload(bundle: ReplayBundle) -> dict[str, Any]:
    # Optional TS fields are absent when the parser did not provide them.  Use
    # aliases so the Python ``from_`` field remains the JSON ``from`` key.
    payload = _compact_json_value(bundle.model_dump(mode="json", by_alias=True, exclude_none=True))
    # Keep the active-item slot visible on every flat sample.  A null value is
    # an honest parser-unavailable state, while inventory remains an array on
    # every sample.  This preserves the browser HUD's equipment boundary
    # without repeating unavailable money/defuser/C4 fields.
    for sample in payload.get("player_state_tracks", []):
        if isinstance(sample, dict):
            sample.setdefault("active_item", None)
    # The worker model keeps ``samples`` as its descriptive Python field, but
    # the cross-end ReplayBundle boundary is explicitly ``id``/``item_id``/
    # ``points``.  Serialize the stable browser shape once instead of making
    # the renderer guess aliases or carrying duplicate point arrays.
    for track in payload.get("grenade_tracks", []):
        if isinstance(track, dict):
            if "id" not in track and "track_id" in track:
                track["id"] = track["track_id"]
            if "points" not in track and "samples" in track:
                track["points"] = track["samples"]
            track.pop("samples", None)
    return payload


def write_replay_bundle(bundle: ReplayBundle, output_path: str | Path) -> Path:
    output = Path(output_path).expanduser().resolve()
    output.parent.mkdir(parents=True, exist_ok=True)
    encoded = json.dumps(
        _bundle_payload(bundle),
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
    )
    output.write_text(encoded + "\n", encoding="utf-8")
    return output


def _build_cli() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Build a deterministic CS2 PARSED_DEMO ReplayBundle JSON.")
    parser.add_argument("input", type=Path, help="input .dem path")
    parser.add_argument("output", type=Path, nargs="?", help="output ReplayBundle .json path")
    parser.add_argument("--sampling-stride-ticks", type=int, default=DEFAULT_SAMPLING_STRIDE_TICKS)
    parser.add_argument("--selected-player-id", default=None)
    parser.add_argument(
        "--max-input-bytes",
        type=int,
        default=512 * 1024 * 1024,
        help="safety limit for one local .dem input (default: 512 MiB)",
    )
    parser.add_argument(
        "--list-players",
        action="store_true",
        help="validate the Demo and print selectable player metadata without building a bundle",
    )
    return parser


def main(argv: list[str] | None = None) -> int:
    args = _build_cli().parse_args(argv)
    started = time.perf_counter()
    source = validate_demo_file(args.input, max_bytes=args.max_input_bytes)
    if args.list_players:
        print(json.dumps(inspect_demo(source, max_bytes=args.max_input_bytes), ensure_ascii=False, sort_keys=True))
        return 0
    if args.output is None:
        raise SystemExit("output is required unless --list-players is used")
    output = args.output.expanduser().resolve()
    if output.suffix.lower() != ".json":
        raise SystemExit("output must use the .json extension")
    if output == source:
        raise SystemExit("output JSON path must not overwrite the input .dem")
    bundle = build_replay_bundle(
        source,
        sampling_stride_ticks=args.sampling_stride_ticks,
        selected_player_id=args.selected_player_id,
    )
    output = write_replay_bundle(bundle, output)
    encoded = output.read_bytes()
    print(
        json.dumps(
            {
                "path": str(output),
                "bytes": len(encoded),
                "gzip_bytes": len(gzip.compress(encoded, mtime=0)),
                "sha256": hashlib.sha256(encoded).hexdigest(),
                "source_sha256": bundle.generation_manifest.source_sha256,
                "elapsed_seconds": round(time.perf_counter() - started, 3),
                "rounds": len(bundle.match_timeline.rounds),
                "players": len(bundle.match_timeline.players),
                "player_state_samples": len(bundle.player_state_tracks),
                "events": len(bundle.events),
                "grenade_tracks": len(bundle.grenade_tracks),
                "observable_states": len(bundle.observable_states),
                "review_segments": len(bundle.review_plan.segments) if bundle.review_plan else 0,
                "review_cues": len(bundle.review_plan.cues) if bundle.review_plan else 0,
                "narration_provider": bundle.review_plan.generation_manifest.provider if bundle.review_plan else None,
                "narration_status": bundle.review_plan.generation_manifest.status if bundle.review_plan else None,
                "warnings": len(bundle.warnings),
            },
            ensure_ascii=False,
            sort_keys=True,
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

"""Deterministic reduction of demoparser2 grenade facts into replay tracks.

``DemoParser.parse_grenades`` returns a large row stream.  Entity IDs are
reused in a Demo, so a track is a contiguous run of finite projectile
positions with the same parser type and thrower.  Detonation/expiry ticks are
joined only from parser lifecycle events (preferably by entity ID; inferno
events use the parser's actor plus the adjacent projectile run).  No landing
point or terminal position is invented.
"""

from __future__ import annotations

import math
from dataclasses import dataclass
from typing import Iterable

from .models import GrenadeTrajectoryRow, ParseWarning, WorldPoint
from .replay_models import (
    GrenadeCoverage,
    GrenadeSample,
    GrenadeTrack,
    ReplayEvent,
    ReplayMatchTimeline,
)


GRENADE_SAMPLING_STRATEGY = "lifecycle+start/end+stride_8+turns"
GRENADE_SAMPLE_STRIDE_TICKS = 8
GRENADE_SEGMENT_MAX_GAP_TICKS = 2
GRENADE_TURN_THRESHOLD_DEGREES = 18.0
GRENADE_LIFECYCLE_LOOKAHEAD_TICKS = 2048

_EVENT_KIND = {
    "hegrenade_detonate": "HE_GRENADE",
    "flashbang_detonate": "FLASHBANG",
    "smokegrenade_detonate": "SMOKE",
    "smokegrenade_expired": "SMOKE",
    "inferno_startburn": "MOLOTOV",
    "inferno_expire": "MOLOTOV",
}

_ITEM_ID_BY_TYPE = {
    "HE_GRENADE": "weapon_hegrenade",
    "FLASHBANG": "weapon_flashbang",
    "SMOKE": "weapon_smokegrenade",
    "MOLOTOV": "weapon_molotov",
    "INCENDIARY": "weapon_incgrenade",
    "DECOY": "weapon_decoy",
}


@dataclass(frozen=True)
class _GrenadeRun:
    entity_id: int
    parser_type: str
    grenade_type: str
    thrower_player_id: str | None
    thrower_display_name: str | None
    rows: tuple[GrenadeTrajectoryRow, ...]

    @property
    def start_tick(self) -> int:
        return self.rows[0].tick

    @property
    def last_sample_tick(self) -> int:
        return self.rows[-1].tick


@dataclass(frozen=True)
class GrenadeBuildResult:
    tracks: list[GrenadeTrack]
    coverage: GrenadeCoverage
    warnings: list[ParseWarning]


def _warning(
    code: str,
    message: str,
    *,
    field: str | None = None,
    details: dict[str, object] | None = None,
) -> ParseWarning:
    return ParseWarning(code=code, message=message, field=field, details=details or {})


def _grenade_type(parser_type: str) -> str:
    value = parser_type.lower()
    if "flash" in value:
        return "FLASHBANG"
    if "hegrenade" in value or value.startswith("che"):
        return "HE_GRENADE"
    if "smoke" in value:
        return "SMOKE"
    if "incendiary" in value:
        return "INCENDIARY"
    if "molotov" in value or "inferno" in value:
        return "MOLOTOV"
    if "decoy" in value:
        return "DECOY"
    return "UNKNOWN"


def _event_kind(event: ReplayEvent) -> str | None:
    return _EVENT_KIND.get(event.source_parser_event)


def _event_entity_id(event: ReplayEvent) -> int | None:
    value = event.payload.get("entityid", event.payload.get("entity_id"))
    if isinstance(value, bool) or value is None:
        return None
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


def _event_refs(event: ReplayEvent) -> list[str]:
    return list(event.fact_refs or [event.id])


def _round_number(timeline: ReplayMatchTimeline, tick: int) -> int | None:
    for round_timeline in timeline.rounds:
        if round_timeline.start_tick <= tick < round_timeline.end_tick:
            return round_timeline.round_number
    return None


def _finite_rows(rows: Iterable[GrenadeTrajectoryRow]) -> list[GrenadeTrajectoryRow]:
    result: list[GrenadeTrajectoryRow] = []
    for row in rows:
        point = row.world_position
        if point is None:
            continue
        if all(math.isfinite(value) for value in (point.x, point.y, point.z)):
            result.append(row)
    return result


def _build_runs(rows: Iterable[GrenadeTrajectoryRow]) -> list[_GrenadeRun]:
    grouped: dict[tuple[int, str, str | None, str | None], list[GrenadeTrajectoryRow]] = {}
    for row in _finite_rows(rows):
        key = (
            row.grenade_entity_id,
            row.grenade_type,
            row.thrower_player_id,
            row.thrower_display_name,
        )
        grouped.setdefault(key, []).append(row)

    runs: list[_GrenadeRun] = []
    for (entity_id, parser_type, thrower_id, thrower_name), group in grouped.items():
        group.sort(key=lambda row: row.tick)
        current: list[GrenadeTrajectoryRow] = []
        for row in group:
            if current and row.tick - current[-1].tick > GRENADE_SEGMENT_MAX_GAP_TICKS:
                runs.append(
                    _GrenadeRun(
                        entity_id=entity_id,
                        parser_type=parser_type,
                        grenade_type=_grenade_type(parser_type),
                        thrower_player_id=thrower_id,
                        thrower_display_name=thrower_name,
                        rows=tuple(current),
                    )
                )
                current = []
            current.append(row)
        if current:
            runs.append(
                _GrenadeRun(
                    entity_id=entity_id,
                    parser_type=parser_type,
                    grenade_type=_grenade_type(parser_type),
                    thrower_player_id=thrower_id,
                    thrower_display_name=thrower_name,
                    rows=tuple(current),
                )
            )
    return sorted(runs, key=lambda run: (run.start_tick, run.entity_id, run.parser_type))


def _event_matches_run(event: ReplayEvent, run: _GrenadeRun, *, allow_actor_fallback: bool) -> bool:
    if _event_kind(event) != run.grenade_type:
        return False
    entity_id = _event_entity_id(event)
    if entity_id == run.entity_id:
        return True
    if not allow_actor_fallback or run.grenade_type not in {"MOLOTOV", "INCENDIARY"}:
        return False
    return event.actor_player_id is not None and event.actor_player_id == run.thrower_player_id


def _choose_detonate_event(
    run: _GrenadeRun,
    events: list[ReplayEvent],
    used_event_ids: set[str],
) -> ReplayEvent | None:
    candidates = [
        event
        for event in events
        if event.id not in used_event_ids
        and event.source_parser_event.endswith("_detonate")
        and _event_matches_run(event, run, allow_actor_fallback=True)
        and run.start_tick - 8 <= event.tick <= run.last_sample_tick + 8
    ]
    if not candidates:
        # Inferno startburn is the lifecycle event available for molotovs in
        # demoparser2 0.42; it often uses the fire entity ID rather than the
        # projectile entity ID and lands exactly after the observed run.
        candidates = [
            event
            for event in events
            if event.id not in used_event_ids
            and event.source_parser_event == "inferno_startburn"
            and _event_matches_run(event, run, allow_actor_fallback=True)
            and run.last_sample_tick <= event.tick <= run.last_sample_tick + 8
        ]
    if not candidates:
        return None
    return min(candidates, key=lambda event: (abs(event.tick - run.last_sample_tick), event.tick, event.id))


def _choose_expire_event(
    run: _GrenadeRun,
    detonate: ReplayEvent | None,
    events: list[ReplayEvent],
    used_event_ids: set[str],
) -> ReplayEvent | None:
    if run.grenade_type not in {"SMOKE", "MOLOTOV", "INCENDIARY"}:
        return None
    start = detonate.tick if detonate is not None else run.last_sample_tick
    candidates = [
        event
        for event in events
        if event.id not in used_event_ids
        and event.source_parser_event in {"smokegrenade_expired", "inferno_expire"}
        and _event_matches_run(event, run, allow_actor_fallback=True)
        and start <= event.tick <= start + GRENADE_LIFECYCLE_LOOKAHEAD_TICKS
    ]
    if not candidates:
        return None
    return min(candidates, key=lambda event: (event.tick, event.id))


def _distance(left: WorldPoint, right: WorldPoint) -> float:
    return math.sqrt(
        (left.x - right.x) ** 2 + (left.y - right.y) ** 2 + (left.z - right.z) ** 2
    )


def _turn_angle(previous: WorldPoint, current: WorldPoint, following: WorldPoint) -> float:
    first = (current.x - previous.x, current.y - previous.y, current.z - previous.z)
    second = (following.x - current.x, following.y - current.y, following.z - current.z)
    first_length = math.sqrt(sum(value * value for value in first))
    second_length = math.sqrt(sum(value * value for value in second))
    if first_length == 0 or second_length == 0:
        return 0.0
    cosine = sum(left * right for left, right in zip(first, second)) / (first_length * second_length)
    return math.degrees(math.acos(max(-1.0, min(1.0, cosine))))


def _compress_samples(
    rows: list[GrenadeTrajectoryRow],
    *,
    lifecycle_events: list[ReplayEvent],
    terminal_tick: int,
) -> tuple[list[GrenadeSample], int | None, float | None]:
    rows = [row for row in rows if row.tick <= terminal_tick]
    if not rows:
        return [], None, None
    by_tick = {row.tick: row.world_position for row in rows if row.world_position is not None}
    keep: dict[int, tuple[WorldPoint, str]] = {}
    ticks = sorted(by_tick)
    keep[ticks[0]] = (by_tick[ticks[0]], "START")
    # The final label is assigned after lifecycle coordinates are added.  If
    # an expiry event extends the track, the last finite trajectory row is not
    # itself the terminal sample.
    keep[ticks[-1]] = (by_tick[ticks[-1]], "STRIDE")
    for index, tick in enumerate(ticks):
        if index % GRENADE_SAMPLE_STRIDE_TICKS == 0:
            keep.setdefault(tick, (by_tick[tick], "STRIDE"))
        if 0 < index < len(ticks) - 1:
            previous = by_tick[ticks[index - 1]]
            current = by_tick[tick]
            following = by_tick[ticks[index + 1]]
            if _turn_angle(previous, current, following) >= GRENADE_TURN_THRESHOLD_DEGREES:
                keep[tick] = (current, "TURN")

    for event in lifecycle_events:
        if event.tick < ticks[0] or event.tick > terminal_tick:
            continue
        if event.world_origin is not None:
            keep[event.tick] = (event.world_origin, "LIFECYCLE")
        elif event.tick in by_tick:
            keep[event.tick] = (by_tick[event.tick], "LIFECYCLE")

    ordered = sorted(keep.items())
    samples: list[GrenadeSample] = []
    for index, (tick, (point, kind)) in enumerate(ordered):
        if index == 0:
            kind = "START"
        if index == len(ordered) - 1:
            kind = "END"
        samples.append(
            GrenadeSample(
                tick=tick,
                world_position=point,
                sample_kind=kind,  # type: ignore[arg-type]
            )
        )
    gaps = [right.tick - left.tick for left, right in zip(samples, samples[1:])]
    chords = [_distance(left.world_position, right.world_position) for left, right in zip(samples, samples[1:])]
    return samples, max(gaps, default=0), max(chords, default=0.0)


def build_grenade_tracks(
    *,
    timeline: ReplayMatchTimeline,
    rows: Iterable[GrenadeTrajectoryRow],
    events: Iterable[ReplayEvent],
) -> GrenadeBuildResult:
    """Reduce parser grenade rows without inventing terminal positions."""

    input_rows = list(rows)
    all_rows = [
        row
        for row in input_rows
        if timeline.start_tick <= row.tick < timeline.end_tick
    ]
    outside_rows = [
        row
        for row in input_rows
        if not timeline.start_tick <= row.tick < timeline.end_tick
    ]
    input_events = list(events)
    all_events = sorted(
        [
            event
            for event in input_events
            if timeline.start_tick <= event.tick < timeline.end_tick
            and _event_kind(event) is not None
        ],
        key=lambda event: (event.tick, event.id),
    )
    warnings: list[ParseWarning] = []
    if outside_rows:
        warnings.append(
            _warning(
                "GRENADE_ROW_OUTSIDE_CANONICAL_RANGE",
                "Grenade trajectory rows outside the canonical MatchTimeline were retained as parser input facts but excluded from tracks.",
                field="grenade_tracks",
                details={
                    "count": len(outside_rows),
                    "ticks": [row.tick for row in outside_rows[:32]],
                    "canonical_range": [timeline.start_tick, timeline.end_tick],
                },
            )
        )
    outside_events = [
        event
        for event in input_events
        if not timeline.start_tick <= event.tick < timeline.end_tick and _event_kind(event)
    ]
    if outside_events:
        warnings.append(
            _warning(
                "GRENADE_EVENT_OUTSIDE_CANONICAL_RANGE",
                "Grenade lifecycle events outside the canonical MatchTimeline were excluded from grenade tracks.",
                field="grenade_tracks",
                details={"event_ids": [event.id for event in outside_events[:32]]},
            )
        )

    runs = _build_runs(all_rows)
    used_event_ids: set[str] = set()
    tracks: list[GrenadeTrack] = []
    for ordinal, run in enumerate(runs, start=1):
        detonate = _choose_detonate_event(run, all_events, used_event_ids)
        if detonate is not None:
            used_event_ids.add(detonate.id)
        expire = _choose_expire_event(run, detonate, all_events, used_event_ids)
        if expire is not None:
            used_event_ids.add(expire.id)
        terminal_event = expire or detonate
        terminal_tick = terminal_event.tick if terminal_event is not None else run.last_sample_tick
        if terminal_tick < run.start_tick:
            warnings.append(
                _warning(
                    "GRENADE_LIFECYCLE_BEFORE_START",
                    "A matched grenade lifecycle event preceded the observed trajectory; the event was not used as a terminal tick.",
                    field="grenade_tracks",
                    details={"entity_id": run.entity_id, "start_tick": run.start_tick, "event_tick": terminal_tick},
                )
            )
            terminal_tick = run.last_sample_tick
            terminal_event = None

        lifecycle_events = [event for event in (detonate, expire) if event is not None]
        samples, max_tick_gap, max_chord_distance = _compress_samples(
            list(run.rows),
            lifecycle_events=lifecycle_events,
            terminal_tick=terminal_tick,
        )
        if not samples:
            continue
        fact_refs = [f"grenade-row:{run.entity_id}:{row.tick}" for row in run.rows]
        for event in lifecycle_events:
            fact_refs.extend(_event_refs(event))
        limitations = [
            "start_tick 是 parser 首个有限世界坐标样本，不等同于 Demo 中未提供的 grenade_throw tick。",
            "未从轨迹或事件推算落点；只有 parser trajectory sample 或 lifecycle event 的 direct world_origin 才进入 samples。",
        ]
        if detonate is None:
            limitations.append("未匹配到 parser detonate/startburn event；detonate_tick 保持 null。")
        if expire is None and run.grenade_type in {"SMOKE", "MOLOTOV", "INCENDIARY"}:
            limitations.append("未匹配到 parser expire event；expire_tick 保持 null。")
        if detonate is not None and _event_entity_id(detonate) != run.entity_id:
            limitations.append("lifecycle event 通过 thrower + 临近 tick 关联；parser event entity ID 与 projectile ID 不同。")
        thrower_id = run.thrower_player_id or (detonate.actor_player_id if detonate else None)
        tracks.append(
            GrenadeTrack(
                track_id=f"grenade:{run.entity_id}:{ordinal}:{run.start_tick}",
                id=f"grenade:{run.entity_id}:{ordinal}:{run.start_tick}",
                item_id=_ITEM_ID_BY_TYPE.get(run.grenade_type),
                canonical_round_number=_round_number(timeline, run.start_tick),
                grenade_entity_id=run.entity_id,
                grenade_type=run.grenade_type,
                thrower_player_id=thrower_id,
                thrower_display_name=run.thrower_display_name,
                start_tick=run.start_tick,
                end_tick=terminal_tick,
                detonate_tick=detonate.tick if detonate is not None else None,
                expire_tick=expire.tick if expire is not None else None,
                samples=samples,
                points=samples,
                sampling_strategy=GRENADE_SAMPLING_STRATEGY,
                max_tick_gap=max_tick_gap,
                max_chord_distance=max_chord_distance,
                parser_grenade_types=[run.parser_type],
                fact_refs=list(dict.fromkeys(fact_refs)),
                limitations=limitations,
            )
        )

    valid_position_rows = sum(1 for row in all_rows if row.world_position is not None)
    lifecycle_event_rows = len(all_events)
    tracks_with_detonate = sum(track.detonate_tick is not None for track in tracks)
    tracks_with_expire = sum(track.expire_tick is not None for track in tracks)
    if any(row.world_position is None for row in all_rows):
        warnings.append(
            _warning(
                "GRENADE_ROWS_WITHOUT_WORLD_POSITION",
                "parse_grenades returned lifecycle/entity rows without finite coordinates; they were not emitted as trajectory samples.",
                field="grenade_tracks",
                details={"rows_without_position": sum(row.world_position is None for row in all_rows)},
            )
        )
    if tracks:
        warnings.append(
            _warning(
                "GRENADE_TRAJECTORY_COMPRESSED",
                "Grenade samples were deterministically reduced while preserving start/end, turns, and matched lifecycle coordinates.",
                field="grenade_tracks",
                details={"sampling_strategy": GRENADE_SAMPLING_STRATEGY, "stride_ticks": GRENADE_SAMPLE_STRIDE_TICKS},
            )
        )
    coverage = GrenadeCoverage(
        input_rows=len(input_rows),
        canonical_rows=len(all_rows),
        valid_position_rows=valid_position_rows,
        lifecycle_event_rows=lifecycle_event_rows,
        output_tracks=len(tracks),
        output_samples=sum(len(track.samples) for track in tracks),
        retained_ratio=(
            sum(len(track.samples) for track in tracks) / valid_position_rows
            if valid_position_rows
            else 0.0
        ),
        tracks_with_detonate=tracks_with_detonate,
        tracks_with_expire=tracks_with_expire,
        source="DEMO_PARSER2_PARSE_GRENADES_0.42.0_PLUS_LIFECYCLE_EVENTS",
        limitations=[
            "demoparser2 grenade_entity_id 会在 Demo 中复用；轨迹按 parser type/thrower/连续 tick 分段。",
            "没有 direct throw event 的 grenade 使用首个有限轨迹样本作为 start_tick，并明确记录限制。",
            "没有有限坐标的 active entity rows 只计入 input_rows，不生成伪造 samples。",
        ],
    )
    return GrenadeBuildResult(tracks=tracks, coverage=coverage, warnings=warnings)

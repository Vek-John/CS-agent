"""Deterministic observer knowledge for the parsed Demo bundle.

This module is deliberately conservative.  Parser events are global ground
truth and are never copied into an observer state without an observer-bound
derivation.  The only enemy knowledge currently emitted by the MVP is a
coarse, ``POSSIBLY_AUDIBLE`` sound direction when both the enemy and observer
have nearby sampled positions.  The enemy position and identity stay out of
the claim.
"""

from __future__ import annotations

import math
from collections import defaultdict
from typing import Iterable

from .models import ParseWarning, WorldPoint
from .replay_models import (
    ReplayEvent,
    ReplayMatchTimeline,
    ReplayObservableState,
    ReplayObservationClaim,
    ReplayPlayerStateSample,
)


OBSERVATION_VERSION = "demo-observation/1.0.0"
SOUND_ASSESSOR = "distance-gate-with-state-join/v1"
SOUND_CLAIM_TTL_TICKS = 128
SOUND_STATE_JOIN_MAX_AGE_TICKS = 48
FOOTSTEP_AUDIBILITY_DISTANCE = 900.0
GUNSHOT_AUDIBILITY_DISTANCE = 2400.0

_SOUND_TYPES = {"FOOTSTEP", "GUNSHOT"}
_SOUND_WIDTHS = {"FOOTSTEP": 120.0, "GUNSHOT": 150.0}
_NO_SPOTTED_LIMITATION = "parser 未提供 observer-scoped spotted/视线证据；不生成敌方视觉坐标。"
_NO_TEAM_SHARE_LIMITATION = "parser 未提供 observer-scoped 队友共享证据；不自动继承队友视野。"
_NO_DAMAGE_DIRECTION_LIMITATION = "parser 未提供 observer-scoped 伤害来向证据；不从伤害事件推断方向。"
_NO_LAST_KNOWN_LIMITATION = "没有可靠的 observer-scoped 最后确认点；不生成 last-known 敌方位置。"


def _warning(
    code: str,
    message: str,
    *,
    field: str | None = None,
    details: dict[str, object] | None = None,
) -> ParseWarning:
    return ParseWarning(code=code, message=message, field=field, details=details or {})


def _canonical_events(
    timeline: ReplayMatchTimeline,
    events: Iterable[ReplayEvent],
    warnings: list[ParseWarning],
) -> list[ReplayEvent]:
    result: list[ReplayEvent] = []
    rejected: list[ReplayEvent] = []
    for event in events:
        if timeline.start_tick <= event.tick < timeline.end_tick:
            result.append(event)
        else:
            rejected.append(event)
    if rejected:
        warnings.append(
            _warning(
                "OBSERVATION_EVENT_OUTSIDE_CANONICAL_RANGE",
                "Raw events outside the canonical MatchTimeline were retained as facts but excluded from ObservableState.",
                field="observable_states",
                details={
                    "count": len(rejected),
                    "event_ids": [event.id for event in rejected[:32]],
                    "ticks": [event.tick for event in rejected[:32]],
                    "canonical_range": [timeline.start_tick, timeline.end_tick],
                },
            )
        )
    return result


def _latest_sample(
    samples_by_player: dict[str, list[ReplayPlayerStateSample]],
    player_id: str,
    tick: int,
    *,
    max_age_ticks: int | None = None,
) -> ReplayPlayerStateSample | None:
    candidates = samples_by_player.get(player_id, [])
    selected: ReplayPlayerStateSample | None = None
    for sample in candidates:
        if sample.tick > tick:
            break
        selected = sample
    if selected is None:
        return None
    if max_age_ticks is not None and tick - selected.tick > max_age_ticks:
        return None
    return selected


def _bearing_degrees(origin: WorldPoint, target: WorldPoint) -> float:
    value = math.degrees(math.atan2(target.y - origin.y, target.x - origin.x))
    return value % 360.0


def _distance_xy(left: WorldPoint, right: WorldPoint) -> float:
    return math.hypot(left.x - right.x, left.y - right.y)


def _self_claim(
    player_id: str,
    sample: ReplayPlayerStateSample,
    *,
    at_tick: int,
) -> ReplayObservationClaim:
    return ReplayObservationClaim(
        id=f"obs-claim:{player_id}:{at_tick}:self",
        claim_type="PLAYER_POSITION",
        knowledge_kind="OBSERVED",
        source_type="DIRECT_VISION",
        subject_ref=player_id,
        subject_resolution="EXACT_PLAYER",
        available_from_tick=sample.tick,
        evidence_tick=sample.tick,
        spatial_estimate={"type": "EXACT_POINT", "point": sample.world_position.model_dump(mode="json")},
        confidence=1.0,
        sharing_scope="SELF",
        evidence_refs=list(sample.fact_refs),
        derived_by=OBSERVATION_VERSION,
        limitations=["主体自身位置来自 parser PlayerStateSample；不代表观察者知道其他玩家位置。"],
    )


def _sound_claim(
    *,
    observer_id: str,
    observer_sample: ReplayPlayerStateSample,
    actor_sample: ReplayPlayerStateSample,
    event: ReplayEvent,
) -> ReplayObservationClaim | None:
    if event.event_type not in _SOUND_TYPES or event.actor_player_id in {None, observer_id}:
        return None
    if observer_sample.side == actor_sample.side:
        return None
    distance = _distance_xy(observer_sample.world_position, actor_sample.world_position)
    threshold = (
        FOOTSTEP_AUDIBILITY_DISTANCE
        if event.event_type == "FOOTSTEP"
        else GUNSHOT_AUDIBILITY_DISTANCE
    )
    if distance > threshold:
        return None

    event_refs = list(event.fact_refs) or [event.id]
    state_refs = list(observer_sample.fact_refs) + list(actor_sample.fact_refs)
    evidence_refs = list(dict.fromkeys(event_refs + state_refs))
    limitations = [
        f"仅使用 observer/actor 最近的 PlayerStateSample 做二维距离门槛：{threshold:.0f} world units；距离 {distance:.1f}。",
        "POSSIBLY_AUDIBLE 不是‘确实听到’；未建模墙体/遮挡、声学传播、音量、同时噪声、队友语音与游戏设置。",
        "声源 emission origin 通过 actor PlayerStateSample join 得到；不使用该位置作为观察者可见坐标。",
        "不保留 actor 身份或 exact point，只保留 observer-relative 粗方向。",
    ]
    assessment = {
        "result": "POSSIBLY_AUDIBLE",
        "assessed_by": SOUND_ASSESSOR,
        "evidence_refs": evidence_refs,
        "limitations": limitations,
        "distance_world_units": round(distance, 3),
        "threshold_world_units": threshold,
        "emission_origin_source": "ACTOR_PLAYER_STATE_JOIN",
    }
    return ReplayObservationClaim(
        id=f"obs-claim:{observer_id}:{event.id}:sound",
        claim_type="SOUND_SOURCE",
        knowledge_kind="INFERRED",
        source_type="FOOTSTEP" if event.event_type == "FOOTSTEP" else "GUNSHOT",
        subject_resolution="UNKNOWN_ACTOR",
        available_from_tick=event.tick,
        evidence_tick=event.tick,
        expires_at_tick=event.tick + SOUND_CLAIM_TTL_TICKS,
        spatial_estimate={
            "type": "DIRECTION_SECTOR",
            "origin": observer_sample.world_position.model_dump(mode="json"),
            "bearing_degrees": round(
                _bearing_degrees(observer_sample.world_position, actor_sample.world_position),
                3,
            ),
            "width_degrees": _SOUND_WIDTHS[event.event_type],
            "max_distance": threshold,
        },
        confidence=0.35,
        sharing_scope="SELF",
        evidence_refs=evidence_refs,
        audibility_assessment=assessment,
        derived_by=OBSERVATION_VERSION,
        limitations=limitations,
    )


def _build_sample_index(
    timeline: ReplayMatchTimeline,
    state_samples: Iterable[ReplayPlayerStateSample],
) -> dict[str, list[ReplayPlayerStateSample]]:
    indexed: dict[str, list[ReplayPlayerStateSample]] = defaultdict(list)
    for sample in state_samples:
        if timeline.start_tick <= sample.tick < timeline.end_tick:
            indexed[sample.player_id].append(sample)
    for samples in indexed.values():
        samples.sort(key=lambda sample: sample.tick)
    return dict(indexed)


def build_observable_states(
    *,
    timeline: ReplayMatchTimeline,
    observer_player_id: str,
    state_samples: Iterable[ReplayPlayerStateSample],
    events: Iterable[ReplayEvent],
    checkpoint_ticks: Iterable[int] | None = None,
    warnings: list[ParseWarning] | None = None,
) -> list[ReplayObservableState]:
    """Build observer-bound states at deterministic checkpoints.

    The builder consumes parser facts but applies the canonical range and
    observer boundary again at runtime.  A missing join row produces no sound
    claim, rather than a hidden exact position or a global claim.
    """

    local_warnings = warnings if warnings is not None else []
    samples_by_player = _build_sample_index(timeline, state_samples)
    canonical_events = _canonical_events(timeline, events, local_warnings)
    sound_events = [event for event in canonical_events if event.event_type in _SOUND_TYPES]
    checkpoints = {
        tick
        for tick in (checkpoint_ticks or ())
        if timeline.start_tick <= tick < timeline.end_tick
    }
    if not checkpoints:
        checkpoints = {
            round_timeline.freeze_end_tick
            for round_timeline in timeline.rounds
            if timeline.start_tick <= round_timeline.freeze_end_tick < timeline.end_tick
        }
    checkpoints = set(checkpoints)
    if not checkpoints:
        checkpoints.add(timeline.start_tick)

    states: list[ReplayObservableState] = []
    skipped_sound_events: set[str] = set()
    for at_tick in sorted(checkpoints):
        observer_sample = _latest_sample(samples_by_player, observer_player_id, at_tick)
        if observer_sample is None:
            local_warnings.append(
                _warning(
                    "OBSERVATION_CHECKPOINT_STATE_MISSING",
                    "ObservableState checkpoint was skipped because the observer had no prior canonical PlayerStateSample.",
                    field="observable_states",
                    details={"observer_player_id": observer_player_id, "at_tick": at_tick},
                )
            )
            continue

        claims: list[ReplayObservationClaim] = [_self_claim(observer_player_id, observer_sample, at_tick=at_tick)]
        for event in sound_events:
            if event.tick > at_tick or event.tick + SOUND_CLAIM_TTL_TICKS <= at_tick:
                continue
            actor_id = event.actor_player_id
            if actor_id is None:
                skipped_sound_events.add(event.id)
                continue
            actor_sample = _latest_sample(
                samples_by_player,
                actor_id,
                event.tick,
                max_age_ticks=SOUND_STATE_JOIN_MAX_AGE_TICKS,
            )
            event_observer_sample = _latest_sample(
                samples_by_player,
                observer_player_id,
                event.tick,
                max_age_ticks=SOUND_STATE_JOIN_MAX_AGE_TICKS,
            )
            if actor_sample is None or event_observer_sample is None:
                skipped_sound_events.add(event.id)
                continue
            claim = _sound_claim(
                observer_id=observer_player_id,
                observer_sample=event_observer_sample,
                actor_sample=actor_sample,
                event=event,
            )
            if claim is not None:
                claims.append(claim)

        claims.sort(key=lambda claim: claim.id)
        states.append(
            ReplayObservableState(
                id=f"obs-state:{observer_player_id}:{at_tick}",
                demo_id=timeline.demo_id,
                timeline_version=timeline.timeline_version,
                observer_player_id=observer_player_id,
                at_tick=at_tick,
                observation_version=OBSERVATION_VERSION,
                claims=claims,
                limitations=[
                    _NO_SPOTTED_LIMITATION,
                    _NO_TEAM_SHARE_LIMITATION,
                    _NO_DAMAGE_DIRECTION_LIMITATION,
                    _NO_LAST_KNOWN_LIMITATION,
                    "UTILITY/BOMB 仅在有 observer-scoped observable evidence 时可进入状态；本 MVP 不把 raw hidden position 转成 uncertain point。",
                ],
            )
        )

    if skipped_sound_events:
        local_warnings.append(
            _warning(
                "OBSERVATION_SOUND_JOIN_UNAVAILABLE",
                "Some canonical sound emissions were not converted because an observer/actor state join was missing or the event had no actor.",
                field="observable_states.claims",
                details={"event_ids": sorted(skipped_sound_events)[:32]},
            )
        )
    if sound_events:
        local_warnings.append(
            _warning(
                "OBSERVATION_SOUND_DISTANCE_HEURISTIC",
                "Sound claims use a conservative distance gate and are POSSIBLY_AUDIBLE only; they do not prove that the observer heard the event.",
                field="observable_states.claims",
                details={
                    "assessed_by": SOUND_ASSESSOR,
                    "footstep_threshold_world_units": FOOTSTEP_AUDIBILITY_DISTANCE,
                    "gunshot_threshold_world_units": GUNSHOT_AUDIBILITY_DISTANCE,
                    "claim_ttl_ticks": SOUND_CLAIM_TTL_TICKS,
                },
            )
        )
    return states


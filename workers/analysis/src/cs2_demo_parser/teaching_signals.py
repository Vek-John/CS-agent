"""Small deterministic teaching-signal detector for the first real Demo."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Iterable

from .models import ParseWarning
from .replay_models import ReplayEvent, ReplayMatchTimeline, ReplayRoundTimeline


SIGNAL_VERSION = "demo-signals/1.0.0"
CONTACT_LOOKBACK_TICKS = 192
DECISION_CONTEXT_TICKS = 96
OUTCOME_WINDOW_TICKS = 192


@dataclass(frozen=True)
class TeachingSignal:
    id: str
    taxonomy_id: str
    round_number: int
    event_id: str
    event_tick: int
    decision_tick: int
    outcome_start_tick: int
    outcome_end_tick: int
    fact_refs: tuple[str, ...]
    prior_damage_event_ids: tuple[str, ...]
    prior_damage_count: int
    score: float
    limitations: tuple[str, ...]


def _round_for_tick(
    rounds: Iterable[ReplayRoundTimeline],
    tick: int,
) -> ReplayRoundTimeline | None:
    for round_timeline in rounds:
        if round_timeline.start_tick <= tick < round_timeline.end_tick:
            return round_timeline
    return None


def _canonical_events(
    timeline: ReplayMatchTimeline,
    events: Iterable[ReplayEvent],
    warnings: list[ParseWarning],
) -> list[ReplayEvent]:
    canonical: list[ReplayEvent] = []
    outside: list[ReplayEvent] = []
    for event in events:
        if timeline.start_tick <= event.tick < timeline.end_tick:
            canonical.append(event)
        else:
            outside.append(event)
    if outside:
        warnings.append(
            ParseWarning(
                code="SIGNAL_EVENT_OUTSIDE_CANONICAL_RANGE",
                message="Teaching signals ignore raw events outside the canonical MatchTimeline range.",
                field="review_plan.cues",
                details={
                    "count": len(outside),
                    "event_ids": [event.id for event in outside[:32]],
                    "ticks": [event.tick for event in outside[:32]],
                },
            )
        )
    return canonical


def detect_teaching_signals(
    *,
    timeline: ReplayMatchTimeline,
    selected_player_id: str,
    events: Iterable[ReplayEvent],
    warnings: list[ParseWarning] | None = None,
) -> list[TeachingSignal]:
    """Detect only contact-survival review opportunities.

    A death is a ground-truth outcome, not proof of a bad decision.  The
    signal therefore creates a review opportunity with an explicit limitation
    and only uses preceding damage rows as observable context.  It never
    reads opponent coordinates, raw sound emissions, or post-decision facts.
    """

    local_warnings = warnings if warnings is not None else []
    canonical_events = _canonical_events(timeline, events, local_warnings)
    damage_by_target: dict[str, list[ReplayEvent]] = {}
    for event in canonical_events:
        if event.event_type == "DAMAGE" and event.target_player_id:
            damage_by_target.setdefault(event.target_player_id, []).append(event)
    for rows in damage_by_target.values():
        rows.sort(key=lambda event: (event.tick, event.id))

    deaths = [
        event
        for event in canonical_events
        if event.event_type == "PLAYER_DEATH" and event.target_player_id == selected_player_id
    ]
    deaths.sort(key=lambda event: (event.tick, event.id))
    signals: list[TeachingSignal] = []
    for ordinal, death in enumerate(deaths, start=1):
        round_timeline = _round_for_tick(timeline.rounds, death.tick)
        if round_timeline is None:
            continue
        prior_damage = [
            event
            for event in damage_by_target.get(selected_player_id, [])
            if death.tick - CONTACT_LOOKBACK_TICKS <= event.tick < death.tick
        ]
        decision_tick = max(
            round_timeline.freeze_end_tick,
            death.tick - DECISION_CONTEXT_TICKS,
        )
        if decision_tick >= death.tick:
            # A death during freeze/at the very beginning does not provide a
            # decision-before-outcome interval for a cue.
            continue
        outcome_end = min(round_timeline.end_tick, death.tick + OUTCOME_WINDOW_TICKS)
        if outcome_end <= death.tick:
            continue

        first_damage_refs = list(prior_damage[0].fact_refs) if prior_damage else []
        fact_refs = tuple(dict.fromkeys([*first_damage_refs, *death.fact_refs]))
        taxonomy_id = "CONTACT_SURVIVAL_AFTER_DAMAGE" if prior_damage else "SURVIVAL_AFTER_CONTACT"
        score = min(0.85, 0.52 + 0.05 * min(len(prior_damage), 5))
        signals.append(
            TeachingSignal(
                id=f"signal:{selected_player_id}:{death.id}",
                taxonomy_id=taxonomy_id,
                round_number=round_timeline.round_number,
                event_id=death.id,
                event_tick=death.tick,
                decision_tick=decision_tick,
                outcome_start_tick=death.tick,
                outcome_end_tick=outcome_end,
                fact_refs=fact_refs,
                prior_damage_event_ids=tuple(event.id for event in prior_damage),
                prior_damage_count=len(prior_damage),
                score=score,
                limitations=(
                    "死亡是结果事实，不单独证明决策错误；缺少 spotted/视线、可靠声学、队友通信与意图字段。",
                    "该信号只用于暂停复查接触后的选择，不使用敌方实时坐标。",
                ),
            )
        )
    return signals

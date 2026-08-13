"""Build a full-match, decision-before-outcome ReviewPlan from facts."""

from __future__ import annotations

from collections import defaultdict
from typing import Iterable

from .models import ParseWarning
from .replay_models import (
    ReplayEvent,
    ReplayHabitCluster,
    ReplayMatchTimeline,
    ReplayObservableState,
    ReplayPlayerStateSample,
    ReplayReviewAdvice,
    ReplayReviewAnnotation,
    ReplayReviewCue,
    ReplayReviewEvidence,
    ReplayReviewFact,
    ReplayReviewInference,
    ReplayReviewPlan,
    ReplayReviewSegment,
    ReviewGenerationManifest,
)
from .teaching_signals import SIGNAL_VERSION, TeachingSignal


PLANNER_VERSION = "demo-planner/1.0.0"
RULE_ID = "rule-contact-survival-review/v1"
OBSERVATION_VERSION = "demo-observation/1.0.0"


def _latest_sample(
    samples_by_player: dict[str, list[ReplayPlayerStateSample]],
    player_id: str,
    tick: int,
) -> ReplayPlayerStateSample | None:
    selected: ReplayPlayerStateSample | None = None
    for sample in samples_by_player.get(player_id, []):
        if sample.tick > tick:
            break
        selected = sample
    return selected


def _world_point(sample: ReplayPlayerStateSample | None) -> dict[str, float] | None:
    if sample is None:
        return None
    return {
        "x": sample.world_position.x,
        "y": sample.world_position.y,
        "z": sample.world_position.z,
    }


def _state_for_tick(
    states: list[ReplayObservableState],
    observer_player_id: str,
    tick: int,
) -> ReplayObservableState | None:
    exact = next(
        (
            state
            for state in states
            if state.observer_player_id == observer_player_id and state.at_tick == tick
        ),
        None,
    )
    if exact is not None:
        return exact
    prior = [
        state
        for state in states
        if state.observer_player_id == observer_player_id and state.at_tick <= tick
    ]
    return max(prior, key=lambda state: state.at_tick) if prior else None


def _state_self_claim(state: ReplayObservableState | None):
    if state is None:
        return None
    return next(
        (
            claim
            for claim in state.claims
            if claim.source_type == "DIRECT_VISION" and claim.subject_resolution == "EXACT_PLAYER"
        ),
        None,
    )


def _canonical_events(
    timeline: ReplayMatchTimeline,
    events: Iterable[ReplayEvent],
    warnings: list[ParseWarning],
) -> dict[str, ReplayEvent]:
    result: dict[str, ReplayEvent] = {}
    outside: list[ReplayEvent] = []
    for event in events:
        if timeline.start_tick <= event.tick < timeline.end_tick:
            result[event.id] = event
        else:
            outside.append(event)
    if outside:
        warnings.append(
            ParseWarning(
                code="REVIEW_EVENT_OUTSIDE_CANONICAL_RANGE",
                message="Review cues and outcomes exclude raw events outside [timeline.start_tick, timeline.end_tick).",
                field="review_plan",
                details={
                    "count": len(outside),
                    "event_ids": [event.id for event in outside[:32]],
                    "ticks": [event.tick for event in outside[:32]],
                    "canonical_range": [timeline.start_tick, timeline.end_tick],
                },
            )
        )
    return result


def _cue_for_signal(
    *,
    signal: TeachingSignal,
    cue_type: str,
    segment_id: str,
    player_id: str,
    state_samples_by_player: dict[str, list[ReplayPlayerStateSample]],
    observable_states: list[ReplayObservableState],
    events_by_id: dict[str, ReplayEvent],
) -> ReplayReviewCue:
    state = _state_for_tick(observable_states, player_id, signal.decision_tick)
    self_claim = _state_self_claim(state)
    self_fact_id = f"fact:{signal.id}:self"
    self_available_tick = self_claim.available_from_tick if self_claim is not None else signal.decision_tick
    self_refs = list(self_claim.evidence_refs) if self_claim is not None else []
    self_fact = ReplayReviewFact(
        id=self_fact_id,
        text=(
            f"tick {signal.decision_tick} 前，主体自身的位置与生命/护甲状态来自 PlayerStateSample；"
            "这是主体自身事实，不包含对手位置。"
        ),
        availability="DECISION",
        available_at_tick=min(self_available_tick, signal.decision_tick),
        observed_by_player=True,
    )

    visible_damage = [
        events_by_id[event_id]
        for event_id in signal.prior_damage_event_ids
        if event_id in events_by_id and events_by_id[event_id].tick <= signal.decision_tick
    ]
    observable_fact_refs = [self_fact_id]
    facts = [self_fact]
    evidence_refs = list(dict.fromkeys(self_refs))
    if visible_damage:
        first_damage_tick = min(event.tick for event in visible_damage)
        damage_fact_id = f"fact:{signal.id}:contact"
        facts.append(
            ReplayReviewFact(
                id=damage_fact_id,
                text=(
                    f"在决策 tick {signal.decision_tick} 之前，解析记录了主体受到 {len(visible_damage)} 次伤害；"
                    "这只确认接触发生，不推断对手身份、位置或玩家意图。"
                ),
                availability="DECISION",
                available_at_tick=first_damage_tick,
                observed_by_player=True,
            )
        )
        observable_fact_refs.append(damage_fact_id)
        evidence_refs.extend(
            ref
            for event in visible_damage
            for ref in (event.fact_refs or [event.id])
        )

    death = events_by_id.get(signal.event_id)
    outcome_fact_id = f"fact:{signal.id}:outcome"
    outcome_refs = list(death.fact_refs if death is not None else [signal.event_id])
    facts.append(
        ReplayReviewFact(
            id=outcome_fact_id,
            text=(
                f"结果区间从 tick {signal.event_tick} 开始：解析记录主体在该 tick 被击杀；"
                "这是回看结果事实，不是决策前可用信息。"
            ),
            availability="OUTCOME",
            available_at_tick=signal.event_tick,
            observed_by_player=False,
        )
    )
    evidence_refs.extend(outcome_refs)
    evidence_refs = list(dict.fromkeys(evidence_refs))

    inference_refs = list(observable_fact_refs)
    inference = ReplayReviewInference(
        id=f"inference:{signal.id}:review",
        text=(
            "这是一个接触后的生存选择复查点；死亡结果本身不能证明决策错误，"
            "应先检查当时能否停住、换位或等待可验证队友信息。"
        ),
        confidence=signal.score,
        fact_refs=inference_refs,
    )
    advice = ReplayReviewAdvice(
        id=f"advice:{signal.id}:contact-reset",
        text=(
            "若无法确认对手位置或队友覆盖，优先检查是否能在接触后停住/换位；"
            "证据不足时把它当作复查问题，不把死亡直接归因于错误。"
        ),
        trigger="发生接触且缺少可靠敌情或队友共享时",
        fact_refs=inference_refs,
        rule_id=RULE_ID,
    )
    evidence = [
        ReplayReviewEvidence(
            id=f"evidence:{signal.id}:demo",
            source="DEMO",
            label="主体状态与接触/结果事件",
            sample_count=len(evidence_refs),
            fact_refs=[*observable_fact_refs, outcome_fact_id],
        ),
        ReplayReviewEvidence(
            id=f"evidence:{signal.id}:rule",
            source="RULE",
            label="接触后生存复查规则",
            fact_refs=observable_fact_refs,
        ),
    ]

    decision_point = _world_point(
        _latest_sample(state_samples_by_player, player_id, signal.decision_tick)
    )
    annotations: list[ReplayReviewAnnotation] = []
    if decision_point is not None:
        annotations.append(
            ReplayReviewAnnotation(
                id=f"annotation:{signal.id}:decision",
                type="POINT",
                coordinate_space="WORLD",
                point=decision_point,
                label="主体决策前位置（WORLD）",
            )
        )

    return ReplayReviewCue(
        id=f"cue:{signal.id}",
        segment_id=segment_id,
        cue_type=cue_type,  # type: ignore[arg-type]
        title=(
            "接触后如何保命？"
            if cue_type == "DECISION"
            else "同类接触，再复查一次"
        ),
        question=(
            f"在 tick {signal.decision_tick}，你会如何处理刚刚的接触并保留下一步信息？"
        ),
        decision_tick=signal.decision_tick,
        reveal_tick=signal.event_tick,
        outcome_start_tick=signal.outcome_start_tick,
        outcome_end_tick=signal.outcome_end_tick,
        facts=facts,
        inferences=[inference],
        advice=[advice],
        evidence=evidence,
        observable_fact_refs=observable_fact_refs,
        observable_state_id=state.id if state is not None else None,
        annotations=annotations,
        confidence=signal.score,
        limitations=list(signal.limitations)
        + [
            "真实 Demo 没有可靠 spotted/视线、队友通信或职业样本；该 cue 只支持事实型复查。",
            "annotation 坐标保持 WORLD；renderer 负责按 map manifest 转换到 radar。",
        ],
    )


def _append_segment(
    segments: list[ReplayReviewSegment],
    *,
    id_: str,
    round_number: int,
    start_tick: int,
    end_tick: int,
    mode: str,
    reason_code: str,
    display_reason: str,
    playback_speed: float,
    cue_ids: list[str] | None = None,
) -> None:
    if start_tick >= end_tick:
        return
    segments.append(
        ReplayReviewSegment(
            id=id_,
            round_number=round_number,
            start_tick=start_tick,
            end_tick=end_tick,
            mode=mode,  # type: ignore[arg-type]
            reason_code=reason_code,
            display_reason=display_reason,
            playback_speed=playback_speed,
            cue_ids=cue_ids or [],
            expandable=mode in {"SKIP", "BRIEF"},
        )
    )


def build_review_plan(
    *,
    timeline: ReplayMatchTimeline,
    selected_player_id: str,
    state_samples: Iterable[ReplayPlayerStateSample],
    events: Iterable[ReplayEvent],
    observable_states: list[ReplayObservableState],
    signals: list[TeachingSignal],
    parser_version: str,
) -> ReplayReviewPlan:
    """Build a complete canonical coverage path and cue evidence graph."""

    state_samples_by_player: dict[str, list[ReplayPlayerStateSample]] = defaultdict(list)
    for sample in state_samples:
        if timeline.start_tick <= sample.tick < timeline.end_tick:
            state_samples_by_player[sample.player_id].append(sample)
    for rows in state_samples_by_player.values():
        rows.sort(key=lambda sample: sample.tick)
    events_by_id = _canonical_events(timeline, events, [])
    signals_by_round: dict[int, list[TeachingSignal]] = defaultdict(list)
    for signal in signals:
        if timeline.start_tick <= signal.decision_tick < timeline.end_tick:
            signals_by_round[signal.round_number].append(signal)
    for rows in signals_by_round.values():
        rows.sort(key=lambda signal: (signal.decision_tick, signal.id))

    segments: list[ReplayReviewSegment] = []
    cues: list[ReplayReviewCue] = []
    previous_end = timeline.start_tick
    for round_timeline in sorted(timeline.rounds, key=lambda item: item.start_tick):
        if previous_end < round_timeline.start_tick:
            _append_segment(
                segments,
                id_=f"seg-gap-{previous_end}-{round_timeline.start_tick}",
                round_number=0,
                start_tick=previous_end,
                end_tick=round_timeline.start_tick,
                mode="SKIP",
                reason_code="INTER_ROUND_GAP",
                display_reason="明确跳过回合间等待/解析空档；该区间仍保留在完整时间轴。",
                playback_speed=8.0,
            )
        cursor = round_timeline.start_tick
        if cursor < round_timeline.freeze_end_tick:
            _append_segment(
                segments,
                id_=f"seg-r{round_timeline.round_number}-freeze",
                round_number=round_timeline.round_number,
                start_tick=cursor,
                end_tick=round_timeline.freeze_end_tick,
                mode="SKIP",
                reason_code="FREEZE_TIME",
                display_reason="跳过冻结时间：保留回合边界，但没有新的主体决策证据。",
                playback_speed=8.0,
            )
            cursor = round_timeline.freeze_end_tick

        for ordinal, signal in enumerate(signals_by_round.get(round_timeline.round_number, [])):
            cue_start = max(cursor, signal.decision_tick - 96, round_timeline.freeze_end_tick)
            cue_end = min(signal.outcome_end_tick, round_timeline.end_tick)
            if cue_start > signal.decision_tick or cue_end <= cue_start:
                continue
            if cursor < cue_start:
                _append_segment(
                    segments,
                    id_=f"seg-r{round_timeline.round_number}-skip-{cursor}-{cue_start}",
                    round_number=round_timeline.round_number,
                    start_tick=cursor,
                    end_tick=cue_start,
                    mode="SKIP",
                    reason_code="LOW_VALUE_NO_SUBJECT_EVENT",
                    display_reason="低价值执行区间：没有选定主体的可验证教学事件，明确跳过。",
                    playback_speed=6.0,
                )
            segment_id = f"seg-r{round_timeline.round_number}-cue-{signal.event_id}"
            cue_type = "DECISION" if not cues else "HABIT_RECHECK"
            _append_segment(
                segments,
                id_=segment_id,
                round_number=round_timeline.round_number,
                start_tick=cue_start,
                end_tick=cue_end,
                mode="DEEP_DIVE" if cue_type == "DECISION" else "HABIT_CHECK",
                reason_code=signal.taxonomy_id,
                display_reason=(
                    "在可用事实边界暂停：先让主体判断，再揭示接触结果。"
                    if cue_type == "DECISION"
                    else "同类接触跨回合再次出现：先复查选择，再揭示结果。"
                ),
                playback_speed=1.0,
                cue_ids=[f"cue:{signal.id}"],
            )
            cues.append(
                _cue_for_signal(
                    signal=signal,
                    cue_type=cue_type,
                    segment_id=segment_id,
                    player_id=selected_player_id,
                    state_samples_by_player=dict(state_samples_by_player),
                    observable_states=observable_states,
                    events_by_id=events_by_id,
                )
            )
            cursor = cue_end

        if cursor < round_timeline.end_tick:
            _append_segment(
                segments,
                id_=f"seg-r{round_timeline.round_number}-tail",
                round_number=round_timeline.round_number,
                start_tick=cursor,
                end_tick=round_timeline.end_tick,
                mode="SKIP",
                reason_code="LOW_VALUE_NO_SUBJECT_EVENT",
                display_reason="低价值执行/收尾区间：没有额外可验证教学点，明确跳过。",
                playback_speed=6.0,
            )
        previous_end = round_timeline.end_tick

    if previous_end < timeline.end_tick:
        _append_segment(
            segments,
            id_=f"seg-gap-{previous_end}-{timeline.end_tick}",
            round_number=0,
            start_tick=previous_end,
            end_tick=timeline.end_tick,
            mode="SKIP",
            reason_code="INTER_ROUND_GAP",
            display_reason="明确跳过末尾解析空档；该区间仍保留在完整时间轴。",
            playback_speed=8.0,
        )

    total_seconds = sum(
        (segment.end_tick - segment.start_tick) / timeline.tick_rate / max(segment.playback_speed, 1.0)
        for segment in segments
    )
    taxonomy_id = "CONTACT_SURVIVAL_AFTER_DAMAGE"
    cue_ids = [cue.id for cue in cues if any(taxonomy_id == signal.taxonomy_id for signal in signals if cue.id == f"cue:{signal.id}")]
    if len(cue_ids) < 2:
        cue_ids = [cue.id for cue in cues]
    habit_clusters = [
        ReplayHabitCluster(
            id="habit:contact-survival-current-match",
            title="当前 Demo 的接触后生存选择复查",
            taxonomy_id=taxonomy_id,
            cue_ids=cue_ids,
            occurrence_count=len(cue_ids),
            opportunity_count=len(cue_ids),
        )
    ] if len(cue_ids) >= 2 else []
    return ReplayReviewPlan(
        id=f"review-plan:{timeline.demo_id}:{selected_player_id}:v1",
        demo_id=timeline.demo_id,
        player_id=selected_player_id,
        status="COMPLETE",
        match_timeline_version=timeline.timeline_version,
        observation_version=OBSERVATION_VERSION,
        signal_version=SIGNAL_VERSION,
        planner_version=PLANNER_VERSION,
        estimated_duration_seconds=max(1, int(round(total_seconds))),
        available_until_round=max((round_timeline.round_number for round_timeline in timeline.rounds), default=0),
        full_match_index_ready=True,
        global_aggregation_ready=True,
        segments=segments,
        cues=cues,
        habit_clusters=habit_clusters,
        generation_manifest=ReviewGenerationManifest(
            parser_version=parser_version,
            observation_version=OBSERVATION_VERSION,
            signal_version=SIGNAL_VERSION,
            planner_version=PLANNER_VERSION,
            analysis_subject_selection="FIRST_TIMELINE_PLAYER_DEFAULT",
            analysis_subject_player_id=selected_player_id,
            limitations=[
                "MVP 分析主体固定为 timeline.players[0]（除非 CLI 明确传入 selected_player_id）；不伪装支持所有玩家。",
                "当前 plan 只生成少量事实型接触复查点；没有可靠证据时不声称职业水平、意图或决策错误。",
                "完整 canonical 区间由 teaching segments 与 round_number=0 的 inter-round gap segments 覆盖。",
            ],
        ),
    )

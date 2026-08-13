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


PLANNER_VERSION = "demo-planner/1.1.0"
RULE_ID = "rule-survival-decision-review/v1"
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


_ITEM_DISPLAY_NAMES = {
    "weapon_ak47": "AK-47",
    "weapon_m4a1": "M4A4",
    "weapon_m4a1_silencer": "M4A1-S",
    "weapon_awp": "AWP",
    "weapon_glock": "Glock-18",
    "weapon_hkp2000": "P2000",
    "weapon_usp_silencer": "USP-S",
    "weapon_deagle": "Desert Eagle",
    "weapon_mac10": "MAC-10",
    "weapon_ssg08": "SSG 08",
    "weapon_knife": "刀",
    "weapon_knife_t": "刀",
    "weapon_c4": "C4",
}


def _format_number(value: float) -> str:
    """Render parser numbers naturally without inventing precision."""

    return str(int(value)) if float(value).is_integer() else f"{value:.1f}".rstrip("0").rstrip(".")


def _display_active_item(sample: ReplayPlayerStateSample) -> str | None:
    item = sample.active_item
    if item is None:
        return None
    if item.item_id in _ITEM_DISPLAY_NAMES:
        return _ITEM_DISPLAY_NAMES[item.item_id]
    return item.item_id.removeprefix("weapon_").replace("_", " ").upper()


def _self_status_text(sample: ReplayPlayerStateSample) -> str:
    armor = f"{_format_number(sample.armor)} 甲"
    if sample.has_helmet:
        armor += "（有头盔）"
    else:
        armor += "（无头盔）"
    held_item = _display_active_item(sample)
    held = f"手持 {held_item}" if held_item is not None else "手持物解析不可得"
    return f"{_format_number(sample.health)} HP / {armor} / {held}"


def _event_damage_value(event: ReplayEvent, key: str) -> float | None:
    value = event.payload.get(key)
    if value is None or isinstance(value, bool):
        return None
    try:
        parsed = float(value)
    except (TypeError, ValueError):
        return None
    return parsed if parsed >= 0 else None


def _damage_summary(events: list[ReplayEvent]) -> str:
    health_damage = [
        value
        for event in events
        if (value := _event_damage_value(event, "damage_health")) is not None
    ]
    armor_damage = [
        value
        for event in events
        if (value := _event_damage_value(event, "damage_armor")) is not None
    ]
    details: list[str] = []
    if health_damage:
        details.append(f"合计 {_format_number(sum(health_damage))} 点生命伤害")
    if armor_damage:
        details.append(f"合计 {_format_number(sum(armor_damage))} 点护甲伤害")
    suffix = f"（{'、'.join(details)}）" if details else ""
    return f"{len(events)} 次受伤{suffix}"


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
    decision_sample = _latest_sample(
        state_samples_by_player,
        player_id,
        signal.decision_tick,
    )
    self_fact_id = f"fact:{signal.id}:self"
    visible_damage = [
        events_by_id[event_id]
        for event_id in signal.prior_damage_event_ids
        if event_id in events_by_id and events_by_id[event_id].tick <= signal.decision_tick
    ]
    observable_fact_refs: list[str] = []
    facts: list[ReplayReviewFact] = []
    evidence_refs: list[str] = []
    if decision_sample is not None:
        facts.append(
            ReplayReviewFact(
                id=self_fact_id,
                text=(
                    f"决策前最近的主体状态帧（tick {decision_sample.tick}）显示："
                    f"{_self_status_text(decision_sample)}。"
                    "这是主体自身可知的状态，不包含敌方位置或装备。"
                ),
                availability="DECISION",
                available_at_tick=decision_sample.tick,
                observed_by_player=True,
            )
        )
        observable_fact_refs.append(self_fact_id)
        evidence_refs.extend(decision_sample.fact_refs)
    if visible_damage:
        first_damage_tick = min(event.tick for event in visible_damage)
        damage_fact_id = f"fact:{signal.id}:contact"
        facts.append(
            ReplayReviewFact(
                id=damage_fact_id,
                text=(
                    f"到决策 tick {signal.decision_tick} 为止，解析记录主体已经受到"
                    f" {_damage_summary(visible_damage)}；"
                    "这只确认主体已受击，不推断对手身份、位置或队友通信。"
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
    status_sentence = (
        f"决策前最近状态帧是 {_self_status_text(decision_sample)}。"
        if decision_sample is not None
        else "此刻没有可用的主体状态帧，所以不假定生命、护甲或手持物。"
    )
    has_prior_damage = bool(visible_damage)
    if has_prior_damage:
        title = "吃到伤害后，下一步怎么打？"
        if cue_type != "DECISION":
            title = "同类受伤局面，再复查一次"
        question = (
            f"教练先停在这里：{status_sentence} 到这里已记录到你受伤，"
            "但现有事实还不能确认对手位置。此时继续留在同一枪线会把下一步变成无信息的二次暴露；"
            "先回掩体或换位，等可验证信息或队友到位，会保留更多选择。"
        )
        inference_text = (
            "暂停前已存在主体受击事实；如果没有可验证敌情或同步补枪，"
            "应优先评估能否先脱离当前枪线。后续结果需要单独回放，不能倒推此刻的选择必然错误。"
        )
        advice_text = (
            "如果此时仍没有可靠敌方位置、或队友不能同步补枪，先退回最近掩体或换位；"
            "等新的可验证信息或队友到位后，再决定是否二次接触。若有明确同步指令，再按指令调整。"
        )
        trigger = "主体已受伤且准备在未确认敌情下继续暴露时"
        demo_evidence_label = "主体状态、决策前受伤与结果事件"
        rule_label = "受伤后的生存与信息重置规则"
    else:
        title = "还没受击时，先把退路留住"
        if cue_type != "DECISION":
            title = "同类未受击局面，再复查一次"
        question = (
            f"教练先停在这里：{status_sentence} 到这个暂停点，解析还没有记录到你已经受伤。"
            "过角前也没有可验证的敌方位置或同步队友覆盖，所以优先保留回掩体的退路；"
            "用短 peek 收集信息或等队友靠近，比直接深压更稳。"
        )
        inference_text = (
            "暂停点位于可验证受击事件之前；不能把尚未展示的结果当作当时信息。"
            "重点是过角前是否仍能回撤，或得到可验证的队友支援。"
        )
        advice_text = (
            "如果准备越过一个不能立即回撤的拐角，而你还没有可靠敌情或同步队友覆盖，"
            "先停在掩体边缘、用短 peek 收集信息或等队友靠近；只有新信息或明确协同要求抢空间时再深压。"
        )
        trigger = "准备在受击前越过不可立即回撤的拐角时"
        demo_evidence_label = "主体状态与后续结果事件"
        rule_label = "受击前的退路与补枪检查规则"

    inference = ReplayReviewInference(
        id=f"inference:{signal.id}:review",
        text=inference_text,
        confidence=signal.score,
        fact_refs=inference_refs,
    )
    advice = ReplayReviewAdvice(
        id=f"advice:{signal.id}:survival-reset",
        text=advice_text,
        trigger=trigger,
        fact_refs=inference_refs,
        rule_id=RULE_ID,
    )
    evidence = [
        ReplayReviewEvidence(
            id=f"evidence:{signal.id}:demo",
            source="DEMO",
            label=demo_evidence_label,
            sample_count=len(evidence_refs),
            fact_refs=[*observable_fact_refs, outcome_fact_id],
        ),
        ReplayReviewEvidence(
            id=f"evidence:{signal.id}:rule",
            source="RULE",
            label=rule_label,
            fact_refs=observable_fact_refs,
        ),
    ]

    decision_point = _world_point(decision_sample)
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
        title=title,
        question=question,
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
            "当前 MVP cue 没有把 spotted/视线、队友通信或职业样本作为建议依据；"
            "若用户补充同步指令，建议需要条件化调整。",
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
                    "在已受伤的可用事实边界暂停：先讲当前判断与理由，再播放结果。"
                    if signal.prior_damage_count and cue_type == "DECISION"
                    else "在受击前的可用事实边界暂停：先讲当前判断与理由，再播放结果。"
                    if cue_type == "DECISION"
                    else "同类受伤局面跨回合再次出现：直接复盘判断与理由，再播放结果。"
                    if signal.prior_damage_count
                    else "同类未受击局面跨回合再次出现：直接复盘判断与理由，再播放结果。"
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
    cue_id_set = {cue.id for cue in cues}
    cue_ids_by_taxonomy: dict[str, list[str]] = defaultdict(list)
    for signal in signals:
        cue_id = f"cue:{signal.id}"
        if cue_id in cue_id_set:
            cue_ids_by_taxonomy[signal.taxonomy_id].append(cue_id)

    habit_clusters: list[ReplayHabitCluster] = []
    if len(cues) >= 2:
        preferred_taxonomy, preferred_cue_ids = max(
            sorted(cue_ids_by_taxonomy.items()),
            key=lambda item: len(item[1]),
        )
        if len(preferred_cue_ids) >= 2:
            taxonomy_id = preferred_taxonomy
            cue_ids = preferred_cue_ids
        else:
            taxonomy_id = "SURVIVAL_DECISION"
            cue_ids = [cue.id for cue in cues]

        habit_title = {
            "CONTACT_SURVIVAL_AFTER_DAMAGE": "当前 Demo 的受伤后生存选择复查",
            "PRE_CONTACT_SURVIVAL_DECISION": "当前 Demo 的受击前退路选择复查",
            "SURVIVAL_DECISION": "当前 Demo 的生存与退路选择复查",
        }.get(taxonomy_id, "当前 Demo 的生存选择复查")
        habit_clusters.append(
            ReplayHabitCluster(
                id="habit:survival-decision-current-match",
                title=habit_title,
                taxonomy_id=taxonomy_id,
                cue_ids=cue_ids,
                occurrence_count=len(cue_ids),
                opportunity_count=len(cue_ids),
            )
        )
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
                "当前 plan 只生成少量事实型受击前后选择复查点；没有可靠证据时不声称职业水平、意图或决策错误。",
                "完整 canonical 区间由 teaching segments 与 round_number=0 的 inter-round gap segments 覆盖。",
            ],
        ),
    )

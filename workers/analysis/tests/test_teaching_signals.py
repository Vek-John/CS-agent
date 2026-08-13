from __future__ import annotations

from cs2_demo_parser.models import TeamSide, WorldPoint
from cs2_demo_parser.replay_models import (
    ReplayActiveItem,
    ReplayEvent,
    ReplayMatchPlayer,
    ReplayMatchTimeline,
    ReplayPlayerStateSample,
    ReplayRoundTimeline,
)
from cs2_demo_parser.review_planner import build_review_plan
from cs2_demo_parser.teaching_signals import detect_teaching_signals


def _timeline() -> ReplayMatchTimeline:
    return ReplayMatchTimeline(
        id="timeline-coaching",
        demo_id="demo-coaching",
        source_kind="PARSED_DEMO",
        map_name="de_mirage",
        tick_rate=64.0,
        start_tick=0,
        end_tick=256,
        selected_player_id="player",
        players=[
            ReplayMatchPlayer(
                player_id="player",
                display_name="Player",
                side=TeamSide.T,
                is_selected=True,
            ),
            ReplayMatchPlayer(
                player_id="opponent",
                display_name="Opponent",
                side=TeamSide.CT,
                is_selected=False,
            ),
        ],
        rounds=[
            ReplayRoundTimeline(
                round_number=1,
                start_tick=0,
                freeze_end_tick=0,
                end_tick=256,
                score_before=(0, 0),
                score_after=(1, 0),
                winner=TeamSide.T,
            )
        ],
        timeline_version="timeline.v1",
    )


def _sample(*, tick: int, health: float, armor: float, item_id: str) -> ReplayPlayerStateSample:
    return ReplayPlayerStateSample(
        player_id="player",
        tick=tick,
        side=TeamSide.T,
        world_position=WorldPoint(x=10, y=20, z=30),
        yaw=0,
        pitch=0,
        alive=True,
        health=health,
        armor=armor,
        has_helmet=True,
        active_item=ReplayActiveItem(item_id=item_id, item_class="rifle"),
        fact_refs=[f"ps:player:{tick}"],
    )


def _event(
    *,
    id_: str,
    event_type: str,
    tick: int,
    payload: dict[str, object] | None = None,
) -> ReplayEvent:
    return ReplayEvent(
        id=id_,
        event_type=event_type,
        tick=tick,
        actor_player_id="opponent",
        target_player_id="player",
        source_parser_event="player_hurt" if event_type == "DAMAGE" else "player_death",
        fact_refs=[id_],
        payload=payload or {},
    )


def _cue_for(events: list[ReplayEvent], sample: ReplayPlayerStateSample):
    timeline = _timeline()
    signals = detect_teaching_signals(
        timeline=timeline,
        selected_player_id="player",
        events=events,
    )
    plan = build_review_plan(
        timeline=timeline,
        selected_player_id="player",
        state_samples=[sample],
        events=events,
        observable_states=[],
        signals=signals,
        parser_version="test-parser",
    )
    assert len(plan.cues) == 1
    return signals[0], plan.cues[0]


def test_damage_after_pause_is_not_presented_as_pre_pause_contact() -> None:
    death = _event(id_="e:death", event_type="PLAYER_DEATH", tick=150)
    later_damage = _event(
        id_="e:later-damage",
        event_type="DAMAGE",
        tick=90,
        payload={"damage_health": 35},
    )

    signal, cue = _cue_for([later_damage, death], _sample(tick=0, health=100, armor=50, item_id="weapon_ak47"))

    # The planned pause is tick 54, while the only damage is tick 90. It is a
    # later result event and must not turn the decision-side narrative into
    # an "after contact" explanation.
    assert signal.decision_tick == 54
    assert signal.outcome_start_tick == signal.decision_tick
    assert signal.outcome_start_tick < signal.event_tick <= signal.outcome_end_tick
    assert signal.prior_damage_event_ids == ()
    assert signal.taxonomy_id == "PRE_CONTACT_SURVIVAL_DECISION"
    assert cue.title == "还没受击时，先把退路留住"
    assert "100 HP / 50 甲（有头盔） / 手持 AK-47" in cue.question
    assert "还没有记录到你已经受伤" in cue.question
    assert "接触后" not in cue.question
    assert not [fact for fact in cue.facts if fact.id.endswith(":contact")]
    assert cue.observable_fact_refs == [f"fact:{signal.id}:self"]
    assert cue.inferences[0].fact_refs == cue.observable_fact_refs
    assert cue.advice[0].fact_refs == cue.observable_fact_refs


def test_pre_pause_damage_makes_specific_self_state_coaching_without_enemy_truth() -> None:
    damage = _event(
        id_="e:damage",
        event_type="DAMAGE",
        tick=30,
        payload={"damage_health": 35, "damage_armor": 10},
    )
    death = _event(id_="e:death", event_type="PLAYER_DEATH", tick=150)

    signal, cue = _cue_for([damage, death], _sample(tick=54, health=65, armor=90, item_id="weapon_m4a1"))

    assert signal.taxonomy_id == "CONTACT_SURVIVAL_AFTER_DAMAGE"
    assert signal.prior_damage_event_ids == ("e:damage",)
    assert signal.outcome_start_tick == signal.decision_tick
    assert signal.outcome_start_tick < signal.event_tick <= signal.outcome_end_tick
    assert cue.title == "吃到伤害后，下一步怎么打？"
    self_fact = next(fact for fact in cue.facts if fact.id.endswith(":self"))
    damage_fact = next(fact for fact in cue.facts if fact.id.endswith(":contact"))
    assert "65 HP / 90 甲（有头盔） / 手持 M4A4" in self_fact.text
    assert "1 次受伤（合计 35 点生命伤害、合计 10 点护甲伤害）" in damage_fact.text
    assert "不推断对手身份、位置" in damage_fact.text
    assert "opponent" not in cue.question
    assert "敌方位置" not in cue.question
    assert "若有明确同步指令" in cue.advice[0].text
    assert cue.inferences[0].fact_refs == cue.observable_fact_refs
    assert cue.advice[0].fact_refs == cue.observable_fact_refs

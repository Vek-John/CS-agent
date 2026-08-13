from __future__ import annotations

from cs2_demo_parser.grenades import build_grenade_tracks
from cs2_demo_parser.models import GrenadeTrajectoryRow, TeamSide, WorldPoint
from cs2_demo_parser.replay_models import (
    ReplayEvent,
    ReplayMatchPlayer,
    ReplayMatchTimeline,
    ReplayRoundTimeline,
)


def _timeline() -> ReplayMatchTimeline:
    return ReplayMatchTimeline(
        id="timeline-grenade-test",
        demo_id="demo-grenade-test",
        source_kind="PARSED_DEMO",
        map_name="de_mirage",
        tick_rate=64.0,
        start_tick=0,
        end_tick=200,
        selected_player_id="p1",
        players=[ReplayMatchPlayer(player_id="p1", display_name="P1", side=TeamSide.T, is_selected=True)],
        rounds=[
            ReplayRoundTimeline(
                round_number=1,
                start_tick=0,
                freeze_end_tick=0,
                end_tick=200,
                score_before=(0, 0),
                score_after=(1, 0),
                winner=TeamSide.T,
            )
        ],
        timeline_version="timeline.v1",
    )


def _row(tick: int, x: float) -> GrenadeTrajectoryRow:
    return GrenadeTrajectoryRow(
        grenade_type="CHEGrenadeProjectile",
        grenade_entity_id=7,
        tick=tick,
        thrower_player_id="p1",
        thrower_display_name="P1",
        world_position=WorldPoint(x=x, y=0, z=0),
    )


def test_grenade_track_uses_event_lifecycle_and_compresses_real_rows() -> None:
    rows = [_row(tick, float(tick)) for tick in range(10, 51)]
    events = [
        ReplayEvent(
            id="e:detonate",
            event_type="GRENADE_DETONATE",
            tick=50,
            actor_player_id="p1",
            world_origin=WorldPoint(x=50, y=0, z=0),
            payload={"entityid": 7},
            source_parser_event="hegrenade_detonate",
            fact_refs=["e:detonate"],
        )
    ]

    result = build_grenade_tracks(timeline=_timeline(), rows=rows, events=events)

    assert len(result.tracks) == 1
    track = result.tracks[0]
    assert track.grenade_type == "HE_GRENADE"
    assert track.thrower_player_id == "p1"
    assert track.start_tick == 10
    assert track.detonate_tick == 50
    assert track.end_tick == 50
    assert track.samples[-1].tick == 50
    assert track.samples[-1].sample_kind == "END"
    assert len(track.samples) < len(rows)
    assert "e:detonate" in track.fact_refs
    assert result.coverage.input_rows == len(rows)
    assert result.coverage.output_tracks == 1
    assert result.coverage.tracks_with_detonate == 1


def test_no_lifecycle_or_coordinate_is_fabricated() -> None:
    rows = [_row(10, 10), _row(11, 11), _row(12, 12)]
    result = build_grenade_tracks(timeline=_timeline(), rows=rows, events=[])

    assert len(result.tracks) == 1
    track = result.tracks[0]
    assert track.detonate_tick is None
    assert track.expire_tick is None
    assert track.end_tick == 12
    assert all(sample.world_position.x in {10, 11, 12} for sample in track.samples)
    assert any("detonate_tick" in limitation for limitation in track.limitations)


def test_inferno_lifecycle_can_join_by_thrower_when_entity_id_changes() -> None:
    rows = [
        GrenadeTrajectoryRow(
            grenade_type="CMolotovProjectile",
            grenade_entity_id=417,
            tick=tick,
            thrower_player_id="p1",
            thrower_display_name="P1",
            world_position=WorldPoint(x=float(tick), y=0, z=0),
        )
        for tick in range(20, 30)
    ]
    events = [
        ReplayEvent(
            id="e:burn",
            event_type="UTILITY",
            tick=30,
            actor_player_id="p1",
            payload={"entityid": 421},
            source_parser_event="inferno_startburn",
            fact_refs=["e:burn"],
        ),
        ReplayEvent(
            id="e:expire",
            event_type="UTILITY",
            tick=80,
            actor_player_id="p1",
            world_origin=WorldPoint(x=30, y=0, z=0),
            payload={"entityid": 421},
            source_parser_event="inferno_expire",
            fact_refs=["e:expire"],
        ),
    ]

    result = build_grenade_tracks(timeline=_timeline(), rows=rows, events=events)

    track = result.tracks[0]
    assert track.detonate_tick == 30
    assert track.expire_tick == 80
    assert track.end_tick == 80
    assert any("entity ID" in limitation for limitation in track.limitations)

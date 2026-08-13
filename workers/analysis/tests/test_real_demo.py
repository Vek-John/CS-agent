from __future__ import annotations

import os
from pathlib import Path

import pytest

from cs2_demo_parser import DemoParserAdapter, FULL_STATE_FIELDS, TeamSide


ROOT = Path(__file__).resolve().parents[3]
SMALL_DEMO = ROOT / "demoTests" / "test_demo.dem"
LARGE_DEMO = ROOT / "demoTests" / "spirit-vs-falcons-m2-mirage.dem"


@pytest.mark.integration
def test_small_demo_core_facts() -> None:
    pytest.importorskip("demoparser2")
    adapter = DemoParserAdapter()

    metadata = adapter.inspect(SMALL_DEMO)
    assert metadata.map_name == "de_mirage"
    assert metadata.parser_version == "0.42.0"

    players = adapter.read_players(SMALL_DEMO)
    assert len(players.players) == 10
    assert all(player.player_id.isdigit() for player in players.players)

    rounds = adapter.read_rounds(SMALL_DEMO)
    assert len(rounds.rounds) == 10
    assert [round.canonical_round_number for round in rounds.rounds] == list(range(1, 11))
    assert all(round.source_round_number is None for round in rounds.rounds)
    assert all(round.half_number is None for round in rounds.rounds)
    assert all(round.start_tick >= 0 for round in rounds.rounds)
    warning_codes = {warning.code for warning in rounds.warnings}
    assert "ROUND_NUMBER_UNAVAILABLE" in warning_codes
    assert "HALF_NUMBER_UNAVAILABLE" in warning_codes

    events = adapter.read_events(SMALL_DEMO, ["player_death", "bomb_planted"])
    assert len([event for event in events.events if event.event_type == "player_death"]) == 73
    assert len([event for event in events.events if event.event_type == "bomb_planted"]) == 7
    assert all(event.tick >= 0 for event in events.events)
    # A few parser events occur in inter-round/post-demo gaps rather than in
    # a valid round interval; they remain explicitly unassigned with warning.
    assert all(
        event.canonical_round_number is None
        or event.canonical_round_number in range(1, 11)
        for event in events.events
    )
    assert all(event.source_round_number is None for event in events.events)
    assert any(event.canonical_round_number is None for event in events.events)
    assert {
        warning.details.get("event_type")
        for warning in events.warnings
        if warning.code == "CANONICAL_ROUND_UNAVAILABLE"
    } == {"player_death", "bomb_planted"}
    assert events.events == sorted(events.events, key=lambda event: (event.tick, event.event_type))

    trajectory = adapter.read_trajectory(
        SMALL_DEMO,
        player_ids=[players.players[0].player_id],
        ticks=[1, 65],
        fields=["x", "y", "z", "health", "team_number", "is_alive"],
    )
    assert len(trajectory.samples) == 2
    assert {sample.tick for sample in trajectory.samples} == {1, 65}
    assert all(sample.player_id == players.players[0].player_id for sample in trajectory.samples)
    assert all(sample.team_number in {2, 3} for sample in trajectory.samples)
    assert all(sample.side in {TeamSide.T, TeamSide.CT} for sample in trajectory.samples)
    assert all(sample.is_alive is not None for sample in trajectory.samples)

    selected = next(player for player in players.players if player.display_name == "123")
    full_state = adapter.read_trajectory(
        SMALL_DEMO,
        player_ids=[selected.player_id],
        ticks=[1],
        fields=FULL_STATE_FIELDS,
    )
    assert len(full_state.samples) == 1
    sample = full_state.samples[0]
    assert sample.current_weapon is not None
    assert sample.inventory_names is not None
    assert sample.inventory_item_ids is not None
    assert sample.inventory_bitmask is not None
    assert sample.total_ammo_left is not None
    assert sample.armor is not None
    assert sample.has_helmet is not None
    assert sample.has_defuser is not None
    assert sample.money is not None
    assert sample.c4_carrier is None
    missing_codes = {warning.code for warning in full_state.warnings}
    assert "TRAJECTORY_FIELD_UNAVAILABLE" in missing_codes


@pytest.mark.integration
def test_small_demo_sound_damage_grenade_and_bomb_facts() -> None:
    pytest.importorskip("demoparser2")
    adapter = DemoParserAdapter()
    result = adapter.read_events(
        SMALL_DEMO,
        [
            "player_footstep",
            "player_sound",
            "footstep",
            "weapon_fire",
            "fire_bullets",
            "player_hurt",
            "hegrenade_detonate",
            "flashbang_detonate",
            "smokegrenade_detonate",
            "inferno_startburn",
            "inferno_expire",
            "smokegrenade_expired",
            "bomb_planted",
            "bomb_pickup",
            "bomb_dropped",
            "bomb_defused",
            "bomb_exploded",
        ],
    )
    by_type = {}
    for event in result.events:
        by_type.setdefault(event.event_type, []).append(event)
    assert len(by_type["player_footstep"]) == 512
    assert len(by_type["weapon_fire"]) == 1590
    assert len(by_type["fire_bullets"]) == 1242
    assert len(by_type["player_hurt"]) == 264
    assert len(by_type["hegrenade_detonate"]) == 34
    assert len(by_type["flashbang_detonate"]) == 48
    assert len(by_type["smokegrenade_detonate"]) == 40
    assert len(by_type["inferno_startburn"]) == 25
    assert len(by_type["inferno_expire"]) == 25
    assert len(by_type["smokegrenade_expired"]) == 38
    assert len(by_type["bomb_planted"]) == 7
    assert len(by_type["bomb_pickup"]) == 21
    assert len(by_type["bomb_dropped"]) == 14
    assert len(by_type["bomb_defused"]) == 1
    assert len(by_type["bomb_exploded"]) == 2
    assert by_type["player_footstep"][0].actor is not None
    assert by_type["weapon_fire"][0].actor is not None
    assert "sound_type" in by_type["fire_bullets"][0].details
    assert by_type["fire_bullets"][0].world_origin is not None
    assert by_type["hegrenade_detonate"][0].world_origin is not None
    assert by_type["flashbang_detonate"][0].world_origin is not None
    assert by_type["smokegrenade_detonate"][0].world_origin is not None
    assert by_type["inferno_startburn"][0].world_origin is not None
    assert by_type["inferno_expire"][0].world_origin is not None
    assert by_type["smokegrenade_expired"][0].world_origin is not None
    assert by_type["player_footstep"][0].world_origin is None
    assert by_type["weapon_fire"][0].world_origin is None
    assert by_type["player_hurt"][0].target is not None
    assert by_type["player_hurt"][0].world_origin is None
    assert by_type["hegrenade_detonate"][0].actor is not None
    assert by_type["bomb_planted"][0].world_origin is None
    assert by_type["bomb_planted"][0].site in {"184", "185"}
    warning_codes = {warning.code for warning in result.warnings}
    assert "EVENT_UNAVAILABLE" in warning_codes
    missing_origin_events = {
        warning.details.get("event_type")
        for warning in result.warnings
        if warning.code == "EVENT_WORLD_ORIGIN_UNAVAILABLE"
    }
    assert {"player_footstep", "weapon_fire", "player_hurt", "bomb_planted"} <= missing_origin_events


@pytest.mark.integration
def test_small_demo_parse_grenades_exposes_real_trajectory_columns() -> None:
    pytest.importorskip("demoparser2")
    adapter = DemoParserAdapter()

    result = adapter.read_grenades(SMALL_DEMO)

    assert result.fields == [
        "grenade_type",
        "grenade_entity_id",
        "x",
        "y",
        "z",
        "tick",
        "steamid",
        "name",
    ]
    assert result.rows
    assert any(row.world_position is not None for row in result.rows)
    assert {row.grenade_type for row in result.rows} >= {"CSmokeGrenadeProjectile", "CFlashbangProjectile"}
    assert all(row.grenade_entity_id > 0 for row in result.rows)


@pytest.mark.integration
@pytest.mark.slow
def test_large_demo_header_and_players_opt_in() -> None:
    if os.environ.get("CS2_RUN_LARGE_DEMO_TESTS") != "1":
        pytest.skip("Set CS2_RUN_LARGE_DEMO_TESTS=1 to exercise the 433 MB Demo.")
    pytest.importorskip("demoparser2")
    adapter = DemoParserAdapter()
    assert adapter.inspect(LARGE_DEMO).map_name == "de_mirage"
    assert len(adapter.read_players(LARGE_DEMO).players) == 10
    rounds = adapter.read_rounds(LARGE_DEMO)
    assert len(rounds.rounds) == 21
    assert (
        rounds.rounds[0].start_tick,
        rounds.rounds[0].end_tick,
        rounds.rounds[0].winner,
    ) == (1, 4_744, TeamSide.CT)
    assert all(item.end_tick is not None and item.winner is not None for item in rounds.rounds)
    incomplete = [warning for warning in rounds.warnings if warning.code == "ROUND_END_INCOMPLETE"]
    assert [warning.details for warning in incomplete] == [{"tick": 1, "source_round_number": 0}]

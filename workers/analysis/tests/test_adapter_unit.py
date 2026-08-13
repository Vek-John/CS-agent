from __future__ import annotations

from pathlib import Path

import pytest

from cs2_demo_parser import (
    DemoFileError,
    DemoParserAdapter,
    DemoRequestError,
    TeamSide,
)


class FakeParser:
    def __init__(self, _path: str) -> None:
        pass

    def parse_header(self):
        return {"map_name": "de_mirage", "patch_version": "test"}

    def parse_player_info(self):
        return [
            {"steamid": 76561197960265728, "name": "T player", "team_number": 2},
            {"steamid": "76561197960265729", "name": "CT player", "team_number": 3},
        ]

    def parse_event(self, event_name: str):
        rows = {
            "round_start": [{"tick": 10}, {"tick": 100}],
            "round_freeze_end": [{"tick": 20}, {"tick": 110}],
            "round_end": [
                {"tick": 90, "winner": 2},
                {"tick": 180, "winner": "CT"},
            ],
            "round_officially_ended": [],
            "player_death": [
                {
                    "tick": 55,
                    "attacker_steamid": 76561197960265728,
                    "attacker_name": "T player",
                    "user_steamid": "76561197960265729",
                    "user_name": "CT player",
                    "weapon": "ak47",
                    "dmg_health": 100,
                    "headshot": True,
                }
            ],
            "weapon_fire": [
                {
                    "tick": 100,
                    "user_steamid": 76561197960265728,
                    "user_name": "T player",
                    "weapon": "ak47",
                }
            ],
        }
        return rows.get(event_name, [])

    def list_game_events(self):
        return ["player_death"]

    def parse_ticks(self, wanted_props, *, players=None, ticks=None, **_kwargs):
        assert wanted_props == ["X", "Y", "team_num"]
        return [
            {
                "X": 1,
                "Y": 2.5,
                "team_num": 2,
                "tick": 55,
                "steamid": 76561197960265728,
                "name": "T player",
            }
        ]

    def parse_grenades(self, **_kwargs):
        return [
            {
                "grenade_type": "CHEGrenadeProjectile",
                "grenade_entity_id": 7,
                "x": 1,
                "y": 2,
                "z": 3,
                "tick": 55,
                "steamid": 76561197960265728,
                "name": "T player",
            },
            {
                "grenade_type": "CHEGrenade",
                "grenade_entity_id": 7,
                "x": None,
                "y": None,
                "z": None,
                "tick": 56,
                "steamid": 76561197960265728,
                "name": "T player",
            },
        ]


class BoundaryParser(FakeParser):
    def parse_event(self, event_name: str):
        rows = {
            "round_start": [{"tick": 10, "round": 40}, {"tick": 100, "round": 41}],
            "round_freeze_end": [{"tick": 20, "round": 40}, {"tick": 110, "round": 41}],
            "round_end": [
                {"tick": 100, "winner": 2},
                {"tick": 180, "winner": "CT"},
            ],
            "round_officially_ended": [],
            "player_death": [
                {
                    "tick": 55,
                    "round": 40,
                    "attacker_steamid": 76561197960265728,
                    "attacker_name": "T player",
                    "user_steamid": "76561197960265729",
                    "user_name": "CT player",
                    "weapon": "ak47",
                }
            ],
            "weapon_fire": [
                {
                    "tick": 100,
                    "round": 41,
                    "user_steamid": 76561197960265728,
                    "user_name": "T player",
                    "weapon": "ak47",
                }
            ],
        }
        return rows.get(event_name, [])


class SwapParser(FakeParser):
    def parse_ticks(self, wanted_props, *, players=None, ticks=None, **_kwargs):
        assert wanted_props == ["X", "Y", "team_num"]
        return [
            {
                "X": 1,
                "Y": 2,
                "team_num": 2,
                "tick": 55,
                "steamid": 76561197960265728,
            },
            {
                "X": 3,
                "Y": 4,
                "team_num": 3,
                "tick": 65,
                "steamid": 76561197960265728,
            },
        ]


@pytest.fixture
def adapter() -> DemoParserAdapter:
    return DemoParserAdapter(parser_factory=FakeParser, parser_version="fake-1")


def test_fake_parser_normalizes_public_models(adapter: DemoParserAdapter, tmp_path: Path) -> None:
    demo = tmp_path / "fixture.dem"
    demo.write_bytes(b"demo")

    metadata = adapter.inspect(demo)
    assert metadata.map_name == "de_mirage"
    assert metadata.parser_version == "fake-1"

    players = adapter.read_players(demo)
    assert [player.player_id for player in players.players] == [
        "76561197960265728",
        "76561197960265729",
    ]
    assert players.players[0].team is TeamSide.T
    assert players.players[1].team is TeamSide.CT

    rounds = adapter.read_rounds(demo)
    assert len(rounds.rounds) == 2
    assert rounds.rounds[0].start_tick == 10
    assert rounds.rounds[0].canonical_round_number == 1
    assert rounds.rounds[0].source_round_number is None
    assert rounds.rounds[0].freeze_end_tick == 20
    assert rounds.rounds[0].end_tick == 90
    assert rounds.rounds[0].winner is TeamSide.T
    warning_codes = {warning.code for warning in rounds.warnings}
    assert "ROUND_NUMBER_UNAVAILABLE" in warning_codes
    assert "HALF_NUMBER_UNAVAILABLE" in warning_codes

    events = adapter.read_events(demo, ["player_death"])
    assert len(events.events) == 1
    death = events.events[0]
    assert death.actor is not None and death.actor.player_id == "76561197960265728"
    assert death.target is not None and death.target.player_id == "76561197960265729"
    assert death.weapon == "ak47"
    assert death.details["damage_health"] == 100
    assert death.canonical_round_number == 1
    assert death.source_round_number is None  # parser did not expose a source round number

    trajectory = adapter.read_trajectory(demo, fields=["x", "y"])
    assert trajectory.fields == ["x", "y"]
    assert trajectory.samples[0].player_id == "76561197960265728"
    assert trajectory.samples[0].x == 1.0
    assert trajectory.samples[0].y == 2.5
    assert trajectory.samples[0].z is None
    assert trajectory.samples[0].side is TeamSide.T


def test_round_source_and_same_tick_boundary_assignment(tmp_path: Path) -> None:
    adapter = DemoParserAdapter(parser_factory=BoundaryParser, parser_version="fake-boundary")
    demo = tmp_path / "fixture.dem"
    demo.write_bytes(b"demo")

    rounds = adapter.read_rounds(demo).rounds
    assert [(item.canonical_round_number, item.source_round_number) for item in rounds] == [(1, 40), (2, 41)]

    events = adapter.read_events(
        demo,
        ["round_end", "round_start", "weapon_fire", "player_death"],
    ).events
    by_type: dict[str, list] = {}
    for event in events:
        by_type.setdefault(event.event_type, []).append(event)
    first_end = by_type["round_end"][0]
    assert first_end.tick == 100
    assert first_end.canonical_round_number == 1
    assert first_end.source_round_number is None
    assert by_type["round_start"][1].canonical_round_number == 2
    assert by_type["round_start"][1].source_round_number == 41
    assert by_type["weapon_fire"][0].canonical_round_number == 2
    assert by_type["weapon_fire"][0].source_round_number == 41
    assert by_type["player_death"][0].canonical_round_number == 1
    assert by_type["player_death"][0].source_round_number == 40


def test_trajectory_side_is_derived_per_row_not_from_player_summary(tmp_path: Path) -> None:
    adapter = DemoParserAdapter(parser_factory=SwapParser, parser_version="fake-swap")
    demo = tmp_path / "fixture.dem"
    demo.write_bytes(b"demo")

    result = adapter.read_trajectory(demo, fields=["x", "y"])
    assert [sample.side for sample in result.samples] == [TeamSide.T, TeamSide.CT]
    assert all(sample.team_number is None for sample in result.samples)


def test_grenade_parser_rows_keep_real_coordinates_and_lifecycle_rows(adapter: DemoParserAdapter, tmp_path: Path) -> None:
    demo = tmp_path / "fixture.dem"
    demo.write_bytes(b"demo")

    result = adapter.read_grenades(demo)

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
    assert len(result.rows) == 2
    assert result.rows[0].thrower_player_id == "76561197960265728"
    assert result.rows[0].world_position is not None
    assert result.rows[1].world_position is None


def test_missing_file_is_recoverable(adapter: DemoParserAdapter, tmp_path: Path) -> None:
    with pytest.raises(DemoFileError) as error:
        adapter.inspect(tmp_path / "missing.dem")
    assert error.value.code == "DEMO_FILE_ERROR"
    assert "missing.dem" in str(error.value)


def test_invalid_trajectory_request_is_recoverable(adapter: DemoParserAdapter, tmp_path: Path) -> None:
    demo = tmp_path / "fixture.dem"
    demo.write_bytes(b"demo")
    with pytest.raises(DemoRequestError):
        adapter.read_trajectory(demo, fields=["future_field"])
    with pytest.raises(DemoRequestError):
        adapter.read_trajectory(demo, player_ids=["not-a-steamid"])

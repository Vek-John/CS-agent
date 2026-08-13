from __future__ import annotations

import json
from pathlib import Path

from cs2_demo_parser.build_replay import (
    DEFAULT_SAMPLING_STRIDE_TICKS,
    _build_state_sample,
    _event_model,
    build_replay_bundle,
)
from cs2_demo_parser.observation import build_observable_states
from cs2_demo_parser.models import (
    DemoMetadata,
    EventParticipant,
    EventRecord,
    EventsResult,
    PlayerRecord,
    PlayersResult,
    RoundRecord,
    RoundsResult,
    TeamSide,
    TrajectoryResult,
    TrajectorySample,
    WorldPoint,
)
from cs2_demo_parser.replay_models import (
    ReplayEvent,
    ReplayMatchPlayer,
    ReplayMatchTimeline,
    ReplayPlayerStateSample,
    ReplayRoundTimeline,
)


def _sample(*, names: list[str], current_weapon: str | None = "AK-47") -> TrajectorySample:
    return TrajectorySample(
        player_id="1",
        tick=24,
        x=10,
        y=20,
        z=30,
        pitch=1,
        yaw=2,
        health=100,
        team_number=2,
        side=TeamSide.T,
        is_alive=True,
        current_weapon=current_weapon,
        inventory_names=names,
        inventory_item_ids=[1 for _ in names],
        armor=50,
        has_helmet=True,
        has_defuser=False,
        money=800,
    )


def test_state_builder_keeps_inventory_counts_and_direct_c4_only() -> None:
    warnings = []
    built = _build_state_sample(
        _sample(names=["knife_t", "C4 Explosive"]),
        player_ordinals={"1": 3},
        warnings=warnings,
    )

    assert built is not None
    assert built.fact_refs == ["ps:3:24"]
    assert [item.item_id for item in built.inventory] == ["weapon_knife_t", "weapon_c4"]
    assert all(item.count == 1 for item in built.inventory)
    assert built.carries_c4 is True
    assert "inventory_quantities" not in built.missing_fields

    without_c4 = _build_state_sample(
        _sample(names=["knife_t"]),
        player_ordinals={"1": 3},
        warnings=warnings,
    )
    assert without_c4 is not None
    assert without_c4.carries_c4 is None
    assert "carries_c4" in without_c4.missing_fields


def test_event_builder_maps_type_and_drops_parser_bookkeeping() -> None:
    event = EventRecord(
        event_type="player_hurt",
        tick=12,
        actor=EventParticipant(player_id="1"),
        target=EventParticipant(player_id="2"),
        weapon="AK-47",
        world_origin=WorldPoint(x=1, y=2, z=3),
        details={"damage_health": 27, "canonical_round_number": 1, "raw_parser_noise": "drop"},
    )

    built = _event_model(event, 7)

    assert built.id == "e:7"
    assert built.fact_refs == ["e:7"]
    assert built.event_type == "DAMAGE"
    assert built.item_id == "weapon_ak47"
    assert built.payload == {"damage_health": 27}
    assert built.source_parser_event == "player_hurt"


class _StubAdapter:
    parser_version = "stub"

    def inspect(self, path: Path) -> DemoMetadata:
        return DemoMetadata(
            parser_version=self.parser_version,
            path=str(path),
            file_size_bytes=path.stat().st_size,
            map_name="de_mirage",
        )

    def read_players(self, path: Path) -> PlayersResult:
        return PlayersResult(
            parser_version=self.parser_version,
            players=[PlayerRecord(player_id="1", display_name="T", team=TeamSide.T, team_number=2)],
        )

    def read_rounds(self, path: Path) -> RoundsResult:
        return RoundsResult(
            parser_version=self.parser_version,
            rounds=[RoundRecord(canonical_round_number=1, start_tick=0, freeze_end_tick=16, end_tick=48, winner=TeamSide.T)],
        )

    def read_events(self, path: Path, event_names: tuple[str, ...]) -> EventsResult:
        return EventsResult(
            parser_version=self.parser_version,
            events=[EventRecord(event_type="weapon_fire", tick=24, actor=EventParticipant(player_id="1"))],
        )

    def read_trajectory(self, path: Path, **kwargs: object) -> TrajectoryResult:
        return TrajectoryResult(
            parser_version=self.parser_version,
            fields=[],
            samples=[_sample(names=["knife_t"], current_weapon="AK-47")],
        )


def test_build_smoke_records_sampling_contract(tmp_path: Path) -> None:
    demo = tmp_path / "tiny.dem"
    demo.write_bytes(b"tiny-demo")

    bundle = build_replay_bundle(demo, parser=_StubAdapter())

    assert DEFAULT_SAMPLING_STRIDE_TICKS == 24
    assert bundle.generation_manifest.sampling_stride_ticks == 24
    assert bundle.match_timeline.source_kind == "PARSED_DEMO"
    assert bundle.player_state_tracks
    assert bundle.events[0].event_type == "WEAPON_FIRE"
    assert bundle.review_plan is not None
    assert bundle.review_plan.status == "COMPLETE"
    assert bundle.review_plan.cues == []
    assert bundle.review_plan.segments[0].start_tick == bundle.match_timeline.start_tick
    assert bundle.review_plan.segments[-1].end_tick == bundle.match_timeline.end_tick
    second = build_replay_bundle(demo, parser=_StubAdapter())
    assert bundle.model_dump(mode="json") == second.model_dump(mode="json")


class _DeathAndBoundaryAdapter(_StubAdapter):
    def read_events(self, path: Path, event_names: tuple[str, ...]) -> EventsResult:
        return EventsResult(
            parser_version=self.parser_version,
            events=[
                EventRecord(
                    event_type="player_hurt",
                    tick=12,
                    actor=EventParticipant(player_id="2"),
                    target=EventParticipant(player_id="1"),
                ),
                EventRecord(
                    event_type="player_death",
                    tick=30,
                    actor=EventParticipant(player_id="2"),
                    target=EventParticipant(player_id="1"),
                ),
                EventRecord(
                    event_type="player_death",
                    tick=80,
                    actor=EventParticipant(player_id="2"),
                    target=EventParticipant(player_id="1"),
                ),
            ],
        )

    def read_trajectory(self, path: Path, **kwargs: object) -> TrajectoryResult:
        sample = _sample(names=["knife_t"], current_weapon="AK-47").model_copy(update={"tick": 0})
        return TrajectoryResult(parser_version=self.parser_version, fields=[], samples=[sample])


class _TenPlayerAdapter(_StubAdapter):
    player_ids = tuple(str(index) for index in range(1, 11))

    def read_players(self, path: Path) -> PlayersResult:
        return PlayersResult(
            parser_version=self.parser_version,
            players=[
                PlayerRecord(player_id=player_id, display_name=f"P{player_id}", team=TeamSide.T, team_number=2)
                for player_id in self.player_ids
            ],
        )

    def read_trajectory(self, path: Path, **kwargs: object) -> TrajectoryResult:
        return TrajectoryResult(
            parser_version=self.parser_version,
            fields=[],
            samples=[
                _sample(names=["knife_t"], current_weapon="AK-47").model_copy(
                    update={"player_id": player_id, "tick": 0, "x": float(index)}
                )
                for index, player_id in enumerate(self.player_ids)
            ],
        )


def _mini_timeline() -> ReplayMatchTimeline:
    return ReplayMatchTimeline(
        id="timeline-mini",
        demo_id="demo-mini",
        source_kind="PARSED_DEMO",
        map_name="de_mirage",
        tick_rate=64.0,
        start_tick=0,
        end_tick=128,
        selected_player_id="p1",
        players=[
            ReplayMatchPlayer(player_id="p1", display_name="P1", side=TeamSide.T, is_selected=True),
            ReplayMatchPlayer(player_id="p2", display_name="P2", side=TeamSide.CT, is_selected=False),
        ],
        rounds=[
            ReplayRoundTimeline(
                round_number=1,
                start_tick=0,
                freeze_end_tick=0,
                end_tick=128,
                score_before=(0, 0),
                score_after=(1, 0),
                winner=TeamSide.T,
            )
        ],
        timeline_version="timeline.v1",
    )


def _state_sample(player_id: str, side: TeamSide, tick: int, x: float, y: float) -> ReplayPlayerStateSample:
    return ReplayPlayerStateSample(
        player_id=player_id,
        tick=tick,
        side=side,
        world_position=WorldPoint(x=x, y=y, z=64),
        yaw=0,
        pitch=0,
        alive=True,
        health=100,
        armor=100,
        has_helmet=True,
        fact_refs=[f"ps:{player_id}:{tick}"],
    )


def test_sound_claim_uses_observer_bound_coarse_direction_only() -> None:
    timeline = _mini_timeline()
    samples = [
        _state_sample("p1", TeamSide.T, 0, 0, 0),
        _state_sample("p1", TeamSide.T, 24, 0, 0),
        _state_sample("p2", TeamSide.CT, 0, 300, 0),
        _state_sample("p2", TeamSide.CT, 24, 300, 0),
    ]
    event = ReplayEvent(
        id="e:sound",
        event_type="FOOTSTEP",
        tick=24,
        actor_player_id="p2",
        source_parser_event="player_footstep",
        fact_refs=["e:sound"],
    )

    observer_one = build_observable_states(
        timeline=timeline,
        observer_player_id="p1",
        state_samples=samples,
        events=[event],
        checkpoint_ticks=[24],
    )
    sound_claims = [
        claim
        for state in observer_one
        for claim in state.claims
        if claim.source_type == "FOOTSTEP"
    ]
    assert sound_claims
    claim = sound_claims[0]
    assert claim.subject_resolution == "UNKNOWN_ACTOR"
    assert claim.subject_ref is None
    assert claim.spatial_estimate["type"] == "DIRECTION_SECTOR"
    assert claim.audibility_assessment is not None
    assert claim.audibility_assessment["result"] == "POSSIBLY_AUDIBLE"
    assert "确实听到" in "".join(claim.limitations)
    assert claim.spatial_estimate["type"] != "EXACT_POINT"

    observer_two = build_observable_states(
        timeline=timeline,
        observer_player_id="p2",
        state_samples=samples,
        events=[event],
        checkpoint_ticks=[24],
    )
    assert not [
        claim
        for state in observer_two
        for claim in state.claims
        if claim.source_type == "FOOTSTEP"
    ]


def test_out_of_range_raw_event_is_retained_but_never_enters_analysis(tmp_path: Path) -> None:
    demo = tmp_path / "boundary.dem"
    demo.write_bytes(b"boundary-demo")

    bundle = build_replay_bundle(demo, parser=_DeathAndBoundaryAdapter())

    assert any(event.tick == 80 for event in bundle.events)
    assert bundle.review_plan is not None
    assert len(bundle.review_plan.cues) == 1
    plan_dict = bundle.review_plan.model_dump(mode="json")
    referenced_event_ids = {
        ref
        for cue in plan_dict["cues"]
        for evidence in cue["evidence"]
        for ref in evidence["fact_refs"]
        if ref.startswith("e:")
    }
    assert "e:3" not in referenced_event_ids
    assert all(segment.start_tick >= 0 and segment.end_tick <= 48 for segment in bundle.review_plan.segments)
    assert all(cue.outcome_end_tick <= 48 for cue in bundle.review_plan.cues)
    assert any(warning.code == "REPLAY_EVENT_OUTSIDE_CANONICAL_RANGE" for warning in bundle.warnings)


def test_explicit_selected_player_rebuilds_observation_and_plan_for_all_ten_players(tmp_path: Path) -> None:
    demo = tmp_path / "ten.dem"
    demo.write_bytes(b"ten-player-demo")
    adapter = _TenPlayerAdapter()

    for player_id in adapter.player_ids:
        bundle = build_replay_bundle(demo, parser=adapter, selected_player_id=player_id)
        assert bundle.match_timeline.selected_player_id == player_id
        assert bundle.generation_manifest.analysis_subject_player_id == player_id
        assert bundle.generation_manifest.analysis_subject_selection == "EXPLICIT_PLAYER"
        assert bundle.review_plan is not None
        assert bundle.review_plan.player_id == player_id
        assert all(state.observer_player_id == player_id for state in bundle.observable_states)
        assert all(
            claim.evidence_tick <= state.at_tick
            and claim.available_from_tick <= state.at_tick
            for state in bundle.observable_states
            for claim in state.claims
        )


def test_checked_in_real_bundle_has_executable_plan_and_sound_boundary() -> None:
    bundle_path = Path(__file__).resolve().parents[3] / "apps/web/public/generated-data/test_demo.replay.json"
    if not bundle_path.exists():
        return
    data = json.loads(bundle_path.read_text(encoding="utf-8"))
    timeline = data["match_timeline"]
    plan = data["review_plan"]
    assert plan is not None
    assert plan["status"] == "COMPLETE"
    assert len(plan["cues"]) >= 4
    assert any(len(cluster["cue_ids"]) >= 2 for cluster in plan["habit_clusters"])
    segments = sorted(plan["segments"], key=lambda segment: segment["start_tick"])
    assert segments[0]["start_tick"] == timeline["start_tick"]
    assert segments[-1]["end_tick"] == timeline["end_tick"]
    for previous, current in zip(segments, segments[1:]):
        assert previous["end_tick"] == current["start_tick"]
    for cue in plan["cues"]:
        assert timeline["start_tick"] <= cue["decision_tick"] < cue["reveal_tick"]
        assert cue["reveal_tick"] <= cue["outcome_start_tick"] < cue["outcome_end_tick"] <= timeline["end_tick"]
        assert all(ref in {fact["id"] for fact in cue["facts"]} for ref in cue["observable_fact_refs"])
        assert all(annotation["coordinate_space"] == "WORLD" for annotation in cue["annotations"])
        assert all("结果" not in annotation["label"] for annotation in cue["annotations"])
    grenade_tracks = data["grenade_tracks"]
    assert grenade_tracks
    assert all({"id", "item_id", "points", "grenade_type"} <= set(track) for track in grenade_tracks)
    assert all("samples" not in track for track in grenade_tracks)
    assert all(track["points"] for track in grenade_tracks)
    assert all(
        timeline["start_tick"] <= point["tick"] <= timeline["end_tick"]
        for track in grenade_tracks
        for point in track["points"]
    )
    assert sum(len(track["points"]) for track in grenade_tracks) < data["coverage"]["grenades"]["valid_position_rows"]
    assert data["coverage"]["grenades"]["output_tracks"] == len(grenade_tracks)
    sound_claims = [
        claim
        for state in data["observable_states"]
        for claim in state["claims"]
        if claim["source_type"] in {"FOOTSTEP", "GUNSHOT"}
    ]
    assert sound_claims
    assert all(claim["subject_resolution"] == "UNKNOWN_ACTOR" for claim in sound_claims)
    assert all("subject_ref" not in claim for claim in sound_claims)
    assert all(claim["spatial_estimate"]["type"] != "EXACT_POINT" for claim in sound_claims)
    assert all(
        claim["audibility_assessment"]["result"] == "POSSIBLY_AUDIBLE"
        for claim in sound_claims
    )
    out_of_range_ids = {
        event["id"]
        for event in data["events"]
        if not timeline["start_tick"] <= event["tick"] < timeline["end_tick"]
    }
    assert out_of_range_ids
    referenced_event_ids = {
        ref
        for cue in plan["cues"]
        for evidence in cue["evidence"]
        for ref in evidence["fact_refs"]
        if ref.startswith("e:")
    }
    assert not (referenced_event_ids & out_of_range_ids)

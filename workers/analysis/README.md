# CS2 Demo Parser Adapter

This package is the Python 3.12 worker-side boundary around
`demoparser2==0.42.0`. It returns Pydantic v2 models containing parser-
verifiable facts only. It does not produce `Inference`, `Advice`, observation
states, teaching signals, or review plans.

## Public interface

```python
from cs2_demo_parser import DemoParserAdapter

adapter = DemoParserAdapter()
metadata = adapter.inspect("demoTests/test_demo.dem")
players = adapter.read_players("demoTests/test_demo.dem")
rounds = adapter.read_rounds("demoTests/test_demo.dem")
events = adapter.read_events("demoTests/test_demo.dem", ["player_death"])
trajectory = adapter.read_trajectory(
    "demoTests/test_demo.dem",
    player_ids=[players.players[0].player_id],
    ticks=[1, 65],
)
```

Every result includes `parser_version` and structured `warnings`. A
`RoundRecord` always has `canonical_round_number`: valid `round_start` rows are
sorted by tick and assigned `1..N` as a deterministic adapter identity. This
does not claim that demoparser2 exposed a raw round number. The parser's raw
value is kept separately as nullable `source_round_number`; `half_number`
remains nullable unless a parser field provides it. `EventRecord` keeps both
fields too. Ordinary event ownership uses half-open `[start_tick, end_tick)`
intervals, so when `round_end` and the next `round_start` share a tick the
explicit end belongs to the earlier round, the explicit start and ordinary
events at that tick belong to the next round. Events in gaps outside all valid
round intervals remain `canonical_round_number=None` with a structured warning;
the adapter does not force them into a round. Player IDs and ticks are
normalized to strings and non-negative integers. Round winners are normalized
to `TeamSide.T` or `TeamSide.CT` when the parser value is known.

`read_trajectory` accepts the lightweight canonical fields `x`, `y`, `z`,
`pitch`, `yaw`, `health`, `team_number`, and `is_alive`. The additive
`FULL_STATE_FIELDS` set also requests parser-exposed full-state facts:
`current_weapon` (`weapon_name`; the parser label may be a gun, knife, grenade,
or C4 when present), active weapon handle, inventory
names/IDs/bitmask, total ammo left, armor, helmet, defuser, money, and bomb
planted/dropped/site/zone state. Each `TrajectorySample` also exposes `side`,
derived from that row's `team_number` (`2 -> T`, `3 -> CT`); the
`PlayerRecord.team` value is only a player-table initial/summary value and is
not used as a fixed side for the whole Demo. Use `ticks`, `player_ids`, or
`max_samples` for bounded reads; no derived files are created.

`inventory_quantities` and per-player `c4_carrier` are represented as optional
fields and produce explicit `TRAJECTORY_FIELD_UNAVAILABLE` warnings because
demoparser2 0.42.0 did not expose a direct reliable field for either. The
demoparser2 0.42.0 did not expose a direct reliable field for either. The
inventory list is therefore not reinterpreted as a quantity assertion;
`total_ammo_left` is an aggregate ammo fact, not per-item inventory counts.
Grenade locations are available as parser grenade/event facts, not as a
per-player inventory state. A future deterministic C4 carrier builder may
reconstruct ownership from inventory snapshots plus `bomb_pickup`,
`bomb_dropped`, and `bomb_planted` facts. This Adapter deliberately leaves
`c4_carrier=None` and does not fill it by proximity or guesswork.

The adapter can return event facts such as `player_footstep`, `weapon_fire`,
`player_hurt`, `fire_bullets`, grenade detonation/expiry, and bomb lifecycle
events. `fire_bullets` exposes direct `origin_x/y/z` positions in the tested
Demo, and grenade detonation/expiry events expose direct `x/y/z`; footsteps,
weapon fire, hurts, and bomb lifecycle rows tested here do not expose a direct
event position and therefore return `world_origin=None` with a structured
event-level warning. If a downstream timeline needs those locations, the
follow-up is an explicit Timeline Builder join against actor trajectory facts;
the Adapter does not perform that join. It also does not turn a footstep or
weapon sound into an assertion that a particular player heard it; the Demo
contains sound-related event facts/metadata but no listener-heard fact, which
belongs to the ObservableState layer.

## Local development

From `workers/analysis` with `/opt/anaconda3/bin/python` (Python 3.12):

```bash
/opt/anaconda3/bin/python -m venv .venv
.venv/bin/python -m pip install -e '.[test]'
.venv/bin/python -m pytest
.venv/bin/python -m pytest -m 'not slow'
CS2_RUN_LARGE_DEMO_TESTS=1 .venv/bin/python -m pytest -m slow
```

The default real-Demo integration test uses the 58 MB fixture. The 433 MB
fixture test is opt-in and only reads its header and player table.

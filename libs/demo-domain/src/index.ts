import type {
  MatchPlayer,
  MatchTimeline,
  PlayerTrack,
  PlayerTrackSample,
  RoundTimeline
} from "@cs-coach/contracts";

export type DemoSource =
  | { kind: "fixture"; fixture_id: "mirage-coaching-v1" }
  | { kind: "file"; path: string; sha256: string };

export interface DemoParserPort {
  readonly parser_version: string;
  parse(source: DemoSource): Promise<MatchTimeline>;
}

const players: MatchPlayer[] = [
  { player_id: "p-user", display_name: "VEKEL", side: "T", is_selected: true },
  { player_id: "p-t1", display_name: "Rook", side: "T", is_selected: false },
  { player_id: "p-t2", display_name: "Mint", side: "T", is_selected: false },
  { player_id: "p-t3", display_name: "Solar", side: "T", is_selected: false },
  { player_id: "p-t4", display_name: "Kite", side: "T", is_selected: false },
  { player_id: "p-ct1", display_name: "North", side: "CT", is_selected: false },
  { player_id: "p-ct2", display_name: "Slate", side: "CT", is_selected: false },
  { player_id: "p-ct3", display_name: "Iris", side: "CT", is_selected: false },
  { player_id: "p-ct4", display_name: "Moss", side: "CT", is_selected: false },
  { player_id: "p-ct5", display_name: "Ash", side: "CT", is_selected: false }
];

type SampleTuple = readonly [
  tick: number,
  x: number,
  y: number,
  alive?: boolean,
  observed?: boolean
];

function makeTrack(player_id: string, tuples: SampleTuple[]): PlayerTrack {
  return {
    player_id,
    samples: tuples.map(([tick, x, y, alive = true, observed_by_selected = false]) => ({
      tick,
      x,
      y,
      alive,
      observed_by_selected
    }))
  };
}

const tracks: PlayerTrack[] = [
  makeTrack("p-user", [
    [0, 48, 93], [256, 48, 89], [900, 50, 60], [1599, 70, 25],
    [1600, 48, 93], [1856, 49, 88], [2200, 52, 58], [2350, 58, 43], [2460, 64, 38],
    [2580, 67, 34, false], [3199, 67, 34, false], [3200, 48, 93], [3456, 48, 88],
    [3850, 32, 60], [3910, 29, 52], [4020, 27, 46], [4160, 24, 42, false], [4799, 24, 42, false],
    [4800, 48, 93], [5056, 49, 87], [5500, 62, 64], [6399, 76, 72]
  ]),
  makeTrack("p-t1", [
    [0, 44, 94], [900, 42, 62], [1599, 68, 28],
    [1600, 44, 94], [2200, 44, 55], [2350, 46, 50], [3199, 45, 49],
    [3200, 44, 94], [3850, 37, 65], [3910, 36, 62], [4799, 40, 55],
    [4800, 44, 94], [5500, 60, 68], [6399, 72, 75]
  ]),
  makeTrack("p-t2", [
    [0, 52, 94], [900, 62, 75], [1599, 76, 35],
    [1600, 52, 94], [2200, 58, 64], [2350, 55, 59], [2700, 55, 59, false], [3199, 55, 59, false],
    [3200, 52, 94], [3850, 42, 70], [3910, 39, 67], [4799, 38, 66],
    [4800, 52, 94], [5500, 66, 70], [6399, 78, 68]
  ]),
  makeTrack("p-t3", [
    [0, 46, 96], [900, 34, 78], [1599, 28, 49],
    [1600, 46, 96], [2200, 34, 71], [2350, 34, 66], [3199, 32, 61],
    [3200, 46, 96], [3850, 55, 77], [3910, 54, 74], [4799, 60, 70],
    [4800, 46, 96], [5500, 46, 60], [6399, 34, 42]
  ]),
  makeTrack("p-t4", [
    [0, 50, 96], [900, 55, 83], [1599, 63, 54],
    [1600, 50, 96], [2200, 61, 75], [2350, 61, 68], [3199, 59, 63],
    [3200, 50, 96], [3850, 60, 82], [3910, 61, 80], [4799, 65, 78],
    [4800, 50, 96], [5500, 53, 56], [6399, 29, 35]
  ]),
  makeTrack("p-ct1", [
    [0, 51, 7], [900, 56, 32], [1599, 69, 19, false, true],
    [1600, 51, 7], [2200, 70, 34], [2350, 69, 35, true, true], [2460, 66, 36, true, true], [3199, 60, 31],
    [3200, 51, 7], [3850, 23, 37], [3910, 24, 41, true, true], [4020, 25, 43, true, true], [4799, 28, 48],
    [4800, 51, 7], [5500, 74, 44], [6399, 77, 62, false, true]
  ]),
  makeTrack("p-ct2", [
    [0, 47, 8], [900, 34, 25], [1599, 25, 43],
    [1600, 47, 8], [2200, 30, 35], [2350, 31, 36], [3199, 35, 42],
    [3200, 47, 8], [3850, 67, 33], [3910, 67, 34], [4799, 66, 38],
    [4800, 47, 8], [5500, 35, 36], [6399, 31, 40]
  ]),
  makeTrack("p-ct3", [
    [0, 54, 8], [900, 72, 34], [1599, 74, 24],
    [1600, 54, 8], [2200, 72, 28], [2350, 73, 28], [3199, 71, 32],
    [3200, 54, 8], [3850, 48, 38], [3910, 48, 38], [4799, 46, 43],
    [4800, 54, 8], [5500, 68, 38], [6399, 70, 50]
  ]),
  makeTrack("p-ct4", [
    [0, 49, 10], [900, 48, 34], [1599, 53, 45],
    [1600, 49, 10], [2200, 50, 34], [2350, 52, 36], [3199, 48, 43],
    [3200, 49, 10], [3850, 30, 34], [3910, 31, 34], [4799, 36, 40],
    [4800, 49, 10], [5500, 51, 37], [6399, 49, 44]
  ]),
  makeTrack("p-ct5", [
    [0, 45, 9], [900, 26, 37], [1599, 30, 52],
    [1600, 45, 9], [2200, 42, 32], [2350, 43, 35], [3199, 42, 38],
    [3200, 45, 9], [3850, 72, 30], [3910, 72, 31], [4799, 69, 35],
    [4800, 45, 9], [5500, 25, 35], [6399, 27, 39]
  ])
];

const rounds: RoundTimeline[] = [
  { round_number: 1, start_tick: 0, freeze_end_tick: 256, end_tick: 1600, score_before: [0, 0], score_after: [1, 0], winner: "T" },
  { round_number: 2, start_tick: 1600, freeze_end_tick: 1856, end_tick: 3200, score_before: [1, 0], score_after: [1, 1], winner: "CT" },
  { round_number: 3, start_tick: 3200, freeze_end_tick: 3456, end_tick: 4800, score_before: [1, 1], score_after: [1, 2], winner: "CT" },
  { round_number: 4, start_tick: 4800, freeze_end_tick: 5056, end_tick: 6400, score_before: [1, 2], score_after: [2, 2], winner: "T" }
];

export function createSyntheticMirageTimeline(): MatchTimeline {
  return {
    id: "timeline-fixture-mirage-v1",
    demo_id: "demo-fixture-mirage-v1",
    source_kind: "SYNTHETIC_FIXTURE",
    map_name: "de_mirage",
    tick_rate: 64,
    start_tick: 0,
    end_tick: 6400,
    selected_player_id: "p-user",
    players,
    tracks,
    rounds,
    timeline_version: "fixture-timeline/1.0.0"
  };
}

export class FixtureDemoParser implements DemoParserPort {
  readonly parser_version = "fixture-parser/1.0.0";

  async parse(source: DemoSource): Promise<MatchTimeline> {
    if (source.kind !== "fixture" || source.fixture_id !== "mirage-coaching-v1") {
      throw new Error(
        "FixtureDemoParser only accepts the mirage-coaching-v1 fixture; real .dem files require a DemoParserPort adapter."
      );
    }

    return createSyntheticMirageTimeline();
  }
}

export function getRoundAtTick(timeline: MatchTimeline, tick: number): RoundTimeline {
  const clampedTick = Math.min(Math.max(tick, timeline.start_tick), timeline.end_tick - 1);
  const round = timeline.rounds.find(
    (candidate) => clampedTick >= candidate.start_tick && clampedTick < candidate.end_tick
  );

  if (!round) {
    throw new Error(`No round contains canonical tick ${clampedTick}.`);
  }

  return round;
}

export function sampleTrackAtTick(track: PlayerTrack, tick: number): PlayerTrackSample {
  const samples = track.samples;
  if (samples.length === 0) {
    throw new Error(`Track ${track.player_id} has no samples.`);
  }

  if (tick <= samples[0].tick) {
    return samples[0];
  }

  const last = samples[samples.length - 1];
  if (tick >= last.tick) {
    return last;
  }

  for (let index = 1; index < samples.length; index += 1) {
    const next = samples[index];
    if (tick <= next.tick) {
      const previous = samples[index - 1];
      const span = next.tick - previous.tick;
      const progress = span === 0 ? 0 : (tick - previous.tick) / span;
      return {
        tick,
        x: previous.x + (next.x - previous.x) * progress,
        y: previous.y + (next.y - previous.y) * progress,
        alive: previous.alive,
        observed_by_selected: previous.observed_by_selected
      };
    }
  }

  return last;
}

import { fireReplay, self } from "../../libs/cs2d-analysis-adapter/src/window-self-fire-fixtures";

/** Synthetic coordinates and time, never a parsed Demo. Generated inside each page, not transported. */
export function twoCueViewerReplay() {
  const first = fireReplay("DEATH");
  const players = [{ steamId: self, name: "Synthetic T", startSide: "T" as const }, { steamId: "other", name: "Synthetic CT", startSide: "CT" as const }];
  const rounds = [0, 1].map(index => {
    const source = (index === 0 ? first : fireReplay("HP_CHANGE")).rounds[0], offset = index * 1200;
    // Populate the declared post-round window before using the Parser's half-open end.
    // These hold-state samples are synthetic, not reconstructed Demo observations.
    const frames = [...source.frames];
    const last = frames.at(-1)!;
    for (let tick = last.tick + 8; tick <= source.postEndTick; tick += 8) frames.push({ ...last, tick });
    const position = (tick: number) => ({ x: -700 + (tick - source.startTick) / 8 * 2, y: -700, z: 0 });
    return { ...source, number: index + 1, scoreCt: index, ctName: "Synthetic CT", tName: "Synthetic T", reason: null,
      damage: {}, utilityDamage: {}, bomb: [], blinds: [], chat: [], defuses: [], groundWeapons: [],
      freezeStartTick: source.freezeStartTick + offset, startTick: source.startTick + offset,
      decidedTick: source.decidedTick + offset, endTick: source.endTick + offset, postEndTick: frames.at(-1)!.tick + offset + 1,
      frames: frames.map(frame => ({ ...frame, tick: frame.tick + offset, t: (frame.tick - source.freezeStartTick) / 64,
        players: [{ ...frame.players[0], ...position(frame.tick), primary: "AK-47", weapon: "AK-47" },
          { ...frame.players[0], steamId: "other", side: "CT" as const, alive: true, health: 100, ...position(frame.tick), x: -400, primary: "AK-47", weapon: "AK-47" }],
      })),
      events: source.events.map(event => ({ ...event, ...position(event.tick), tick: event.tick + offset, t: (event.tick - source.freezeStartTick) / 64 })),
    };
  });
  return { ...first, players, rounds, generatedBy: "synthetic-two-cue-viewer-no-demo", finalScoreCt: 2, finalScoreT: 0, finalCtName: "Synthetic CT", finalTName: "Synthetic T" };
}
export const twoCueViewerPlayer = self;

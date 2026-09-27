import { expect, it } from "vitest";
import { buildCsNetFeatureBatch, buildWinProbabilityTimeline } from "../../cs-net-winrate/src/index";
import { buildCs2dAnalysisBundle, deserializeCs2dAnalysisBundle, serializeCs2dAnalysisBundle } from "./index";
import { fireReplay, self } from "./window-self-fire-fixtures";

it("keeps swapped-side swing metadata through actual analysis serialization without changing probabilities", () => {
  // Synthetic coordinates/logits only; no Demo parsing or model inference.
  const source = fireReplay("DEATH", []);
  const roster = [
    ...source.players, { steamId: "other", name: "Other", startSide: "CT" as const },
    ...Array.from({ length: 8 }, (_, i) => ({ steamId: `extra-${i}`, name: "Synthetic", startSide: i < 4 ? "T" as const : "CT" as const })),
  ];
  const replay = { ...source, players: roster,
    rounds: [0, 2048].map((offset, index) => ({ ...source.rounds[0], number: index + 1,
      freezeStartTick: source.rounds[0].freezeStartTick + offset,
      startTick: source.rounds[0].startTick + offset, decidedTick: source.rounds[0].decidedTick + offset,
      endTick: source.rounds[0].endTick + offset, postEndTick: source.rounds[0].postEndTick + offset,
      frames: source.rounds[0].frames.map(frame => ({ ...frame, tick: frame.tick + offset,
        players: roster.map(player => ({ ...frame.players[0], steamId: player.steamId,
          side: index === 0 ? player.startSide : player.startSide === "T" ? "CT" as const : "T" as const,
          alive: player.steamId === self ? frame.players[0].alive : true,
          health: player.steamId === self ? frame.players[0].health : 100,
          weapon: player.startSide === "T" ? "AK-47" : "Glock-18",
          primary: player.startSide === "T" ? "AK-47" : undefined,
          equipValue: player.startSide === "T" ? 4500 : 1000, money: player.startSide === "T" ? 3000 : 1000,
        })),
      })),
      events: source.rounds[0].events.map(event => ({ ...event, tick: event.tick + offset })),
    })),
  };
  const samples = buildCsNetFeatureBatch(replay).samples;
  const logits = samples.map(sample => sample.tick >= (sample.roundNumber === 1 ? 1408 : 3456) ? 2 : -2);
  const timeline = buildWinProbabilityTimeline({ replay, samples, logits, selectedPlayerId: self });
  expect(timeline.rounds[1].economy).toMatchObject({ ct: "FULL", t: "PISTOL" });
  const second = timeline.swings.find(swing => swing.selectedPlayerDeath && swing.tick === 3456)!;
  expect(second).toMatchObject({ victimSide: "CT", economy: "FULL" });
  const inputBefore = JSON.stringify(timeline);
  const analysis = buildCs2dAnalysisBundle({ replay, winProbabilityTimeline: timeline, selectedSteamId: self, demoId: "synthetic-swapped-sides" });
  const restored = deserializeCs2dAnalysisBundle(serializeCs2dAnalysisBundle(analysis));
  expect(restored.win_probability_timeline).toEqual(timeline);
  expect(JSON.stringify(timeline)).toBe(inputBefore);
  expect(restored.candidate_set.candidates.some(candidate => candidate.roundNumber === 2 && candidate.resultSummary.economyClass === "FULL")).toBe(true);
});

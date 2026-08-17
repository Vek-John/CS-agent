import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { POST } from "../../app/api/coaching/narrate/route";
import { adaptReplayBundle } from "../replay/replay-bundle";
import { buildNarrationPayload } from "./coach-narration";
import { parseNarrationRequest } from "./deepseek-narration";

const testDemoPath = fileURLToPath(new URL("../../public/generated-data/test_demo.replay.json", import.meta.url));
const falconsPath = fileURLToPath(new URL(
  "../../public/generated-data/uploads/4dedab6e-2645-4089-bfe6-a6858c68d344.replay.json",
  import.meta.url
));

function narrationPayload(path: string) {
  const view = adaptReplayBundle(JSON.parse(readFileSync(path, "utf8")));
  const plan = view.review_plan;
  if (!plan) throw new Error(`${path} must include a ReviewPlan`);
  return buildNarrationPayload(plan, {
    playerNames: view.timeline.players.map((player) => player.display_name),
    additionalForbiddenValues: view.timeline.players.map((player) => player.player_id)
  });
}

function acceptedCueCount(path: string): number {
  const payload = narrationPayload(path);
  const bytes = new TextEncoder().encode(JSON.stringify(payload)).byteLength;
  return parseNarrationRequest(payload, bytes).cues.length;
}

describe("DeepSeek narration real ReplayBundle contract", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("accepts the decision-only payload generated from test_demo", () => {
    expect(acceptedCueCount(testDemoPath)).toBe(5);
  });

  it("passes the real test_demo payload through the API route without a configured key", async () => {
    vi.stubEnv("DEEPSEEK_API_KEY", "");
    const response = await POST(new Request("http://localhost/api/coaching/narrate", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: "http://localhost"
      },
      body: JSON.stringify(narrationPayload(testDemoPath))
    }));

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      status: "DISABLED",
      items: [],
      reason: "MISSING_API_KEY"
    });
  });

  const runLarge = process.env.CS2_RUN_LARGE_DEMO_TESTS === "1" && existsSync(falconsPath);
  it.runIf(runLarge)("accepts all Falcons vs Spirit cues", () => {
    expect(acceptedCueCount(falconsPath)).toBe(15);
  });
});

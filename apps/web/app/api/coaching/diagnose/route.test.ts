import { describe, expect, it } from "vitest";
import { GET, POST } from "./route";

const validInput = {
  cueId: "cue-route",
  cue: { id: "cue-route", primary_focus_code: "POSITIONING", limitations: [] },
  reflection: {
    cueId: "cue-route",
    selectedGoal: "OTHER",
    response: "ANSWERED",
    source: "USER",
    limitations: [],
  },
  decisionFacts: [{
    id: "decision-route",
    text: "决策前玩家仍有可处理的接触窗口。",
    availability: "DECISION",
    available_at_tick: 100,
    source: "DEMO",
    observed_by_player: true,
  }],
  playerActionFacts: [{
    id: "action-route",
    text: "玩家向接触窗口移动并主动开火。",
    actorPlayerId: "player-route",
    availableAtTick: 105,
    source: "DEMO",
    evidenceRefs: ["decision-route"],
    limitations: [],
  }],
  outcomeFacts: [],
  focusCode: "POSITIONING",
  limitations: [],
};

function request(body: unknown, bodyText?: string): Request {
  return new Request("http://localhost/api/coaching/diagnose", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: bodyText ?? JSON.stringify(body),
  });
}

describe("POST /api/coaching/diagnose", () => {
  it("returns a successful START diagnosis with a cue case and learning thread", async () => {
    const response = await POST(request({ mode: "START", outcomeGateStatus: "COMPLETE", input: validInput }));
    const body = await response.json() as {
      status: string;
      cueCase?: { cueId: string };
      learningThread?: { threadId: string };
    };

    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      status: "SUCCEEDED",
      cueCase: { cueId: "cue-route" },
      learningThread: { threadId: expect.any(String) },
    });
  });

  it("falls back for invalid input, a non-COMPLETE gate, and non-JSON requests", async () => {
    const invalid = await POST(request({ mode: "START", outcomeGateStatus: "COMPLETE", input: { ...validInput, cueId: "" } }));
    expect(await invalid.json()).toMatchObject({ status: "FALLBACK" });

    const missingGate = await POST(request({ mode: "START", input: validInput }));
    expect(await missingGate.json()).toEqual({ status: "FALLBACK", reason: "DIAGNOSIS_GATE_LOCKED" });

    const locked = await POST(request({
      mode: "START",
      outcomeGateStatus: "LOCKED",
      input: validInput,
    }));
    expect(await locked.json()).toEqual({ status: "FALLBACK", reason: "DIAGNOSIS_GATE_LOCKED" });

    const richState = await POST(request({
      mode: "START",
      outcomeGateStatus: "COMPLETE",
      input: {
        ...validInput,
        decisionState: {
          player_id: "player-route",
          tick: 105,
          side: "T",
          health: 100,
          armor: 100,
          has_helmet: true,
          inventory: [],
        },
      },
    }));
    expect(await richState.json()).toEqual({ status: "FALLBACK", reason: "RICH_DECISION_STATE_NOT_ALLOWED" });

    const nonJson = await POST(request({}, "not-json"));
    expect(await nonJson.json()).toEqual({ status: "FALLBACK", reason: "INVALID_JSON" });
  });
});

describe("GET /api/coaching/diagnose", () => {
  it("returns 405", () => {
    expect(GET().status).toBe(405);
  });
});

import { describe, expect, it } from "vitest";
import { stage2AgentEvalManifest } from "./agent-eval-manifest";

describe("Stage2 Agent Eval manifest", () => {
  it("maps every Stage 3 requirement to an executable test", () => {
    expect(stage2AgentEvalManifest).toHaveLength(21);
    expect(new Set(stage2AgentEvalManifest.map((item) => item.id)).size).toBe(stage2AgentEvalManifest.length);
    expect(stage2AgentEvalManifest.filter((item) => item.status === "VERIFIED")).toHaveLength(21);
    expect(stage2AgentEvalManifest.every((item) => item.test.file && item.test.testName)).toBe(true);
    expect(stage2AgentEvalManifest.find((item) => item.id === "user-takeover-pause")?.status).toBe("VERIFIED");
  });
});

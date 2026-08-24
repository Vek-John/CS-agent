export type AgentEvalStatus = "VERIFIED" | "UNVERIFIED";

export interface AgentEvalTestMapping {
  file: string;
  testName: string;
}

export interface AgentEvalManifestItem {
  id: string;
  status: AgentEvalStatus;
  test: AgentEvalTestMapping;
  limitation?: string;
}

/**
 * Executable Stage 1 quality map. A VERIFIED item points at a concrete test
 * name; an UNVERIFIED item remains visible instead of borrowing a contract
 * field as proof. This list intentionally does not duplicate replay data.
 */
export const stage2AgentEvalManifest: readonly AgentEvalManifestItem[] = [
  { id: "gate-locked-no-tool", status: "VERIFIED", test: { file: "runtime.test.ts", testName: "does not create a tool request before outcome and narration are presentable" } },
  { id: "missing-space-no-map", status: "VERIFIED", test: { file: "capability-builder.test.ts", testName: "does not invent map, grenade, win-rate, or economy capabilities when evidence is unavailable" } },
  { id: "missing-trajectory-no-grenade", status: "VERIFIED", test: { file: "capability-builder.test.ts", testName: "does not invent map, grenade, win-rate, or economy capabilities when evidence is unavailable" } },
  { id: "model-unavailable-no-win-rate", status: "VERIFIED", test: { file: "capability-builder.test.ts", testName: "does not invent map, grenade, win-rate, or economy capabilities when evidence is unavailable" } },
  { id: "win-rate-negative-threshold", status: "VERIFIED", test: { file: "capability-builder.test.ts", testName: "does not build SHOW_WIN_RATE_IMPACT for" } },
  { id: "economy-reliability-filter", status: "VERIFIED", test: { file: "capability-builder.test.ts", testName: "does not invent map, grenade, win-rate, or economy capabilities when evidence is unavailable" } },
  { id: "tool-name-allowlist", status: "VERIFIED", test: { file: "capability-builder.test.ts", testName: "rejects unknown tools and malformed bound arguments" } },
  { id: "bound-args-by-tool", status: "VERIFIED", test: { file: "capability-builder.test.ts", testName: "deterministically builds all five bound tools from one compact cue summary" } },
  { id: "evidence-ref-allowlist", status: "VERIFIED", test: { file: "runtime.test.ts", testName: "passes a compact policy packet for multiple capabilities and binds the selected tool locally" } },
  { id: "narration-fallback-presentable", status: "VERIFIED", test: { file: "runtime.test.ts", testName: "accepts deterministic narration fallback as presentable and routes the cue" } },
  { id: "finish-cue-completes", status: "VERIFIED", test: { file: "runtime.test.ts", testName: "uses FINISH_CUE without a tool and still completes the cue" } },
  { id: "tool-one-failure-tool-two", status: "VERIFIED", test: { file: "runtime.test.ts", testName: "chooses one deterministic tool-2 after the first tool failure without calling Policy again" } },
  { id: "one-successful-move", status: "VERIFIED", test: { file: "runtime.test.ts", testName: "uses a rule capability without policy, interrupts before playback, and resumes idempotently" } },
  { id: "second-failure-or-cancel-terminal", status: "VERIFIED", test: { file: "runtime.test.ts", testName: "ends after tool cancellation without an alternative attempt" } },
  { id: "immutable-json-snapshot", status: "VERIFIED", test: { file: "runtime.test.ts", testName: "uses a rule capability without policy, interrupts before playback, and resumes idempotently" } },
  { id: "resume-idempotency", status: "VERIFIED", test: { file: "runtime.test.ts", testName: "uses a rule capability without policy, interrupts before playback, and resumes idempotently" } },
  { id: "checkpoint-identity-mismatch", status: "VERIFIED", test: { file: "runtime.test.ts", testName: "rejects a resume from a different route while a same-session run is waiting" } },
  { id: "presentable-theme-only", status: "VERIFIED", test: { file: "session-theme-aggregator.test.ts", testName: "only accepts completed presentable summaries" } },
  { id: "singleton-theme-not-repeated", status: "VERIFIED", test: { file: "session-theme-aggregator.test.ts", testName: "keeps a singleton non-repeated and aggregates repeated focus deterministically" } },
  { id: "provider-failure-and-budget", status: "VERIFIED", test: { file: "runtime.test.ts", testName: "uses one deterministic alternative for model failure or invalid output" } },
  { id: "user-takeover-pause", status: "VERIFIED", test: { file: "runtime.test.ts", testName: "pauses on USER_TAKEOVER, blocks old results, and resumes only from a new host cue" } },
];

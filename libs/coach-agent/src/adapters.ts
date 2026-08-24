import {
  AgentToolRequestSchema,
  AgentToolResultSchema,
  PolicyInputSchema,
  type AgentToolRequest,
  type AgentToolResult,
  type PolicyInput,
  type TeachingCapabilityId,
} from "./types";
import { deterministicPolicyOutput } from "./deterministic-policy";

export interface PolicyAdapter {
  selectCapability(input: PolicyInput): Promise<unknown>;
  consumeLastTraceMeta?: () => PolicyTraceMeta | null;
}

export interface PolicyTraceMeta {
  provider: string | null;
  model: string | null;
  tokenCount: number | null;
  latencyMs: number | null;
}

export interface PlaybackToolAdapter {
  resultFor(request: AgentToolRequest): AgentToolResult;
}

export class DeterministicPolicyAdapter implements PolicyAdapter {
  readonly calls: PolicyInput[] = [];
  private lastTraceMeta: PolicyTraceMeta | null = null;

  async selectCapability(input: PolicyInput): Promise<unknown> {
    const started = typeof performance !== "undefined" ? performance.now() : Date.now();
    const checked = PolicyInputSchema.parse(input);
    this.calls.push(checked);
    const output = deterministicPolicyOutput(checked);
    const finished = typeof performance !== "undefined" ? performance.now() : Date.now();
    this.lastTraceMeta = {
      provider: "DETERMINISTIC",
      model: null,
      tokenCount: null,
      latencyMs: Math.max(0, Math.round(finished - started)),
    };
    return output;
  }

  consumeLastTraceMeta(): PolicyTraceMeta | null {
    const meta = this.lastTraceMeta;
    this.lastTraceMeta = null;
    return meta;
  }
}

export class FakePolicyAdapter implements PolicyAdapter {
  readonly calls: PolicyInput[] = [];
  private readonly response: unknown;
  private readonly failure?: Error;

  constructor(options: {
    capabilityId?: TeachingCapabilityId;
    response?: unknown;
    failure?: Error;
  } = {}) {
    this.response =
      options.response ??
      (options.capabilityId
        ? {
            action: "SELECT_CAPABILITY",
            capabilityId: options.capabilityId,
            evidenceRefs: [],
            rationaleCode: "TIMING_NEEDS_SLOW_REPLAY",
            confidence: 0.8,
          }
        : {
            action: "SELECT_CAPABILITY",
            capabilityId: "cap-replay-cue-slow",
            evidenceRefs: [],
            rationaleCode: "TIMING_NEEDS_SLOW_REPLAY",
            confidence: 0.8,
          });
    this.failure = options.failure;
  }

  async selectCapability(input: PolicyInput): Promise<unknown> {
    this.calls.push(PolicyInputSchema.parse(input));
    if (this.failure) {
      throw this.failure;
    }
    return this.response;
  }
}

export class FakePlaybackTool implements PlaybackToolAdapter {
  readonly requests: AgentToolRequest[] = [];
  private readonly resultStatus: AgentToolResult["status"];
  private readonly resultCode: AgentToolResult["observation"]["code"];
  private readonly limitations: string[];

  constructor(
    options: {
      status?: AgentToolResult["status"];
      observationCode?: AgentToolResult["observation"]["code"];
      limitations?: string[];
    } = {},
  ) {
    this.resultStatus = options.status ?? "SUCCEEDED";
    this.resultCode = options.observationCode ?? "CUE_PLAYED";
    this.limitations = options.limitations ?? [];
  }

  resultFor(request: AgentToolRequest): AgentToolResult {
    const checkedRequest = AgentToolRequestSchema.parse(request);
    this.requests.push(checkedRequest);
    return AgentToolResultSchema.parse({
      callId: checkedRequest.callId,
      status: this.resultStatus,
      observation: {
        code: this.resultCode,
        completed: this.resultStatus === "SUCCEEDED",
      },
      limitations: this.limitations,
    });
  }
}

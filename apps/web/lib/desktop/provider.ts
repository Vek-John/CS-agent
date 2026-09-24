export interface DesktopProviderEnv {
  readonly DEEPSEEK_API_KEY?: string;
  readonly DEEPSEEK_MODEL?: string;
  readonly DEEPSEEK_URL?: string;
  readonly DEEPSEEK_ALLOW_EMPTY_KEY?: boolean;
}

interface RuntimeProvider {
  readonly kind: "NONE" | "DEEPSEEK" | "OPENAI_COMPATIBLE";
  readonly apiKey: string | null;
  readonly baseUrl: string | null;
  readonly model: string | null;
}

const symbol = Symbol.for("cs-agent.desktop.provider.v1");

function runtimeProvider(): RuntimeProvider | undefined {
  if ((process.env.DEPLOY_TARGET ?? "").trim().toLowerCase() !== "desktop") return undefined;
  return (globalThis as typeof globalThis & { [symbol]?: RuntimeProvider })[symbol];
}

export function coachingProviderEnv(): DesktopProviderEnv {
  const provider = runtimeProvider();
  if (!provider) {
    return {
      DEEPSEEK_API_KEY: process.env.DEEPSEEK_API_KEY,
      DEEPSEEK_MODEL: process.env.DEEPSEEK_MODEL,
    };
  }
  if (provider.kind === "NONE") return {};
  const base = provider.baseUrl?.replace(/\/+$/u, "");
  return {
    DEEPSEEK_API_KEY: provider.apiKey ?? undefined,
    DEEPSEEK_MODEL: provider.model ?? undefined,
    DEEPSEEK_URL: base ? `${base}/chat/completions` : undefined,
    DEEPSEEK_ALLOW_EMPTY_KEY: provider.kind === "OPENAI_COMPATIBLE" && provider.apiKey === null,
  };
}

export interface DecisionProviderEnv {
  readonly JEV_API_KEY?: string;
  readonly CS_DECISION_ASSESSMENT_MODE?: "RULE_BASELINE" | "JEV_SHADOW" | "JEV_EXPERIMENT";
  readonly CS_DECISION_ASSESSMENT_ACCEPTANCE?: "SHADOW_ONLY" | "TEST_ONLY";
}

interface RuntimeDecisionProvider {
  readonly kind: "RULE_BASELINE" | "JEV";
  readonly mode?: "JEV_SHADOW" | "JEV_EXPERIMENT";
  readonly acceptance?: "SHADOW_ONLY" | "TEST_ONLY";
  readonly apiKey?: string | null;
  readonly model?: "jev-1.13.0";
}

const decisionSymbol = Symbol.for("cs-agent.desktop.decision-provider.v1");
const baselineDecisionEnv: DecisionProviderEnv = Object.freeze({
  CS_DECISION_ASSESSMENT_MODE: "RULE_BASELINE",
  CS_DECISION_ASSESSMENT_ACCEPTANCE: "SHADOW_ONLY",
});

/** Server-only projection. This returns credentials to the adapter without changing process.env. */
export function decisionProviderEnv(): DecisionProviderEnv {
  const desktop = (process.env.DEPLOY_TARGET ?? "").trim().toLowerCase() === "desktop";
  const provider = desktop
    ? (globalThis as typeof globalThis & { [decisionSymbol]?: RuntimeDecisionProvider })[decisionSymbol]
    : undefined;
  if (desktop && (!provider || provider.kind !== "JEV" || provider.model !== "jev-1.13.0")) return baselineDecisionEnv;
  const mode = desktop ? provider?.mode : process.env.CS_DECISION_ASSESSMENT_MODE;
  if (mode !== "JEV_SHADOW" && mode !== "JEV_EXPERIMENT") return baselineDecisionEnv;
  const acceptance = desktop ? provider?.acceptance : process.env.CS_DECISION_ASSESSMENT_ACCEPTANCE;
  const key = desktop ? provider?.apiKey : process.env.JEV_API_KEY;
  return {
    CS_DECISION_ASSESSMENT_MODE: mode,
    CS_DECISION_ASSESSMENT_ACCEPTANCE: acceptance === "TEST_ONLY" ? "TEST_ONLY" : "SHADOW_ONLY",
    JEV_API_KEY: typeof key === "string" && key.length > 0 && key.length <= 512
      && !/[\u0000-\u001f\u007f]/u.test(key) ? key : undefined,
  };
}

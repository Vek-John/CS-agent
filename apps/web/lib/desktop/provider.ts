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

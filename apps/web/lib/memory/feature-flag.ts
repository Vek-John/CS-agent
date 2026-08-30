/**
 * Memory is deliberately opt-in at the deployment level.  Do not use the
 * usual truthiness check here: an accidentally populated value such as
 * `"false"` must never enable persistent memory.
 */
function cloudflareEnvValue(name: string): string | undefined {
  const context = (globalThis as unknown as Record<PropertyKey, unknown>)[Symbol.for("__cloudflare-context__")] as { env?: Record<string, unknown> } | undefined;
  const value = context?.env?.[name];
  return typeof value === "string" ? value : undefined;
}

export function parseMemoryEnabled(value: string | undefined = process.env.MEMORY_ENABLED ?? cloudflareEnvValue("MEMORY_ENABLED")): boolean {
  if (typeof value !== "string") return false;
  return ["true", "1", "on"].includes(value.trim().toLowerCase());
}

export const isMemoryFeatureEnabled = parseMemoryEnabled;

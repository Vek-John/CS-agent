import { build } from "esbuild";
import { describe, expect, it } from "vitest";

describe("coach-agent client entry", () => {
  it("does not pull LangGraph runtime or interrupt into a browser client bundle", async () => {
    const result = await build({
      entryPoints: [decodeURIComponent(new URL("./remote-dispatch-client.ts", import.meta.url).pathname)],
      bundle: true,
      platform: "browser",
      format: "esm",
      write: false,
      minify: true,
      logLevel: "silent",
    });
    const output = result.outputFiles?.[0]?.text ?? "";
    expect(output.length).toBeGreaterThan(100);
    expect(output).not.toMatch(/langgraph|StateGraph|MemorySaver|interrupt\s*\(/i);
  });
});

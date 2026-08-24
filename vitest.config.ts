import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["libs/**/*.test.ts", "apps/web/**/*.test.ts", "tools/**/*.test.mjs"],
    coverage: {
      reporter: ["text", "json-summary"]
    }
  }
});

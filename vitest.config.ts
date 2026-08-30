import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["libs/**/*.test.ts", "apps/web/**/*.test.ts", "tools/**/*.test.mjs"],
    exclude: [...configDefaults.exclude, "tools/desktop-release/audit.test.mjs"],
    coverage: {
      reporter: ["text", "json-summary"]
    }
  }
});

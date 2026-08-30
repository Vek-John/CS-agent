import type { NextConfig } from "next";
import path from "node:path";
import { fileURLToPath } from "node:url";

const desktopBuild = process.env.DESKTOP_BUILD === "1";
const webRoot = path.dirname(fileURLToPath(import.meta.url));
const monorepoRoot = path.resolve(webRoot, "../..");

const crossOriginIsolationHeaders = [
  { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
  { key: "Cross-Origin-Embedder-Policy", value: "require-corp" },
  { key: "Cross-Origin-Resource-Policy", value: "cross-origin" },
];

const nextConfig: NextConfig = {
  ...(desktopBuild ? {
    output: "standalone" as const,
    outputFileTracingRoot: monorepoRoot,
    outputFileTracingIncludes: {
      "/*": [
        "../../libs/*/package.json",
        "node_modules/next/**/*",
      ],
    },
    outputFileTracingExcludes: {
      "/*": [
        "../../.local-data/**/*",
        "public/generated-data/**/*",
        "../../libs/**/*.test.ts",
      ],
    },
  } : {}),
  // pg's Cloudflare stream adapter is selected through the `workerd` export
  // condition during the OpenNext bundle. Keep the package's full dist/ tree
  // in the traced server output so its CommonJS branch resolves correctly.
  serverExternalPackages: ["pg-cloudflare"],
  transpilePackages: [
    "@cs-coach/contracts",
    "@cs-coach/demo-domain",
    "@cs-coach/map-semantics",
    "@cs-coach/observation",
    "@cs-coach/review-planner",
    "@cs-coach/session",
    "@cs-coach/coach-agent"
  ],
  async headers() {
    return [{ source: "/:path*", headers: crossOriginIsolationHeaders }];
  }
};

export default nextConfig;

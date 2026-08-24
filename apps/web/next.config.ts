import type { NextConfig } from "next";

const crossOriginIsolationHeaders = [
  { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
  { key: "Cross-Origin-Embedder-Policy", value: "require-corp" },
  { key: "Cross-Origin-Resource-Policy", value: "cross-origin" },
];

const nextConfig: NextConfig = {
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

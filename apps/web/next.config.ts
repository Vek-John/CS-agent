import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  transpilePackages: [
    "@cs-coach/contracts",
    "@cs-coach/demo-domain",
    "@cs-coach/map-semantics",
    "@cs-coach/observation",
    "@cs-coach/review-planner",
    "@cs-coach/session"
  ]
};

export default nextConfig;

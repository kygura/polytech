import type { NextConfig } from "next";
import { withWorkflow } from "workflow/next";

const nextConfig: NextConfig = {
  transpilePackages: ["@pm/core", "@pm/pm", "@pm/agents", "@pm/db"],
  // No serverExternalPackages: @upstash/redis (fetch) and ioredis (pure JS over node:net) both bundle. ioredis is only installed under
  // packages/db (bun isolated installs), so marking it external would leave it unresolvable from this app at runtime.
  // DESIGN 12.1.2: Fleet became Runs, Calibration became Journal.
  async redirects() {
    return [
      { source: "/fleet", destination: "/runs", permanent: true },
      { source: "/calibration", destination: "/journal", permanent: true },
    ];
  },
};

export default withWorkflow(nextConfig);

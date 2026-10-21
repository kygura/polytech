import type { NextConfig } from "next";
import { withWorkflow } from "workflow/next";

const nextConfig: NextConfig = {
  transpilePackages: ["@pm/core", "@pm/pm", "@pm/agents", "@pm/db"],
  serverExternalPackages: ["@electric-sql/pglite"],
  // DESIGN 12.1.2: Fleet became Runs, Calibration became Journal.
  async redirects() {
    return [
      { source: "/fleet", destination: "/runs", permanent: true },
      { source: "/calibration", destination: "/journal", permanent: true },
    ];
  },
};

export default withWorkflow(nextConfig);

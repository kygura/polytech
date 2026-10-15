import type { NextConfig } from "next";
import { withWorkflow } from "workflow/next";

const nextConfig: NextConfig = {
  transpilePackages: ["@pm/core", "@pm/pm", "@pm/agents", "@pm/db"],
  serverExternalPackages: ["@electric-sql/pglite", "@node-rs/argon2"],
};

export default withWorkflow(nextConfig);

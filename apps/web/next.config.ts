import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  transpilePackages: ["@pm/core", "@pm/pm", "@pm/agents", "@pm/db"],
};

export default nextConfig;

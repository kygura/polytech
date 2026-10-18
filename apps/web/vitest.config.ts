import { defineConfig } from "vitest/config";

// tsconfig keeps jsx "preserve" for Next; tests importing .tsx need it compiled
export default defineConfig({ oxc: { jsx: { runtime: "automatic" } } });

import type { Mode } from "@pm/core";
import css from "./ui.module.css";

export const MODE_LABEL: Record<Mode, string> = { L0: "OBSERVE", L1: "PAPER", L2: "APPROVE", L3: "BOUNDED", L4: "FULL" };

export function ModeBadge({ mode, size = "sm" }: { mode: Mode; size?: "sm" | "lg" }) {
  const n = mode.slice(1);
  return (
    <span className={`${css.mode} ${size === "lg" ? css.modeLg : css.modeSm}`} style={{ color: `var(--mode-${n})` }} aria-label={`mode ${mode} ${MODE_LABEL[mode]}`}>
      {mode} {MODE_LABEL[mode]}
    </span>
  );
}

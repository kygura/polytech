import type { Mode } from "@pm/core";
import { MODE_HELP } from "./ModeSelector";

/** Header words for each autonomy level (the Autonomy page keeps the L0–L4 names). */
export const MODES: Record<Mode, { short: string; help: string }> = {
  L0: { short: "Off", help: MODE_HELP.L0 },
  L1: { short: "Paper", help: MODE_HELP.L1 },
  L2: { short: "Asks you", help: MODE_HELP.L2 },
  L3: { short: "Small trades", help: MODE_HELP.L3 },
  L4: { short: "Full", help: MODE_HELP.L4 },
};

/** Header stop button: hidden when there is nothing to stop (autopilot off, no orders the system placed). */
export function stopLabel(mode: Mode, openOrders: number, armed: boolean): string | null {
  const n = `${openOrders} order${openOrders === 1 ? "" : "s"}`;
  if (armed) return `Confirm: stop and cancel ${n}`;
  if (openOrders > 0) return mode === "L0" ? `Cancel ${n}` : `Stop · cancel ${n}`;
  return mode === "L0" ? null : "Stop autopilot";
}

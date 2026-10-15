import { autoDowngrade, kill as coreKill, requestModeChange, type Actor, type AutonomyEvent, type Mode } from "@pm/core";
import { schema as s, type Db } from "@pm/db";
import { desc, eq } from "drizzle-orm";
import type { Deps } from "./deps";
import { publish } from "./events";

/** Global mode = to_mode of the newest global event (refused requests are logged with to == from). Default L0. */
export async function currentMode(db: Db): Promise<Mode> {
  const r = (await db.select().from(s.autonomyEvents).where(eq(s.autonomyEvents.scope, "global")).orderBy(desc(s.autonomyEvents.id)).limit(1))[0];
  return (r?.toMode as Mode | undefined) ?? "L0";
}

async function record(d: Pick<Deps, "db" | "now">, ev: AutonomyEvent) {
  await d.db.insert(s.autonomyEvents).values({
    ts: new Date(d.now()), fromMode: ev.fromMode, toMode: ev.refused ? ev.fromMode : ev.toMode,
    scope: "global", reason: ev.reason, actor: ev.actor,
  });
  publish("mode.changed", { from: ev.fromMode, to: ev.refused ? ev.fromMode : ev.toMode, reason: ev.reason, actor: ev.actor, refused: ev.refused, requested: ev.toMode });
}

/** Raises to L2+ are refused (EXECUTION_DISABLED) and logged; everything else applies. One action, no re-auth. */
export async function setMode(d: Pick<Deps, "db" | "now">, to: Mode, reason = "manual", actor: Exclude<Actor, "kill"> = "user") {
  const ch = requestModeChange(await currentMode(d.db), to, actor, reason);
  await record(d, ch.event);
  return { allowed: ch.allowed, mode: ch.mode, reason: ch.event.reason };
}

/** Drops to L0. ponytail: no real orders exist in this build, so there is nothing to cancel; L0 stops paperBook. */
export async function kill(d: Pick<Deps, "db" | "now">) {
  const ch = coreKill(await currentMode(d.db));
  await record(d, ch.event);
  return { mode: ch.mode, cancelledOrders: 0 };
}

/** Anthropic outage mid-pod => SPEC auto-downgrade (only ever lowers the mode). */
export async function outageDowngrade(d: Pick<Deps, "db" | "now">) {
  const cur = await currentMode(d.db);
  const dg = autoDowngrade({ dailyLossHit: false, consecutiveOrderErrors: 0, bookStaleMs: 0, balanceMismatch: false, anthropicOutageMidPod: true }, cur);
  if (!dg) return null;
  const ch = requestModeChange(cur, dg.mode, "auto-downgrade", dg.reason);
  await record(d, ch.event);
  return ch.mode;
}

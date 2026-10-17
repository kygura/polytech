import { aggregate, autoDowngrade, gateProgress, kill as coreKill, requestModeChange, type Actor, type AutonomyEvent, type DowngradeSignals, type Mode } from "@pm/core";
import { schema as s, type Db } from "@pm/db";
import { scrub } from "@pm/pm";
import { and, desc, eq, inArray } from "drizzle-orm";
import { forecastRows } from "./calib";
import type { Deps } from "./deps";
import { publish } from "./events";
import { BURNED, liveFilled, notifyMode, orderUi } from "./live";
import { LIVE_OPEN } from "./paper";

/** Global mode = to_mode of the newest global event (refused requests are logged with to == from). Default L0. */
export async function currentMode(db: Db): Promise<Mode> {
  const r = (await db.select().from(s.autonomyEvents).where(eq(s.autonomyEvents.scope, "global")).orderBy(desc(s.autonomyEvents.id)).limit(1))[0];
  return (r?.toMode as Mode | undefined) ?? "L0";
}

/** Logs + publishes a mode event. `sent` is the (never-rejecting) ntfy push, started but not awaited so callers can finish urgent work first. skippedGate rides in `reason`: autonomy_events has no column for it. */
async function record(d: Pick<Deps, "db" | "now">, ev: AutonomyEvent) {
  const reason = ev.skippedGate && !ev.refused ? `${ev.reason} (gate not met)` : ev.reason;
  const to = ev.refused ? ev.fromMode : ev.toMode;
  await d.db.insert(s.autonomyEvents).values({ ts: new Date(d.now()), fromMode: ev.fromMode, toMode: to, scope: "global", reason, actor: ev.actor });
  publish("mode.changed", { from: ev.fromMode, to, reason, actor: ev.actor, refused: ev.refused, requested: ev.toMode });
  return { sent: to !== ev.fromMode || ev.actor === "kill" ? notifyMode(`${ev.fromMode} -> ${to}: ${reason} (${ev.actor})`) : Promise.resolve(false) };
}

/** Raises to L3+ (and to L2 without a configured exchange) are refused (EXECUTION_DISABLED) and logged; everything else applies. One action, no re-auth. */
export async function setMode(d: Pick<Deps, "db" | "now"> & Partial<Pick<Deps, "exchange">>, to: Mode, reason = "manual", actor: Exclude<Actor, "kill"> = "user") {
  const cur = await currentMode(d.db);
  // same L1->L2 gate inputs as read.autonomy; advisory: a missed gate is logged, never blocks
  const a = cur !== "L2" && to === "L2" ? aggregate(await forecastRows(d.db), () => "all").all : undefined;
  const met = cur === "L2" || to !== "L2" || gateProgress("L1->L2", { resolved: a?.n ?? 0, brier: a?.brier, marketBrier: a?.marketBrier }).met;
  const ch = requestModeChange(cur, to, actor, reason, met, !!d.exchange);
  await (await record(d, ch.event)).sent;
  return { allowed: ch.allowed, mode: ch.mode, reason: ch.event.reason };
}

/**
 * Drops to L0 first (nothing new can be proposed/approved), expires pending proposals (KILLED), then cancels every live order on the exchange.
 * cancelAll throws => still L0; `failed` lists the open orders with a scrubbed error. Only status 'live' orders are marked cancelled;
 * sending/unknown/matched stay for fill sync to resolve (they may already be filled), so late fills are never lost.
 */
export async function kill(d: Pick<Deps, "db" | "now"> & Partial<Pick<Deps, "exchange">>) {
  const ch = coreKill(await currentMode(d.db));
  const { sent } = await record(d, ch.event);
  const dead = await d.db.update(s.proposals).set({ status: "expired", error: "KILLED", decidedAt: new Date(d.now()), ...BURNED })
    .where(eq(s.proposals.status, "pending")).returning({ id: s.proposals.id });
  for (const p of dead) publish("proposal.updated", { id: p.id, state: "expired", reason: "KILLED" });
  for (const p of await d.db.update(s.proposalSets).set({ status: "expired", error: "KILLED", decidedAt: new Date(d.now()), ...BURNED }).where(eq(s.proposalSets.status, "pending")).returning({ id: s.proposalSets.id }))
    publish("proposal.updated", { id: p.id, kind: "set", state: "expired", reason: "KILLED" }); // a set mid-send stops itself: sendSet re-checks the mode before every leg

  let cancelled = 0;
  const failed: { orderId: string; error: string }[] = [];
  if (d.exchange) {
    const live = and(eq(s.orders.paper, false), eq(s.orders.status, "live"));
    try {
      await d.exchange.cancelAll();
      const filled = await liveFilled(d.db);
      for (const o of await d.db.update(s.orders).set({ status: "cancelled" }).where(live).returning()) {
        cancelled++;
        publish("order.updated", { id: o.id, orderId: o.clobOrderId ?? o.id, status: orderUi("cancelled", 0), filledShares: filled.get(o.id) ?? 0 });
      }
    } catch (e) {
      const error = scrub(e instanceof Error ? e.message : "cancelAll failed").slice(0, 300);
      for (const o of await d.db.select().from(s.orders).where(and(eq(s.orders.paper, false), inArray(s.orders.status, LIVE_OPEN)))) failed.push({ orderId: o.clobOrderId ?? o.id, error });
    }
  }
  await sent;
  return { mode: ch.mode, cancelled, failed };
}

/** Anthropic outage mid-pod => SPEC auto-downgrade (only ever lowers the mode). */
export const outageDowngrade = (d: Pick<Deps, "db" | "now">) => downgradeOn(d, { anthropicOutageMidPod: true });

/** Auto-downgrades (daily loss, order errors, stale book, mismatch, outage). Core targets L2 for BOOK_STALE, which never lowers L1/L2, so at L1/L2 stale goes to L0. */
export async function downgradeOn(d: Pick<Deps, "db" | "now">, sig: Partial<DowngradeSignals>) {
  const cur = await currentMode(d.db);
  const all = { dailyLossHit: false, consecutiveOrderErrors: 0, bookStaleMs: 0, balanceMismatch: false, anthropicOutageMidPod: false, ...sig };
  const dg = autoDowngrade(all, cur) ?? (all.bookStaleMs > 300_000 && (cur === "L1" || cur === "L2") ? { mode: "L0" as Mode, reason: "BOOK_STALE" } : null);
  if (!dg) return null;
  const ch = requestModeChange(cur, dg.mode, "auto-downgrade", dg.reason);
  await (await record(d, ch.event)).sent;
  return ch.mode;
}

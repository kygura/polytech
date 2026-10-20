import { summarize, type JournalRow } from "@pm/core";
import { getKv, schema as s } from "@pm/db";
import { and, count, desc, eq, gte, isNotNull, isNull, max, sql } from "drizzle-orm";
import { KICK_AT } from "../public";
import { currentMode } from "./autonomy";
import { DAY, today } from "./deps";
import { publish } from "./events";
import { calibration, type ReadDeps } from "./read";
import { getSettings } from "./settings";

// ---------------------------------------------------------------- status bar (cheap: counts, one max, a few single-row reads)
export async function status(r: ReadDeps) {
  const { db } = r, now = r.now();
  const [[runs], live, [snap], [sp], [un], st, mode, sweptAt] = await Promise.all([
    db.select({ n: count() }).from(s.pods).where(eq(s.pods.status, "running")),
    db.select({ id: s.pods.id, stage: s.pods.stage, question: s.markets.question }).from(s.pods).leftJoin(s.markets, eq(s.markets.conditionId, s.pods.conditionId))
      .where(eq(s.pods.status, "running")).orderBy(desc(s.pods.startedAt)).limit(10),
    db.select({ t: max(s.marketLatest.ts) }).from(s.marketLatest),
    db.select({ usd: s.spend.anthropicUsd }).from(s.spend).where(eq(s.spend.day, today(now))),
    db.select({ n: count() }).from(s.alerts).where(isNull(s.alerts.ackedAt)),
    getSettings(db),
    currentMode(db),
    getKv().get<number>(KICK_AT),
  ]);
  return {
    activeRuns: live, // newest 10 live pods for the status bar tooltip
    activeRunCount: runs?.n ?? 0,
    spendToday: { usd: sp?.usd ?? 0, capUsd: st.budget.dailySpendCapUsd },
    lastSnapshotAt: snap?.t?.getTime() ?? null,
    lastSweepAt: sweptAt ?? null,
    unackedAlerts: un?.n ?? 0,
    mode,
  };
}

// ---------------------------------------------------------------- alerts
export async function alertsList(r: ReadDeps, o: { unacked?: boolean; limit: number }) {
  const { db } = r;
  const [rows, [un]] = await Promise.all([
    db.select({ a: s.alerts, question: s.markets.question }).from(s.alerts).leftJoin(s.markets, eq(s.markets.conditionId, s.alerts.conditionId))
      .where(o.unacked ? isNull(s.alerts.ackedAt) : undefined).orderBy(desc(s.alerts.createdAt), desc(s.alerts.id)).limit(o.limit),
    db.select({ n: count() }).from(s.alerts).where(isNull(s.alerts.ackedAt)),
  ]);
  return { rows: rows.map(({ a, question }) => ({ ...a, question })), unacked: un?.n ?? 0 };
}

/** Acks one alert (id) or every open one (no id). Returns how many rows changed. */
export async function ackAlerts(r: ReadDeps, id?: number) {
  const rows = await r.db.update(s.alerts).set({ ackedAt: new Date(r.now()) })
    .where(and(isNull(s.alerts.ackedAt), id === undefined ? undefined : eq(s.alerts.id, id))).returning({ id: s.alerts.id });
  if (rows.length) publish("alert.acked", { ids: rows.map((x) => x.id), all: id === undefined });
  return rows.length;
}

// ---------------------------------------------------------------- journal
export async function journalView(r: ReadDeps, o: { category?: string; model?: string; days?: number }) {
  const { db } = r;
  const rows = await db.select({ j: s.journal, at: s.theses.createdAt }).from(s.journal).leftJoin(s.theses, eq(s.theses.id, s.journal.thesisId))
    .where(and(
      isNotNull(s.journal.pHat),
      o.category ? eq(s.journal.category, o.category) : undefined,
      o.model ? eq(s.journal.model, o.model) : undefined,
      o.days ? gte(s.theses.createdAt, new Date(r.now() - o.days * DAY)) : undefined,
    ))
    .orderBy(desc(sql`coalesce(${s.theses.createdAt}, ${s.journal.resolvedAt})`));
  const jr: JournalRow[] = rows.map(({ j }) => ({ ...j, model: j.model ?? "unknown", pHat: j.pHat!, side: j.side === "NO" ? "NO" : "YES", result: j.result === "YES" || j.result === "NO" ? j.result : null }));
  const [cal, st] = await Promise.all([calibration(r, { category: o.category, model: o.model, sinceDays: o.days }), getSettings(db)]);
  return { summary: summarize(jr), rows: jr.slice(0, 5000) /* the client computes rolling Brier / drift / breakdown from these: no 200-row cap */, bins: cal.bins, suggested: st.suggested };
}

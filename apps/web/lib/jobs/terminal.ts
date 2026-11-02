import { summarize, type JournalRow } from "@pm/core";
import { getKv, schema as s, type Db } from "@pm/db";
import { KICK_AT } from "../public";
import { currentMode } from "./autonomy";
import { DAY, chunks, today } from "./deps";
import { publish } from "./events";
import { calibration, type ReadDeps } from "./read";
import { getSettings } from "./settings";

/** conditionId -> market question for the rows that name one (LEFT JOIN markets: missing market = null). */
async function questions(db: Db, conds: (string | null)[]) {
  const ids = [...new Set(conds.filter((c): c is string => c !== null))];
  return new Map((await db.markets.getMany(ids)).map((m) => [m.conditionId, m.question]));
}

// ---------------------------------------------------------------- status bar (cheap: counts, one max, a few single-row reads)
export async function status(r: ReadDeps) {
  const { db } = r, now = r.now();
  const [runs, live, snap, sp, un, st, mode, sweptAt] = await Promise.all([
    db.pods.count("status", { status: "running" }),
    db.pods.find("status", { status: "running" }, { order: "desc", limit: 10 }) // newest startedAt first
      .then(async (ps) => { const q = await questions(db, ps.map((p) => p.conditionId)); return ps.map((p) => ({ id: p.id, stage: p.stage, question: q.get(p.conditionId) ?? null })); }),
    db.marketLatest.first("byTs", {}, { order: "desc" }), // max(ts)
    db.spend.get(today(now)),
    db.alerts.count("unacked", {}),
    getSettings(db),
    currentMode(db),
    getKv().get<number>(KICK_AT),
  ]);
  return {
    activeRuns: live, // newest 10 live pods for the status bar tooltip
    activeRunCount: runs,
    spendToday: { usd: sp?.anthropicUsd ?? 0, capUsd: st.budget.dailySpendCapUsd },
    lastSnapshotAt: snap?.ts.getTime() ?? null,
    lastSweepAt: sweptAt ?? null,
    unackedAlerts: un,
    mode,
  };
}

// ---------------------------------------------------------------- alerts
type Alert = typeof s.alerts.$inferSelect;
const newestFirst = (a: Alert, b: Alert) => b.createdAt.getTime() - a.createdAt.getTime() || b.id - a.id; // createdAt desc, id desc

export async function alertsList(r: ReadDeps, o: { unacked?: boolean; limit: number }) {
  const { db } = r;
  const ix = o.unacked ? "unacked" : "byCreated";
  const page = async () => {
    const rows = await db.alerts.find(ix, {}, { order: "desc", limit: o.limit });
    // index ties break by pk as a string ("10" < "9"): pull the whole createdAt tie group at the page boundary, then order by id explicitly
    const edge = rows.length && rows.length >= o.limit ? rows.at(-1)!.createdAt : null;
    const ties = edge ? await db.alerts.find(ix, {}, { min: edge, max: edge }) : [];
    const byId = new Map([...rows, ...ties].map((a) => [a.id, a]));
    return [...byId.values()].sort(newestFirst).slice(0, Math.max(0, o.limit));
  };
  const [rows, un] = await Promise.all([
    page().then(async (as) => { const q = await questions(db, as.map((a) => a.conditionId)); return as.map((a) => ({ ...a, question: a.conditionId === null ? null : (q.get(a.conditionId) ?? null) })); }),
    db.alerts.count("unacked", {}),
  ]);
  return { rows, unacked: un };
}

/** Acks one alert (id) or every open one (no id). Returns how many rows changed. */
export async function ackAlerts(r: ReadDeps, id?: number) {
  const at = new Date(r.now());
  const ack = (a: Alert) => (a.ackedAt === null ? { ackedAt: at } : null); // CAS: only rows still unacked change
  const ids = id === undefined ? await r.db.alerts.ids("unacked", {}) : [id];
  const rows = await r.db.alerts.updateMany(ids, ack);
  if (rows.length) publish("alert.acked", { ids: rows.map((x) => x.id), all: id === undefined });
  return rows.length;
}

// ---------------------------------------------------------------- journal
export async function journalView(r: ReadDeps, o: { category?: string; model?: string; days?: number }) {
  const { db } = r;
  const js = (await db.journal.all()).filter((j) => j.pHat !== null && (!o.category || j.category === o.category) && (!o.model || j.model === o.model));
  // LEFT JOIN theses ON theses.id = journal.thesis_id (only createdAt is used)
  const at = new Map((await Promise.all(chunks(js.map((j) => j.thesisId), 1000).map((c) => db.theses.getMany(c)))).flat().map((t) => [t.id, t.createdAt.getTime()]));
  const since = o.days ? r.now() - o.days * DAY : null;
  const key = (j: (typeof js)[number]) => at.get(j.thesisId) ?? j.resolvedAt?.getTime() ?? null; // coalesce(theses.created_at, journal.resolved_at)
  const rows = js
    .filter((j) => since === null || (at.has(j.thesisId) && at.get(j.thesisId)! >= since)) // a days filter drops rows without a thesis
    .map((j) => ({ j, k: key(j) }))
    // ORDER BY coalesce(...) DESC: Postgres puts NULLs first on DESC; ties by thesisId
    .sort((a, b) => (a.k === b.k ? (a.j.thesisId < b.j.thesisId ? -1 : a.j.thesisId > b.j.thesisId ? 1 : 0) : a.k === null ? -1 : b.k === null ? 1 : b.k - a.k));
  const jr: JournalRow[] = rows.map(({ j }) => ({ ...j, model: j.model ?? "unknown", pHat: j.pHat!, side: j.side === "NO" ? "NO" : "YES", result: j.result === "YES" || j.result === "NO" ? j.result : null }));
  const [cal, st] = await Promise.all([calibration(r, { category: o.category, model: o.model, sinceDays: o.days }), getSettings(db)]);
  return { summary: summarize(jr), rows: jr.slice(0, 5000) /* the client computes rolling Brier / drift / breakdown from these: no 200-row cap */, bins: cal.bins, suggested: st.suggested };
}

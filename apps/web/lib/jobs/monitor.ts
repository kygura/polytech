import { shouldReResearch } from "@pm/core";
import { schema as s } from "@pm/db";
import { and, desc, eq, gt, gte, inArray, isNull, or, sql } from "drizzle-orm";
import { withLock, type Deps } from "./deps";
import { publish } from "./events";
import { catalystMs } from "./research";

const CAP = 20; // alerts raised per pass; the rest become one summary alert
const TOP_IN = 20, TOP_OUT = 30, RANK_READ = 60; // new_candidate hysteresis: enters at rank <= 20, only forgotten once it falls past 30
const STATE = "monitor:state";
const H = 3_600_000;
const WEBHOOK_MS = 5_000;

type Kind = "mid_move" | "catalyst_passed" | "new_candidate" | "structural" | "run_failed";
const ORDER: Kind[] = ["mid_move", "catalyst_passed", "run_failed", "structural", "new_candidate"]; // what survives the per-pass cap, most urgent first
type Draft = { kind: Kind; conditionId: string | null; message: string; data: Record<string, unknown> };
type State = { top: string[]; struct: string[]; pods?: string[] }; // pods: failed pod ids already alerted (a reaped pod keeps its old startedAt, so a time cursor would miss it)
const FAILED_LOOKBACK = 7 * 24 * H, FIRST_LOOKBACK = 24 * H;

const c1 = (x: number) => (x * 100).toFixed(1);
const clip = (q: string) => (q.length > 70 ? `${q.slice(0, 67)}...` : q);

/**
 * Alert pass: mid moved since a live thesis, catalyst passed, a market entering the top-20 by priority, a new structural flag, pods that failed.
 * Same kind + market is not re-raised within settings.alerts.cooldownH; at most CAP alerts per pass (+1 summary). Idempotent per pass: safe to run on every snapshot.
 */
export async function monitor(d: Deps) {
  return withLock(d, "monitor", 2 * 60_000, async () => {
    const { db, kv, settings: st } = d, now = d.now(), ml = s.marketLatest;
    const { midMoveC, cooldownH } = st.alerts;
    const prev = (await kv.get<State>(STATE)) ?? { top: [], struct: [] };

    const [th, flags, recent, failed, ranked0, flagged0] = await Promise.all([
      db.select().from(s.theses).where(or(isNull(s.theses.expiresAt), sql`${s.theses.expiresAt} > ${new Date(now)}`)).orderBy(desc(s.theses.createdAt)),
      db.select().from(s.marketFlags),
      db.select({ kind: s.alerts.kind, c: s.alerts.conditionId }).from(s.alerts).where(gte(s.alerts.createdAt, new Date(now - cooldownH * H))),
      db.select({ id: s.pods.id, c: s.pods.conditionId, trigger: s.pods.trigger }).from(s.pods).where(and(eq(s.pods.status, "failed"), gte(s.pods.startedAt, new Date(now - (prev.pods ? FAILED_LOOKBACK : FIRST_LOOKBACK))))),
      db.select({ c: ml.conditionId, mid: ml.mid, priority: ml.priority }).from(ml).where(gt(ml.priority, 0)).orderBy(desc(ml.priority), ml.conditionId).limit(RANK_READ),
      db.select({ c: ml.conditionId, kinds: ml.structural }).from(ml).where(sql`jsonb_array_length(coalesce(${ml.structural}, '[]'::jsonb)) > 0`),
    ]);
    const liveTh = new Map<string, (typeof th)[number]>();
    for (const t of th) if (!liveTh.has(t.conditionId)) liveTh.set(t.conditionId, t);
    const mids = new Map((liveTh.size ? await db.select({ c: ml.conditionId, mid: ml.mid }).from(ml).where(inArray(ml.conditionId, [...liveTh.keys()])) : []).map((r) => [r.c, r.mid]));
    const muted = new Set(flags.filter((f) => f.muted).map((f) => f.conditionId));
    const cold = new Set(recent.map((r) => `${r.kind}:${r.c}`)); // raised within the cooldown

    const ids = [...new Set([...liveTh.keys(), ...ranked0.map((r) => r.c), ...flagged0.map((r) => r.c), ...failed.map((f) => f.c)])];
    const meta = new Map<string, { q: string; end: number | null }>();
    for (let i = 0; i < ids.length; i += 5000)
      for (const m of await db.select({ c: s.markets.conditionId, q: s.markets.question, e: s.markets.endDate }).from(s.markets).where(inArray(s.markets.conditionId, ids.slice(i, i + 5000)))) meta.set(m.c, { q: m.q, end: m.e?.getTime() ?? null });
    const q = (c: string) => clip(meta.get(c)?.q ?? c);

    const out: Draft[] = [];
    // ---- live theses: mid moved, catalyst passed
    for (const [c, t] of liveTh) {
      const now_ = mids.get(c), det = (t.detail ?? {}) as { pMidYes?: number }, at = det.pMidYes;
      if (muted.has(c) || now_ == null || at == null) continue;
      const dC = (now_ - at) * 100;
      if (midMoveC > 0 && Math.round(Math.abs(now_ - at) * 1e4) >= Math.round(midMoveC * 100))
        out.push({ kind: "mid_move", conditionId: c, message: `${q(c)}: mid ${c1(at)}c -> ${c1(now_)}c (${dC > 0 ? "+" : ""}${dC.toFixed(1)}c) since the thesis`, data: { thesisId: t.id, side: t.side, midAt: at, mid: now_, deltaC: dC } });
      const why = shouldReResearch({ mid: at, createdAt: t.createdAt.getTime(), resolvesAt: meta.get(c)?.end ?? now }, now, now_, catalystMs(t.catalysts), false);
      if (why.includes("CATALYST_PASSED"))
        out.push({ kind: "catalyst_passed", conditionId: c, message: `${q(c)}: a catalyst date passed since the thesis`, data: { thesisId: t.id, reasons: why, catalysts: t.catalysts } });
    }
    // ---- structural: market newly flagged
    const flagged = flagged0.filter((r) => !muted.has(r.c));
    for (const r of flagged) if (!prev.struct.includes(r.c))
      out.push({ kind: "structural", conditionId: r.c, message: `${q(r.c)}: structural ${r.kinds!.join(", ")}`, data: { kinds: r.kinds } });
    // ---- new candidate: entered the top 20 by priority (hysteresis: stays "in" until rank 30), not already researched
    const ranked = ranked0.filter((r) => !muted.has(r.c));
    const top = ranked.slice(0, TOP_IN).map((r) => r.c), keepIn = new Set(ranked.slice(0, TOP_OUT).map((r) => r.c));
    for (const c of top) if (!prev.top.includes(c) && !liveTh.has(c)) {
      const pr = ranked.find((r) => r.c === c)!.priority!;
      out.push({ kind: "new_candidate", conditionId: c, message: `${q(c)}: entered the top ${TOP_IN} by priority (${pr.toFixed(2)})`, data: { priority: pr, rank: top.indexOf(c) + 1 } });
    }
    // ---- pods that failed since the last pass
    const alerted = new Set(prev.pods ?? []);
    for (const f of failed) if (!alerted.has(f.id) && !muted.has(f.c))
      out.push({ kind: "run_failed", conditionId: f.c, message: `${q(f.c)}: research pod failed (${f.trigger})`, data: { podId: f.id, trigger: f.trigger } });

    // dedupe: cooldown against stored alerts and within this pass; cap; the capped remainder stays "unseen" so the next pass raises it
    const picked: Draft[] = [], dropped: Draft[] = [], seen = new Set(cold);
    let deduped = 0;
    for (const a of out.sort((x, y) => ORDER.indexOf(x.kind) - ORDER.indexOf(y.kind))) {
      const key = `${a.kind}:${a.conditionId}`;
      if (seen.has(key)) { deduped++; continue; }
      seen.add(key);
      (picked.length < CAP ? picked : dropped).push(a);
    }
    const rows: (typeof s.alerts.$inferInsert)[] = picked.map((a) => ({ ...a, createdAt: new Date(now) }));
    const sumKind = dropped[0]?.kind;
    if (sumKind && !cold.has(`${sumKind}:null`)) rows.push({ kind: sumKind, conditionId: null, message: `${dropped.length} more alerts not shown`, data: { suppressed: dropped.length, kinds: [...new Set(dropped.map((x) => x.kind))] }, createdAt: new Date(now) });
    const created = rows.length ? await db.insert(s.alerts).values(rows).returning() : [];

    // state: dropped ones are left out so the next pass sees them as new; everything else is remembered
    const left = new Set(dropped.map((x) => `${x.kind}:${x.conditionId}`));
    await kv.set(STATE, {
      top: [...new Set([...top, ...prev.top.filter((c) => keepIn.has(c))])].filter((c) => !left.has(`new_candidate:${c}`)),
      struct: flagged.map((r) => r.c).filter((c) => !left.has(`structural:${c}`)),
      pods: failed.map((f) => f.id).filter((id) => !dropped.some((x) => x.data.podId === id)), // all scanned failures count as seen (muted / deduped too), except the capped-out
    } satisfies State);

    for (const a of created) publish("alert.created", { id: a.id, kind: a.kind, conditionId: a.conditionId, message: a.message });
    await notify(created.map((a) => a.message));
    const byKind: Record<string, number> = {};
    for (const a of picked) byKind[a.kind] = (byKind[a.kind] ?? 0) + 1;
    return { raised: created.length, deduped, suppressed: dropped.length, byKind };
  });
}

/** Optional webhook: one POST {text} per alert, 5 s timeout each; never throws (an unreachable hook must not fail the pass). */
async function notify(texts: string[]) {
  const url = process.env.ALERT_WEBHOOK_URL;
  if (!url || !texts.length) return;
  await Promise.allSettled(texts.map((text) => fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text }), signal: AbortSignal.timeout(WEBHOOK_MS) })));
}

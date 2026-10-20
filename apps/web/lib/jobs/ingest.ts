import { schema as s } from "@pm/db";
import type { Deps } from "./deps";
import { takeSnapshots, toMarketRow } from "./sweep";

/** Picked search result (Gamma market id) -> `markets` upsert + first book snapshot (research needs one). Undefined = not open / unknown. */
export async function ingestMarket(d: Deps, pmId: string) {
  const m = await d.pm.market(pmId).catch((e) => { if (/\b404\b/.test(String(e?.message))) return undefined; throw e; });
  if (!m?.open || !m.accepting_orders || !m.end_date || Date.parse(m.end_date) <= d.now()) return undefined;
  const { conditionId, feeRate: _keep, feeExponent: _keepExp, ...set } = toMarketRow(m); // fee stays as stored; null = category fallback
  await d.db.insert(s.markets).values(toMarketRow(m)).onConflictDoUpdate({ target: s.markets.conditionId, set });
  const snap = await takeSnapshots(d, [conditionId]);
  return { conditionId, hasBook: snap.markets > snap.noBook };
}

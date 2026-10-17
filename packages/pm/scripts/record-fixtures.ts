// Records REAL raw responses into ../fixtures (same files gen-fixtures.ts writes). Run from an unblocked network:
//   bun --filter @pm/pm fixtures:record [maxMarkets=60]
import { mkdirSync, writeFileSync } from "node:fs";
import { createPm } from "../src/index";

const MAX = Number(process.argv[2] ?? 60);
const { raw } = createPm({ fixtures: false });

async function walk(host: "gamma", path: string, key: string): Promise<any[]> {
  const out: any[] = [];
  const seen = new Set<string>();
  let cursor: string | undefined;
  for (;;) {
    const r: any = await raw(host, path, { params: { closed: false, limit: 100, after_cursor: cursor } });
    const items = Array.isArray(r) ? r : r?.[key] ?? [];
    out.push(...items);
    if (!items.length || !r.next_cursor || seen.has(r.next_cursor) || out.length >= MAX * 5) return out;
    seen.add(r.next_cursor);
    cursor = r.next_cursor;
  }
}
const ids = (m: any): string[] => { try { return typeof m.clobTokenIds === "string" ? JSON.parse(m.clobTokenIds) : m.clobTokenIds ?? []; } catch { return []; } };

const all = await walk("gamma", "/markets/keyset", "markets");
const markets = all.sort((a, b) => Number(b.volume24hr ?? 0) - Number(a.volume24hr ?? 0)).slice(0, MAX);
const events = (await walk("gamma", "/events/keyset", "events")).slice(0, MAX);
const tokens = markets.flatMap(ids);

const books: Record<string, unknown> = {}, history: Record<string, unknown> = {}, fees: Record<string, number> = {};
for (let i = 0; i < tokens.length; i += 500) {
  const r: any = await raw("clob", "/books", { body: tokens.slice(i, i + 500).map((token_id) => ({ token_id })) });
  for (const b of r ?? []) books[b.asset_id] = b;
}
for (const t of tokens) {
  history[t] = await raw("clob", "/prices-history", { params: { market: t, interval: "1w", fidelity: 360 } }).catch(() => ({ history: [] }));
  const f: any = await raw("clob", "/fee-rate", { params: { token_id: t } }).catch(() => undefined);
  if (f?.base_fee !== undefined) fees[t] = Number(f.base_fee);
}

const conds = markets.map((m) => m.conditionId as string);
const rich = markets.slice(0, 10);
const holders: Record<string, unknown> = {}, oi: Record<string, number> = {}, comments: unknown[] = [], trades: unknown[] = [];
for (const c of await raw("data", "/oi", { params: { market: conds.join(",") } }) as any[]) oi[c.market] = c.value;
for (const m of rich) {
  holders[m.conditionId] = await raw("data", "/holders", { params: { market: m.conditionId } });
  trades.push(...((await raw("data", "/trades", { params: { market: m.conditionId, limit: 50 } })) as any[]));
  const evId = m.events?.[0]?.id;
  if (evId) comments.push(...((await raw("gamma", "/comments", { params: { parent_entity_type: "Event", parent_entity_id: evId, limit: 20 } })) as any[]));
}

const out = new URL("../fixtures/", import.meta.url);
mkdirSync(out, { recursive: true });
for (const [n, v] of Object.entries({ markets, events, books, history, fees, comments, holders, oi, trades }))
  writeFileSync(new URL(`${n}.json`, out), JSON.stringify(v, null, 1) + "\n");
console.log(`recorded ${markets.length} markets, ${events.length} events, ${Object.keys(books).length} books`);

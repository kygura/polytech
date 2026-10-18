import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export type Host = "gamma" | "clob" | "data";
export type Req = { params?: Record<string, string | number | boolean | undefined>; body?: unknown };

const dir = join(dirname(fileURLToPath(import.meta.url)), "..", "fixtures"); // plain path: Turbopack must not treat it as an asset
const cache = new Map<string, any>();
const load = (name: string): any => {
  if (!cache.has(name)) cache.set(name, JSON.parse(readFileSync(join(dir, `${name}.json`), "utf8")));
  return cache.get(name);
};

const enc = (n: number) => btoa(`o:${n}`);
const dec = (c?: unknown) => (typeof c === "string" ? Number(atob(c).slice(2)) || 0 : 0);
const csv = (v: unknown) => String(v ?? "").split(",").filter(Boolean);
const notFound = (what: string): never => { throw new Error(`fixture 404: ${what}`); };

/** keyset page: next_cursor only when the page is full (as the real API does). */
function keyset(all: any[], key: string, p: NonNullable<Req["params"]>) {
  const limit = Number(p.limit ?? 20), start = dec(p.after_cursor);
  const items = all.slice(start, start + limit);
  return items.length === limit && start + limit <= all.length ? { [key]: items, next_cursor: enc(start + limit) } : { [key]: items };
}

/** Serves raw API-shaped responses from packages/pm/fixtures/*.json. */
export function fixtureCall(host: Host, path: string, { params: p = {}, body }: Req = {}): unknown {
  const books = () => load("books") as Record<string, any>;
  const tokenReqs = () => {
    const ids = (body as { token_id: string }[]).map((b) => b.token_id);
    if (ids.length > 500) throw new Error("fixture 400: max 500 tokens per batch");
    return ids;
  };
  const mid = (b: any) => (Number(b.bids.at(-1)?.price) + Number(b.asks.at(-1)?.price)) / 2;
  if (host === "gamma") {
    if (path === "/markets/keyset") return keyset((load("markets") as any[]).filter((m) => p.closed === undefined || String(m.closed) === String(p.closed)), "markets", p);
    if (path === "/events/keyset") return keyset((load("events") as any[]).filter((e) => p.closed === undefined || String(e.closed) === String(p.closed)), "events", p);
    if (path.startsWith("/events/")) return (load("events") as any[]).find((e) => String(e.id) === decodeURIComponent(path.slice(8))) ?? notFound(path);
    if (path.startsWith("/markets/")) return (load("markets") as any[]).find((m) => m.id === decodeURIComponent(path.slice(9))) ?? notFound(path);
    if (path === "/comments") return (load("comments") as any[]).filter((c) => String(c.parentEntityID) === String(p.parent_entity_id)).slice(0, Number(p.limit ?? 100));
  }
  if (host === "clob") {
    if (path === "/books") return tokenReqs().flatMap((t) => books()[t] ?? []);
    if (path === "/midpoints") return Object.fromEntries(tokenReqs().flatMap((t) => (books()[t] ? [[t, mid(books()[t]).toFixed(4)]] : [])));
    if (path === "/spreads") return Object.fromEntries(tokenReqs().flatMap((t) => { const b = books()[t]; return b ? [[t, (Number(b.asks.at(-1).price) - Number(b.bids.at(-1).price)).toFixed(4)]] : []; }));
    if (path === "/last-trades-prices") return tokenReqs().flatMap((t) => (books()[t] ? [{ token_id: t, price: mid(books()[t]).toFixed(2), side: "BUY" }] : []));
    if (path === "/prices-history") return load("history")[String(p.market)] ?? { history: [] };
    if (path === "/fee-rate") return { base_fee: load("fees")[String(p.token_id)] ?? notFound(path) };
    if (path === "/tick-size") return { minimum_tick_size: String(books()[String(p.token_id)]?.tick_size ?? notFound(path)) };
  }
  if (host === "data") {
    const conds = csv(p.market);
    if (path === "/holders") return conds.flatMap((c) => load("holders")[c] ?? []);
    if (path === "/oi") return Object.entries(load("oi") as Record<string, number>).filter(([c]) => !conds.length || conds.includes(c)).map(([market, value]) => ({ market, value }));
    if (path === "/trades") return (load("trades") as any[]).filter((t) => !conds.length || conds.includes(t.conditionId)).slice(Number(p.offset ?? 0), Number(p.offset ?? 0) + Number(p.limit ?? 100));
  }
  return notFound(`${host} ${path}`);
}

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { Book } from "./schemas";
import { applyPriceChange, bookStore, parseWsMessage, subscribeBooks, subscribeMarket, type MarketEvent, type WsLike } from "./ws";

const fx = (name: string): any => JSON.parse(readFileSync(join(import.meta.dirname, "../fixtures/contract", name), "utf8"));
const bookOf = (e: MarketEvent) => (e.type === "book" ? e.book : undefined);

describe("parseWsMessage", () => {
  it("live capture: initial array dump -> book snapshots (best-first), price_change deltas, PONG ignored", () => {
    const evs = (fx("ws-frames.json") as string[]).flatMap((f) => parseWsMessage(f));
    const books = evs.flatMap((e) => bookOf(e) ?? []);
    expect(books).toHaveLength(2);
    expect(books[0]!.bids[0]!.price).toBeGreaterThan(books[0]!.bids[1]!.price);
    expect(books[0]!.asks[0]!.price).toBeLessThan(books[0]!.asks[1]!.price);
    expect(books[0]!.tick_size).toBe(0.001);
    const pc = evs.find((e) => e.type === "price_change") as Extract<MarketEvent, { type: "price_change" }>;
    expect(pc.changes.length).toBeGreaterThan(0);
    expect(pc.changes[0]).toEqual({ token_id: expect.any(String), price: 0.45, size: 2000, side: "BUY", best_bid: 0.929, best_ask: 0.93 });
    expect(pc.ts).toBeGreaterThan(1.6e12); // ws timestamps are ms
    expect(parseWsMessage("PONG")).toEqual([]);
  });
  it("documented frames: last_trade, best_bid_ask, tick_size_change, market_resolved; junk is dropped and reported", () => {
    const bad: unknown[] = [];
    const evs = (fx("ws-docs-frames.json") as string[]).flatMap((f) => parseWsMessage(f, (_r, why) => bad.push(why)));
    expect(evs.map((e) => e.type)).toEqual(["last_trade", "best_bid_ask", "tick_size_change", "market_resolved"]);
    expect(evs[0]).toMatchObject({ price: 0.456, size: 219.217767, side: "BUY", fee_rate_bps: 0 });
    expect(evs[1]).toMatchObject({ best_bid: 0.73, best_ask: 0.77, spread: 0.04 });
    expect(evs[2]).toMatchObject({ old_tick_size: 0.01, new_tick_size: 0.001 });
    expect(evs[3]).toMatchObject({ winning_outcome: "Yes", token_ids: expect.any(Array) });
    expect(bad).toHaveLength(2); // unknown event_type + invalid JSON
  });
});

describe("local book", () => {
  const base: Book = { token_id: "T", bids: [{ price: 0.5, size: 10 }, { price: 0.49, size: 5 }], asks: [{ price: 0.52, size: 7 }, { price: 0.53, size: 1 }] };
  it("applyPriceChange inserts, replaces and removes levels, keeping best-first order", () => {
    const ins = applyPriceChange(base, { token_id: "T", price: 0.495, size: 3, side: "BUY" }, 7);
    expect(ins.bids.map((l) => l.price)).toEqual([0.5, 0.495, 0.49]);
    expect(ins.timestamp).toBe(7);
    const rep = applyPriceChange(ins, { token_id: "T", price: 0.5, size: 1, side: "BUY" });
    expect(rep.bids[0]).toEqual({ price: 0.5, size: 1 });
    const rm = applyPriceChange(rep, { token_id: "T", price: 0.5, size: 0, side: "BUY" });
    expect(rm.bids.map((l) => l.price)).toEqual([0.495, 0.49]);
    const ask = applyPriceChange(rm, { token_id: "T", price: 0.51, size: 2, side: "SELL" });
    expect(ask.asks.map((l) => l.price)).toEqual([0.51, 0.52, 0.53]);
    expect(base.bids).toHaveLength(2); // pure: input untouched
  });
  it("bookStore folds snapshots and deltas from the live capture; deltas before a snapshot are dropped", () => {
    const store = bookStore();
    const frames = (fx("ws-frames.json") as string[]).flatMap((f) => parseWsMessage(f));
    const pc = frames.find((e) => e.type === "price_change")!;
    expect(store.apply(pc)).toEqual([]); // nothing to apply to yet
    const touched = frames.flatMap((e) => store.apply(e));
    expect(store.books.size).toBe(2);
    const yes = pc.type === "price_change" ? pc.changes[0]!.token_id : "";
    expect(touched).toContain(yes);
    const b = store.get(yes)!;
    expect(b.bids.some((l) => l.price === 0.45)).toBe(true); // the delta landed
    for (let i = 1; i < b.bids.length; i++) expect(b.bids[i]!.price).toBeLessThan(b.bids[i - 1]!.price);
    expect(store.apply({ type: "tick_size_change", token_id: yes, new_tick_size: 0.01 })).toEqual([yes]);
    expect(store.get(yes)!.tick_size).toBe(0.01);
    expect(store.apply({ type: "last_trade", token_id: yes, price: 0.93 })).toEqual([yes]);
    expect(store.get(yes)!.last_trade_price).toBe(0.93);
    expect(store.apply({ type: "best_bid_ask", token_id: yes })).toEqual([]);
  });
});

class FakeWS implements WsLike {
  static instances: FakeWS[] = [];
  static stuck = false; // simulate a socket that stays CONNECTING forever
  static throwNext = false; // simulate a constructor failure (bad URL, no network stack)
  readyState = 0;
  sent: string[] = [];
  onopen: ((ev: unknown) => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onclose: ((ev: { code?: number; reason?: string }) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  constructor(public url: string) {
    if (FakeWS.throwNext) { FakeWS.throwNext = false; throw new Error("boom"); }
    FakeWS.instances.push(this);
    if (FakeWS.stuck) return;
    queueMicrotask(() => { this.readyState = 1; this.onopen?.({}); });
  }
  send(s: string) { this.sent.push(s); }
  close() { if (this.readyState === 3) return; this.readyState = 3; this.onclose?.({ code: 1000, reason: "" }); }
}
const tick = (ms = 5) => new Promise((r) => setTimeout(r, ms));
/** Real timers drift under load: wait for the condition instead of a fixed delay. */
const until = async (ok: () => unknown, ms = 2000) => { for (const end = Date.now() + ms; !ok() && Date.now() < end; ) await tick(2); };

describe("subscribeMarket (fake socket)", () => {
  it("subscribes on open, forwards events, pings, resubscribes the current set after a drop, stops on close()", async () => {
    FakeWS.instances = [];
    const events: MarketEvent[] = [];
    const status: string[] = [];
    const sock = subscribeMarket(["A", "B"], { onEvent: (e) => events.push(e), onStatus: (s) => status.push(s), WebSocketImpl: FakeWS, pingMs: 5, reconnectMinMs: 1, reconnectMaxMs: 2, random: () => 0.5 });
    await until(() => FakeWS.instances[0]?.sent.includes("PING"));
    const ws1 = FakeWS.instances[0]!;
    expect(ws1.url).toBe("wss://ws-subscriptions-clob.polymarket.com/ws/market");
    expect(JSON.parse(ws1.sent[0]!)).toEqual({ type: "market", assets_ids: ["A", "B"], custom_feature_enabled: true });
    expect(ws1.sent).toContain("PING");
    expect(sock.status).toBe("open");
    ws1.onmessage!({ data: fx("ws-docs-frames.json")[0] });
    ws1.onmessage!({ data: "PONG" });
    expect(events.map((e) => e.type)).toEqual(["last_trade"]);
    sock.subscribe(["C", "A"]);
    expect(JSON.parse(ws1.sent.at(-1)!)).toEqual({ operation: "subscribe", assets_ids: ["C"] });
    sock.unsubscribe(["A"]);
    expect(JSON.parse(ws1.sent.at(-1)!)).toEqual({ operation: "unsubscribe", assets_ids: ["A"] });
    ws1.close(); // server drop -> reconnect with the *current* set
    await until(() => FakeWS.instances[1]?.sent.length);
    const ws2 = FakeWS.instances[1]!;
    expect(ws2).toBeDefined();
    expect(JSON.parse(ws2.sent[0]!).assets_ids.sort()).toEqual(["B", "C"]);
    sock.close();
    await tick(30);
    expect(FakeWS.instances).toHaveLength(2); // no reconnect after close()
    expect(sock.status).toBe("closed");
    expect(status.slice(0, 4)).toEqual(["connecting", "open", "closed", "connecting"]);
  });
  it("a socket stuck CONNECTING is abandoned after connectTimeoutMs and retried with backoff", async () => {
    FakeWS.instances = [];
    FakeWS.stuck = true;
    const status: string[] = [];
    const sock = subscribeMarket(["A"], { onEvent: () => {}, onStatus: (s, d) => status.push(d ? `${s}:${d}` : s), WebSocketImpl: FakeWS, connectTimeoutMs: 10, reconnectMinMs: 1, reconnectMaxMs: 2 });
    await tick(60);
    FakeWS.stuck = false;
    await tick(60);
    sock.close();
    expect(status).toContain("closed:connect timeout");
    expect(FakeWS.instances.length).toBeGreaterThanOrEqual(3);
    expect(JSON.parse(FakeWS.instances.at(-1)!.sent[0]!).assets_ids).toEqual(["A"]); // eventually connected and subscribed
  });
  it("close() detaches the socket: a late server close emits nothing and triggers no reconnect", async () => {
    FakeWS.instances = [];
    const status: string[] = [];
    const sock = subscribeMarket(["A"], { onEvent: () => {}, onStatus: (s) => status.push(s), WebSocketImpl: FakeWS, reconnectMinMs: 1, reconnectMaxMs: 2 });
    await tick(10);
    const ws1 = FakeWS.instances[0]!;
    const lateClose = ws1.onclose!;
    sock.close();
    expect(status).toEqual(["connecting", "open", "closed"]);
    expect(ws1.onclose).toBeNull();
    expect(ws1.readyState).toBe(3);
    lateClose({ code: 1006, reason: "late" }); // the server's close event arriving after ours
    await tick(20);
    expect(status).toEqual(["connecting", "open", "closed"]); // not re-emitted
    expect(FakeWS.instances).toHaveLength(1);
  });
  it("a throwing WebSocket constructor counts as a lost connection and is retried", async () => {
    FakeWS.instances = [];
    FakeWS.throwNext = true;
    const status: string[] = [];
    const sock = subscribeMarket(["A"], { onEvent: () => {}, onStatus: (s, d) => status.push(d ? `${s}:${d}` : s), WebSocketImpl: FakeWS, reconnectMinMs: 1, reconnectMaxMs: 2 });
    await tick(30);
    expect(status[0]).toBe("connecting");
    expect(status[1]).toBe("closed:connect failed: boom");
    expect(status).toContain("open");
    expect(FakeWS.instances).toHaveLength(1);
    expect(JSON.parse(FakeWS.instances[0]!.sent[0]!).assets_ids).toEqual(["A"]);
    sock.close();
  });
  it("subscribeBooks clears its store on disconnect so a delta after a reconnect never hits a stale book", async () => {
    FakeWS.instances = [];
    const seen: Book[] = [];
    const sock = subscribeBooks(["A"], (b) => seen.push(b), { WebSocketImpl: FakeWS, pingMs: 1000, reconnectMinMs: 1, reconnectMaxMs: 2 });
    await tick(10);
    const frames = fx("ws-frames.json") as string[];
    FakeWS.instances[0]!.onmessage!({ data: frames[0] });
    expect(sock.store.books.size).toBe(2);
    FakeWS.instances[0]!.close(); // server drop
    expect(sock.store.books.size).toBe(0);
    await tick(30);
    const ws2 = FakeWS.instances[1]!;
    const n = seen.length;
    ws2.onmessage!({ data: frames[1] }); // delta before the fresh snapshot: dropped
    expect(seen).toHaveLength(n);
    expect(sock.store.books.size).toBe(0);
    ws2.onmessage!({ data: frames[0] });
    expect(sock.store.books.size).toBe(2);
    sock.close();
  });
  it("subscribeBooks emits the maintained book after snapshots and deltas", async () => {
    FakeWS.instances = [];
    const seen: Book[] = [];
    const sock = subscribeBooks(["A"], (b) => seen.push(b), { WebSocketImpl: FakeWS, pingMs: 1000 });
    await tick(10);
    const ws = FakeWS.instances[0]!;
    const frames = fx("ws-frames.json") as string[];
    ws.onmessage!({ data: frames[0] }); // array of 2 books
    ws.onmessage!({ data: frames[1] }); // price_change touching both
    expect(seen).toHaveLength(4);
    expect(seen[2]!.bids.some((l) => l.price === 0.45)).toBe(true);
    expect(sock.store.books.size).toBe(2);
    sock.close();
  });
});

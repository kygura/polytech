import { render } from "ink";
import { PassThrough } from "node:stream";
import { afterEach, expect, it, vi } from "vitest";
import { App } from "./app";

// Hermetic: never read the real ~/.config/pm-edge/token; fetch is stubbed per test below.
vi.mock("./auth", () => ({ authHeaders: async () => ({}) }));

// Tiny Ink test harness (ink-testing-library is untested against Ink 8): debug mode writes every frame raw.
function mount() {
  const stdin = Object.assign(new PassThrough(), { isTTY: true, setRawMode() {}, ref() {}, unref() {} });
  let last = "";
  const stdout = Object.assign(new PassThrough(), { isTTY: false, columns: 140, rows: 40 });
  stdout.on("data", (c: Buffer) => (last = c.toString()));
  const app = render(<App />, { stdin: stdin as never, stdout: stdout as never, debug: true, patchConsole: false });
  // Poll until the frame contains `want` (fixed sleeps race async fetches under parallel load).
  const until = async (want: string | RegExp, ms = 3000) => {
    for (const end = Date.now() + ms; Date.now() < end; await tick(10)) if (typeof want === "string" ? last.includes(want) : want.test(last)) return last;
    return last;
  };
  return { app, frame: () => last, until, key: async (s: string) => (stdin.write(s), tick()) };
}
const tick = (ms = 60) => new Promise((r) => setTimeout(r, ms));

const watch = [
  { conditionId: "c1", question: "Will the Fed cut in Dec 2026?", category: "politics", pinned: false, muted: false, researching: false, daysLeft: 41, thesisAgeH: 3, capped: false, nextCatalyst: "11-02 FOMC", side: "YES", pMid: 0.412, pHat: 0.58, c: 0.6, pPost: 0.512, edgeC: 10, payoff: 1.2, rAnn: 3.12, sizeUsd: 1250, expectedProfit: 125, rank: 1 },
  { conditionId: "c2", question: "Senate confirms X by Nov 30?", category: "politics", pinned: true, muted: false, researching: false, daysLeft: 46, thesisAgeH: 90, capped: true, nextCatalyst: null, side: "NO", pMid: 0.7, pHat: 0.52, c: 0.4, pPost: 0.6, edgeC: -2.5, payoff: 0.8, rAnn: 1.85, sizeUsd: 900, expectedProfit: -8, rank: 2 },
];
const autonomy = { mode: "L1" as string, executionEnabled: false, categories: [], limits: { perTradeUsd: 50, perTradePct: 0.05, dailyLoss: 100 }, usage: { totalOpen: 0, dailyNotional: 0, dailyRealizedLoss: 0 }, gates: [], events: [] } as Record<string, unknown>;
const prop = { id: "p1", conditionId: "c1", question: "Will the Fed cut in Dec 2026?", side: "YES", orderSide: "BUY", shares: 820, limitPrice: 0.447, costUsd: 366.54, edgeC: 9.5, expectedProfitUsd: 77.9, midAtProposal: 0.44, midNow: 0.448, createdAt: Date.now(), expiresAt: Date.now() + 12 * 60_000, state: "pending", reason: null, error: null, orderId: null };
const book = {
  positions: [{ conditionId: "c1", question: "Will the Fed cut in Dec 2026?", tokenId: "t1", outcome: "YES", shares: 820, avgPrice: 0.447, markPrice: 0.46, unrealizedUsd: 10.66 }],
  openOrders: [{ orderId: "0x3fa1abcdef", question: "Senate confirms X by Nov 30?", side: "BUY", price: 0.3, shares: 100, filledShares: 20, status: "partial", expiresAt: null }],
  fills: [],
};
const paper = { summary: { open: 1, closed: 0, paperPnlUsd: 5, modeledEdgeUsd: 9, realizedEdgeUsd: 0, capture: null }, positions: [{ id: 1, conditionId: "c2", question: "Paper only market", side: "NO", size: 100, avgCost: 0.5, midNow: 0.55, unrealizedUsd: 5, modeledEdgeC: 3, realizedEdgeC: null, openedAt: Date.now(), closedAt: null }], fills: [] };
// L2 with the exchange configured, one pending proposal and live orders open.
const liveSetup = () => Object.assign(autonomy, { mode: "L2", executionEnabled: true, exchangeConfigured: true, pendingCount: 1, liveOpenOrders: 2, recon: { at: Date.now(), status: "ok", detail: null } });

const calls: string[] = [];
const bodies: unknown[] = [];
function fakeFetch() {
  vi.stubGlobal("fetch", vi.fn(async (url: URL, init?: RequestInit) => {
    const p = url.pathname;
    calls.push(`${init?.method ?? "GET"} ${p}`);
    if (init?.body) bodies.push(JSON.parse(String(init.body)));
    if (p === "/api/stream") return new Response(new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode(": connected\n\n")); } }), { status: 200 });
    if (p === "/api/watchlist") return Response.json(watch);
    if (p === "/api/autonomy") return Response.json(autonomy);
    if (p === "/api/autonomy/kill") return (autonomy.mode = "L0"), Response.json(autonomy.liveOpenOrders ? { cancelled: 2, failed: [] } : { mode: "L0", cancelledOrders: 0 });
    if (p === "/api/proposals") return Response.json({ pending: [prop], recent: [{ ...prop, id: "p0", state: "expired", reason: "PRICE_MOVED" }] });
    if (p === "/api/proposals/p1") return Response.json(JSON.parse(String(init?.body)).action === "approve" ? { ok: true, state: "sent", orderId: "0x3fa1abcdef" } : { ok: true, state: "rejected" });
    if (p === "/api/book/live") return Response.json(book);
    if (p === "/api/paper") return Response.json(paper);
    return Response.json({}, { status: 404 });
  }));
}
afterEach(() => (vi.unstubAllGlobals(), calls.splice(0), bodies.splice(0), Object.assign(autonomy, { mode: "L1", executionEnabled: false, exchangeConfigured: undefined, pendingCount: undefined, liveOpenOrders: undefined, recon: undefined })));

it("renders watchlist rows with question and signed, right-aligned edge", async () => {
  fakeFetch();
  const { app, frame, key, until } = mount();
  await until("L1 PAPER");
  const f = await until("● live");
  expect(f).toContain("Will the Fed cut in Dec 2026?");
  expect(f).toContain("+10.0");
  expect(f).toContain("-2.5");
  expect(f).toContain("● live");
  expect(f).toContain("L1 PAPER");
  await key("j"); // selection moves
  expect(await until(/▶.*Senate confirms/)).toMatch(/▶.*Senate confirms/);
  app.unmount();
});

it("K posts the kill switch from any view and shows KILLED → L0", async () => {
  autonomy.mode = "L1";
  fakeFetch();
  const { app, frame, key, until } = mount();
  await until("L1 PAPER");
  await key("2"); // fleet view (404 in the fake, irrelevant)
  await key("K");
  expect(await until("L0 Observe")).toContain("KILLED → L0");
  expect(calls).toContain("POST /api/autonomy/kill");
  app.unmount();
});

async function onAutonomy() {
  liveSetup();
  fakeFetch();
  const m = mount();
  await m.until("1 PENDING"); // header badge
  await m.key("5");
  await m.until("Approvals 1 pending");
  return m;
}

it("a then y approves the selected proposal live", async () => {
  const { app, key, until } = await onAutonomy();
  expect(await until("recon ✓ ok")).toContain("expired PRICE_MOVED");
  await key("a");
  expect(await until("SEND LIVE")).toContain("SEND LIVE: BUY YES 820 @ 0.447 = $366.54 ? y = confirm, any other key aborts");
  expect(calls).not.toContain("POST /api/proposals/p1");
  await key("y");
  expect(await until("sent ord 0x3fa1")).toContain("sent ord 0x3fa1");
  expect(calls).toContain("POST /api/proposals/p1");
  expect(bodies).toContainEqual({ action: "approve", via: "tui" });
  app.unmount();
});

it("a then any other key aborts without sending", async () => {
  const { app, key, until } = await onAutonomy();
  await key("a");
  await until("SEND LIVE");
  await key("a"); // even a second `a` is not a confirm
  expect(await until("aborted")).not.toContain("SEND LIVE");
  await key("y"); // y after the abort does nothing either
  await tick(100);
  expect(calls).not.toContain("POST /api/proposals/p1");
  app.unmount();
});

it("x rejects without a prompt", async () => {
  const { app, key, until } = await onAutonomy();
  await key("x");
  expect(await until("rejected")).not.toContain("SEND LIVE");
  expect(bodies).toContainEqual({ action: "reject", via: "tui" });
  app.unmount();
});

it("K with live orders open needs a second K", async () => {
  liveSetup();
  fakeFetch();
  const { app, key, until } = mount();
  await until("1 PENDING");
  await key("K");
  expect(await until("K again")).toContain("K again: kill + cancel 2 LIVE orders · any other key aborts");
  expect(calls).not.toContain("POST /api/autonomy/kill");
  await key("K");
  expect(await until("2 cancelled")).toContain("KILLED → L0 · 2 cancelled");
  expect(calls).toContain("POST /api/autonomy/kill");
  app.unmount();
});

it("Book defaults to Live at L2 and h/l switch to Paper with text tags", async () => {
  liveSetup();
  fakeFetch();
  const { app, key, until } = mount();
  await until("1 PENDING");
  await key("4");
  const f = await until("open orders 1");
  expect(f).toContain("[4]Book");
  expect(f).toMatch(/LIVE +Senate confirms/);
  expect(f).toContain("20/100");
  await key("x");
  expect(await until("exit proposal")).toContain("live positions close via an exit proposal");
  await key("l");
  const g = await until("Paper only market");
  expect(g).toMatch(/PAPER +Paper only market/);
  expect(g).not.toContain("open orders 1");
  app.unmount();
});

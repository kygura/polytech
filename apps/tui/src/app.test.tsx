import { render } from "ink";
import { PassThrough } from "node:stream";
import { afterEach, expect, it, vi } from "vitest";
import { App } from "./app";

// Tiny Ink test harness (ink-testing-library is untested against Ink 8): debug mode writes every frame raw.
function mount() {
  const stdin = Object.assign(new PassThrough(), { isTTY: true, setRawMode() {}, ref() {}, unref() {} });
  let last = "";
  const stdout = Object.assign(new PassThrough(), { isTTY: false, columns: 140, rows: 40 });
  stdout.on("data", (c: Buffer) => (last = c.toString()));
  const app = render(<App />, { stdin: stdin as never, stdout: stdout as never, debug: true, patchConsole: false });
  return { app, frame: () => last, key: async (s: string) => (stdin.write(s), tick()) };
}
const tick = () => new Promise((r) => setTimeout(r, 60));

const watch = [
  { conditionId: "c1", question: "Will the Fed cut in Dec 2026?", category: "politics", pinned: false, muted: false, researching: false, daysLeft: 41, thesisAgeH: 3, capped: false, nextCatalyst: "11-02 FOMC", side: "YES", pMid: 0.412, pHat: 0.58, c: 0.6, pPost: 0.512, edgeC: 10, payoff: 1.2, rAnn: 3.12, sizeUsd: 1250, expectedProfit: 125, rank: 1 },
  { conditionId: "c2", question: "Senate confirms X by Nov 30?", category: "politics", pinned: true, muted: false, researching: false, daysLeft: 46, thesisAgeH: 90, capped: true, nextCatalyst: null, side: "NO", pMid: 0.7, pHat: 0.52, c: 0.4, pPost: 0.6, edgeC: -2.5, payoff: 0.8, rAnn: 1.85, sizeUsd: 900, expectedProfit: -8, rank: 2 },
];
const autonomy = { mode: "L1" as string, executionEnabled: false, categories: [], limits: { perTradeUsd: 50, perTradePct: 0.05, dailyLoss: 100 }, usage: { totalOpen: 0, dailyNotional: 0, dailyRealizedLoss: 0 }, gates: [], events: [] };

const calls: string[] = [];
function fakeFetch() {
  vi.stubGlobal("fetch", vi.fn(async (url: URL, init?: RequestInit) => {
    const p = url.pathname;
    calls.push(`${init?.method ?? "GET"} ${p}`);
    if (p === "/api/stream") return new Response(new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode(": connected\n\n")); } }), { status: 200 });
    if (p === "/api/watchlist") return Response.json(watch);
    if (p === "/api/autonomy") return Response.json(autonomy);
    if (p === "/api/autonomy/kill") return (autonomy.mode = "L0"), Response.json({ mode: "L0", cancelledOrders: 0 });
    return Response.json({}, { status: 404 });
  }));
}
afterEach(() => (vi.unstubAllGlobals(), calls.splice(0)));

it("renders watchlist rows with question and signed, right-aligned edge", async () => {
  fakeFetch();
  const { app, frame, key } = mount();
  await tick();
  const f = frame();
  expect(f).toContain("Will the Fed cut in Dec 2026?");
  expect(f).toContain("+10.0");
  expect(f).toContain("-2.5");
  expect(f).toContain("● live");
  expect(f).toContain("L1 PAPER");
  await key("j"); // selection moves
  expect(frame()).toMatch(/▶.*Senate confirms/);
  app.unmount();
});

it("K posts the kill switch from any view and shows KILLED → L0", async () => {
  autonomy.mode = "L1";
  fakeFetch();
  const { app, frame, key } = mount();
  await tick();
  await key("2"); // fleet view (404 in the fake, irrelevant)
  await key("K");
  expect(calls).toContain("POST /api/autonomy/kill");
  expect(frame()).toContain("KILLED → L0");
  expect(frame()).toContain("L0 Observe");
  app.unmount();
});

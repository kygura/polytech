import { createHash } from "node:crypto";
import { beforeAll, describe, expect, it, vi } from "vitest";

process.env.PGLITE_DIR = "memory://";
process.env.PM_FIXTURES = "1";
process.env.CRON_SECRET = "cron-secret-for-tests-0123456789abcdef";
delete process.env.ANTHROPIC_API_KEY; // fake runner + judge

const cid = (k: string) => "0x" + createHash("sha256").update("cond:" + k).digest("hex");
const ctx = (o: Record<string, string>) => ({ params: Promise.resolve(o) });
const put = (url: string, body: unknown) => new Request(url, { method: "PUT", body: JSON.stringify(body) });
const post = (body?: unknown) => new Request("http://x/", { method: "POST", body: body === undefined ? undefined : JSON.stringify(body) });
const U = "http://x/api";

vi.mock("next/server", async (orig) => ({ ...(await orig<typeof import("next/server")>()), after: (f: () => unknown) => void f() })); // no request scope in tests

// The test env has no exchange, so the real rebaseline always refuses before the failed_unknown check. The mock keeps the real job and lets one test inject a needsAck refusal.
vi.mock("../../lib/jobs", async (importOriginal) => {
  const real = await importOriginal<typeof import("../../lib/jobs")>();
  return { ...real, rebaseline: vi.fn(real.rebaseline) };
});

let h: Record<string, any>;
beforeAll(async () => {
  const j = await import("../../lib/jobs"), a = await import("../../lib/api");
  const d = await a.getDeps();
  await j.sweepUniverse(d);
  await j.snapshotBooks(d, "all");
  await j.screenAll(d);
  h = {
    watchlist: await import("./watchlist/route"),
    market: await import("./markets/[id]/route"),
    flags: await import("./markets/[id]/flags/route"),
    search: await import("./markets/search/route"),
    ingest: await import("./markets/ingest/route"),
    settings: await import("./settings/route"),
    mode: await import("./autonomy/mode/route"),
    kill: await import("./autonomy/kill/route"),
    autonomy: await import("./autonomy/route"),
    rebaseline: await import("./recon/rebaseline/route"),
    bookLive: await import("./book/live/route"),
    stream: await import("./stream/route"),
    cron: await import("./cron/[job]/route"),
    close: await import("./paper/[positionId]/close/route"),
    proposals: await import("./proposals/route"),
    proposal: await import("./proposals/[id]/route"),
    push: await import("./proposals/[id]/push/route"),
    jobs: j,
  };
}, 60_000);

describe("http api", () => {
  it("watchlist tabs", async () => {
    for (const tab of ["small-cap", "size", "structural"]) {
      const r = await h.watchlist!.GET(new Request(`${U}/watchlist?tab=${tab}`));
      expect(r.status).toBe(200);
      expect(Array.isArray(await r.json())).toBe(true);
    }
    expect((await h.watchlist!.GET(new Request(`${U}/watchlist?tab=nope`))).status).toBe(400);
  });

  it("market search validates q, returns open matches, ingest upserts the pick", async () => {
    for (const q of ["", "a", "x".repeat(101)]) expect((await h.search!.GET(new Request(`${U}/markets/search?q=${q}`))).status).toBe(400);
    const r = await h.search!.GET(new Request(`${U}/markets/search?q=fed`));
    expect(r.status).toBe(200);
    const hits = await r.json();
    expect(hits.length).toBeGreaterThan(0);
    expect(hits.length).toBeLessThanOrEqual(10);
    // a pasted polymarket link searches by its slug words
    expect((await h.search!.GET(new Request(`${U}/markets/search?q=${encodeURIComponent("https://polymarket.com/event/fed-decision-in-december?tid=1")}`))).status).toBe(200);
    const bad = await h.ingest!.POST(post({ nope: 1 }));
    expect(bad.status).toBe(400);
    expect((await h.ingest!.POST(post({ id: "no-such-id" }))).status).toBe(404); // Gamma 404
    // malformed %-escape in a pasted link falls back to the raw slug instead of throwing
    expect((await h.search!.GET(new Request(`${U}/markets/search?q=${encodeURIComponent("https://polymarket.com/event/fed-%E0%A4%A")}`))).status).toBe(200);
    const ok = await h.ingest!.POST(post({ id: hits[0].id }));
    expect(ok.status).toBe(200);
    const { conditionId } = await ok.json();
    expect((await h.market!.GET(post(), ctx({ id: conditionId }))).status).toBe(200);
  });

  it("research answers 409 with the reason when the pod is skipped (no book)", async () => {
    const route = await import("./markets/[id]/research/route");
    const a = await import("../../lib/api"), { schema: sc } = await import("@pm/db");
    const d = await a.getDeps();
    const c = cid("nobook");
    await d.db.insert(sc.markets).values({ conditionId: c, question: "q", rules: "", tags: [], status: "active" } as any);
    const r = await route.POST(post(), ctx({ id: c }) as any);
    expect(r.status).toBe(409);
    expect(await r.json()).toMatchObject({ reason: "NO_BOOK" });
  });

  it("market detail 200 / 404", async () => {
    expect((await h.market!.GET(post(), ctx({ id: cid("a1") }))).status).toBe(200);
    expect((await h.market!.GET(post(), ctx({ id: "0xnope" }))).status).toBe(404);
  });

  it("settings PUT invalid -> 400 with issues; valid round-trips", async () => {
    const bad = await h.settings!.PUT(put(`${U}/settings`, { bankroll: "lots" }));
    expect(bad.status).toBe(400);
    expect((await bad.json()).issues.length).toBeGreaterThan(0);
    const ok = await h.settings!.PUT(put(`${U}/settings`, { bankroll: 2000 }));
    expect((await ok.json()).bankroll).toBe(2000);
  });

  it("settings PUT {suggested:null} clears a refit suggestion; apply writes extremize and clears together", async () => {
    const sug = { extremize: 1.12, n: 34, at: "2026-10-19" };
    expect((await (await h.settings!.PUT(put(`${U}/settings`, { suggested: sug }))).json()).suggested).toEqual(sug);
    const applied = await (await h.settings!.PUT(put(`${U}/settings`, { extremize: 1.12, suggested: null }))).json();
    expect(applied).toMatchObject({ extremize: 1.12, suggested: null });
    expect((await (await h.settings!.GET()).json()).suggested).toBeNull();
  });

  it("rebaseline: body {ack?} validated; no exchange in tests -> 409 {error, needsAck:false}", async () => {
    expect((await h.rebaseline!.POST(post({ ack: "yes" }))).status).toBe(400);
    for (const body of [undefined, { ack: true }]) {
      const r = await h.rebaseline!.POST(post(body));
      expect(r.status).toBe(409);
      expect(await r.json()).toEqual({ error: expect.any(String), needsAck: false });
    }
  });

  it("rebaseline: needsAck 409 carries diff; ack flag reaches the job", async () => {
    const { rebaseline } = await import("../../lib/jobs");
    vi.mocked(rebaseline).mockResolvedValueOnce({ ok: false, error: "1 live order(s) in failed_unknown since the last baseline", code: "FAILED_UNKNOWN", diff: "tok: ledger 1 vs exchange 0" });
    const r = await h.rebaseline!.POST(post());
    expect(r.status).toBe(409);
    expect(await r.json()).toEqual({ error: expect.any(String), needsAck: true, diff: "tok: ledger 1 vs exchange 0" });
    expect(vi.mocked(rebaseline)).toHaveBeenLastCalledWith(expect.anything(), { ack: false });
    await h.rebaseline!.POST(post({ ack: true }));
    expect(vi.mocked(rebaseline)).toHaveBeenLastCalledWith(expect.anything(), { ack: true });
  });

  it("mode L2 refused, L1 allowed, kill -> L0", async () => {
    const l2 = await (await h.mode!.POST(post({ to: "L2" }))).json();
    expect(l2.allowed).toBe(false);
    expect((await h.mode!.POST(post({ to: "L9" }))).status).toBe(400);
    expect((await (await h.mode!.POST(post({ to: "L1" }))).json()).mode).toBe("L1");
    expect(await (await h.kill!.POST()).json()).toEqual({ mode: "L0", cancelled: 0, failed: [] });
  });

  it("GET /api/book/live shape (empty book) + autonomy recon fields", async () => {
    const b = await (await h.bookLive!.GET()).json();
    expect(b).toEqual({ positions: [], openOrders: [], fills: [], recon: { at: null, status: null, detail: null } });
    expect(await (await h.autonomy!.GET()).json()).toMatchObject({ liveOpenOrders: 0, recon: { at: null, status: null, detail: null } });
  });

  it("flags update and unknown market 404", async () => {
    const id = cid("a1");
    expect((await h.flags!.POST(post({ muted: true }), ctx({ id }))).status).toBe(200);
    expect((await h.flags!.POST(post({ pinned: "x" }), ctx({ id }))).status).toBe(400);
    expect((await h.flags!.POST(post({ pinned: true }), ctx({ id: "0xnope" }))).status).toBe(404);
    const m = await (await h.market!.GET(post(), ctx({ id }))).json();
    expect(JSON.stringify(m)).toContain("muted");
  });

  it("cron: bad secret 401, unknown job 404, paper runs", async () => {
    const req = (secret: string) => new Request(`${U}/cron/paper`, { headers: { authorization: `Bearer ${secret}` } });
    expect((await h.cron!.GET(req("wrong"), ctx({ job: "paper" }))).status).toBe(401);
    expect((await h.cron!.GET(req("cron-secret-for-tests-0123456789abcdef"), ctx({ job: "nope" }))).status).toBe(404);
    expect((await (await h.cron!.GET(req("cron-secret-for-tests-0123456789abcdef"), ctx({ job: "paper" }))).json()).started).toBe(true);
  });

  it("close unknown position 404", async () => {
    expect((await h.close!.POST(post(), ctx({ positionId: "999999" }))).status).toBe(404);
  });

  it("proposals: list shape; decide validates id/body; push answers one generic 403", async () => {
    expect(await (await h.proposals!.GET()).json()).toEqual({ pending: [], recent: [], sets: { pending: [], recent: [] } });
    const uuid = "00000000-0000-4000-8000-000000000000";
    expect((await h.proposal!.POST(post({ action: "approve" }), ctx({ id: "nope" }))).status).toBe(404);
    expect((await h.proposal!.POST(post({ action: "launch" }), ctx({ id: uuid }))).status).toBe(400);
    expect((await h.proposal!.POST(post({ action: "reject" }), ctx({ id: uuid }))).status).toBe(404);
    for (const [id, body] of [[uuid, { action: "approve", token: "x" }], ["nope", { action: "approve", token: "x" }], [uuid, { action: "approve" }]] as const) {
      const r = await h.push!.POST(post(body), ctx({ id }));
      expect(r.status).toBe(403);
      expect(await r.json()).toEqual({ error: "invalid" });
    }
  });

  it("SSE emits a published event, then cleans up on abort", async () => {
    const ac = new AbortController();
    const res = await h.stream!.GET(new Request(`${U}/stream`, { signal: ac.signal }));
    expect(res.headers.get("content-type")).toBe("text/event-stream");
    const rd = res.body!.getReader(), dec = new TextDecoder();
    let buf = "";
    h.jobs.publish("pod.test", { n: 1 });
    while (!buf.includes("pod.test")) buf += dec.decode((await rd.read()).value);
    expect(buf).toContain('event: pod.test\ndata: {"n":1}');
    const before = (globalThis as any).__pmBus.listenerCount("event");
    ac.abort();
    expect((globalThis as any).__pmBus.listenerCount("event")).toBe(before - 1);
  });
});

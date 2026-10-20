import { schema as s } from "@pm/db";
import { eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";

process.env.PGLITE_DIR = "memory://";
process.env.PM_FIXTURES = "1";
delete process.env.ANTHROPIC_API_KEY; // fake runner + judge

const ctx = (id: string) => ({ params: Promise.resolve({ id }) });
let d: import("../../../lib/jobs").Deps, get: typeof import("./[id]/route"), cancel: typeof import("./[id]/cancel/route");
let done: string;

beforeAll(async () => {
  const j = await import("../../../lib/jobs");
  d = await (await import("../../../lib/api")).getDeps();
  await j.sweepUniverse(d); await j.snapshotBooks(d, "all");
  const all = (await d.db.select({ c: s.markets.conditionId }).from(s.markets).where(eq(s.markets.status, "active"))).map((r) => r.c);
  const snaps = await j.latestSnaps(d.db, all);
  const res = await j.researchMarket(d, all.find((c) => snaps.get(c)?.book && snaps.get(c)?.mid != null)!, "manual");
  if ("skipped" in res) throw new Error(res.reason);
  done = res.podId;
  get = await import("./[id]/route");
  cancel = await import("./[id]/cancel/route");
}, 60_000);

describe("/api/pods/:id", () => {
  it("GET returns pod, agents with toolCalls, evidence, thesis and budget", async () => {
    const res = await get.GET(new Request("http://x/"), ctx(done));
    expect(res.status).toBe(200);
    const b = await res.json();
    expect(b.pod).toMatchObject({ id: done, status: "done", stage: "done" });
    expect(b.pod.cost.costUsd).toBeGreaterThanOrEqual(0);
    expect(b.agents.map((a: { role: string }) => a.role)).toContain("judge");
    expect(b.agents.find((a: { role: string }) => a.role === "news").toolCalls.length).toBeGreaterThan(0);
    expect(b.evidence.length).toBeGreaterThan(0);
    expect(b).toHaveProperty("thesis");
    expect(b.budget).toMatchObject({ exaCallsPerPod: expect.any(Number), sandboxTimeoutMin: expect.any(Number) });
  });

  it("GET 404 on unknown pod", async () => expect((await get.GET(new Request("http://x/"), ctx("pod_nope"))).status).toBe(404));

  it("cancel: 404 unknown, 409 not running, 202 sets cancelRequestedAt on a running pod", async () => {
    const post = (id: string) => cancel.POST(new Request("http://x/", { method: "POST" }), ctx(id));
    expect((await post("pod_nope")).status).toBe(404);
    expect((await post(done)).status).toBe(409);
    await d.db.insert(s.pods).values({ id: "pod_running", conditionId: "0xabc", status: "running", trigger: "manual", stage: "agents" });
    expect((await post("pod_running")).status).toBe(202);
    const p = (await d.db.select().from(s.pods).where(eq(s.pods.id, "pod_running")))[0]!;
    expect(p.cancelRequestedAt).toBeTruthy();
    expect(p.status).toBe("running"); // the pod's own poller flips it
  });
});

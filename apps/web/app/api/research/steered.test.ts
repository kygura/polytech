import { DEFAULT_STEERING, ProfileFilterSchema, type ResearchProfile } from "@pm/core";
import { schema as s } from "@pm/db";
import { eq } from "drizzle-orm";
import { beforeAll, describe, expect, it, vi } from "vitest";

process.env.PGLITE_DIR = "memory://";
process.env.PM_FIXTURES = "1";
delete process.env.ANTHROPIC_API_KEY; // fake runner + judge

const later: (() => unknown)[] = [];
vi.mock("next/server", () => ({ after: (fn: () => unknown) => void later.push(fn) }));
const flush = async () => { while (later.length) await later.shift()!(); };

const ctx = (id: string) => ({ params: Promise.resolve({ id }) });
const post = (body?: unknown) => new Request("http://x/", { method: "POST", body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body) });

let j: typeof import("../../../lib/jobs"), d: import("../../../lib/jobs").Deps, mr: typeof import("../markets/[id]/research/route"), run: typeof import("./profiles/[id]/run/route");
let pool: string[]; // researchable markets
const mkProfile = (name: string, o: object = {}) => j.createProfile(d.db, { name, enabled: false, filter: ProfileFilterSchema.parse({ includeConditionIds: pool, limit: 2 }), steering: DEFAULT_STEERING, everyMin: null, ...o } as never) as Promise<ResearchProfile>;
const podsOf = (c: string) => d.db.select().from(s.pods).where(eq(s.pods.conditionId, c));
const rolesOf = async (podId: string) => (await d.db.select().from(s.agentRuns).where(eq(s.agentRuns.podId, podId))).map((r) => r.role);

beforeAll(async () => {
  j = await import("../../../lib/jobs") as never;
  const a = await import("../../../lib/api");
  d = await a.getDeps();
  await j.sweepUniverse(d); await j.snapshotBooks(d, "all"); await j.screenAll(d);
  pool = (await j.shortlist(d.db, 6)).map((x) => x.conditionId);
  mr = await import("../markets/[id]/research/route");
  run = await import("./profiles/[id]/run/route");
}, 60_000);

describe("POST /api/markets/:id/research", () => {
  it("empty body = old behavior: nothing steering-related persisted, five roles", async () => {
    const c = pool[0]!;
    expect((await mr.POST(post(), ctx(c))).status).toBe(202);
    await flush();
    const p = (await podsOf(c))[0]!;
    expect(p).toMatchObject({ profileId: null, steering: null, trigger: "manual" });
    expect((await rolesOf(p.id)).sort()).toEqual(["base_rate", "judge", "news", "red_team", "rules", "source"]);
  });

  it("400 on bad bodies, merged-invalid steering, 404 on unknown profile / market", async () => {
    const c = pool[1]!;
    for (const b of [{ bogus: 1 }, { steering: { roles: ["nope"] } }, { steering: { roles: [] } }, { steering: { bogus: 1 } }, { steering: { customRoles: [{ key: "rules", prompt: "x" }] } }, { steering: { models: { news: "gpt-5" } } }, { steering: { models: { ghost: "claude-haiku-5-5" } } }, "not json"])
      expect((await mr.POST(post(b), ctx(c))).status, JSON.stringify(b)).toBe(400);
    expect((await mr.POST(post({ profileId: "nope" }), ctx(c))).status).toBe(404);
    expect((await mr.POST(post(), ctx("0xnope"))).status).toBe(404);
    expect(later).toHaveLength(0);
  });

  it("profile base + override: resolved steering persisted, role subset runs", async () => {
    const c = pool[1]!;
    const p = await mkProfile("base", { steering: { roles: ["rules", "source", "news"], customRoles: [], models: {}, question: "profile q" } });
    expect((await mr.POST(post({ profileId: p.id, steering: { question: "override q" } }), ctx(c))).status).toBe(202);
    await flush();
    const pod = (await podsOf(c))[0]!;
    expect(pod.profileId).toBe(p.id);
    expect(pod.steering).toMatchObject({ roles: ["rules", "source", "news"], question: "override q" });
    expect((await rolesOf(pod.id)).sort()).toEqual(["judge", "news", "rules", "source"]);
  });

  it("steering only (no profile): custom role runs and is recorded", async () => {
    const c = pool[2]!;
    await mr.POST(post({ steering: { roles: ["rules"], customRoles: [{ key: "macro", prompt: "Look at macro." }] } }), ctx(c));
    await flush();
    const pod = (await podsOf(c))[0]!;
    expect(pod.profileId).toBeNull();
    expect((await rolesOf(pod.id)).sort()).toEqual(["judge", "macro", "rules"]);
  });
});

describe("profile run + cron", () => {
  it("run endpoint: 202 queued ids, last_run_at set, pods tagged with profile and trigger", async () => {
    const p = await mkProfile("runme", { steering: { roles: ["rules", "source", "news"], customRoles: [], models: {} } });
    expect((await run.POST(post(), ctx("nope"))).status).toBe(404);
    const r = await run.POST(post(), ctx(p.id));
    expect(r.status).toBe(202);
    const { queued } = await r.json();
    expect(queued.length).toBeGreaterThan(0);
    await flush();
    expect((await j.getProfile(d.db, p.id))!.lastRunAt).not.toBeNull();
    for (const c of queued) expect((await podsOf(c)).find((x) => x.profileId === p.id)).toMatchObject({ trigger: "profile" });
  });

  it("runProfile stops when the daily pod budget is exhausted", async () => {
    const p = await mkProfile("budget", { filter: ProfileFilterSchema.parse({ includeConditionIds: pool, skipIfResearchedWithinHours: 0, limit: 4 }) });
    const n = (await d.db.select().from(s.pods)).length;
    const tight = { ...d, settings: { ...d.settings, budget: { ...d.settings.budget, maxPodsPerDay: n + 1 } } };
    const r = await j.runProfile(tight, p, await j.matchMarkets(d.db, p.filter, d.now())) as { done: number; stopped: string | null };
    expect(r.done).toBe(1);
    expect(r.stopped).toBeTruthy();
    expect((await j.getProfile(d.db, p.id))!.lastRunAt).toBeNull(); // not all matches ran: retried next tick
  });

  it("runDueProfiles picks only enabled, scheduled, elapsed profiles", async () => {
    for (const x of await j.listProfiles(d.db)) await j.deleteProfile(d.db, x.id);
    const f = ProfileFilterSchema.parse({ includeConditionIds: pool, skipIfResearchedWithinHours: 0, limit: 1 });
    const due = await mkProfile("due", { enabled: true, everyMin: 60, filter: f });
    await mkProfile("never-scheduled", { enabled: true, everyMin: null, filter: f });
    await mkProfile("disabled", { enabled: false, everyMin: 60, filter: f });
    const recent = await mkProfile("recent", { enabled: true, everyMin: 60, filter: f });
    await d.db.update(s.researchProfiles).set({ lastRunAt: new Date(d.now() - 10 * 60_000) }).where(eq(s.researchProfiles.id, recent.id));
    const old = await mkProfile("old", { enabled: true, everyMin: 60, filter: f });
    await d.db.update(s.researchProfiles).set({ lastRunAt: new Date(d.now() - 90 * 60_000) }).where(eq(s.researchProfiles.id, old.id));
    expect((await j.runDueProfiles(d)).sort()).toEqual([due.id, old.id].sort());
    expect((await j.getProfile(d.db, recent.id))!.lastRunAt!.getTime()).toBeLessThan(d.now() - 5 * 60_000);
  });
});

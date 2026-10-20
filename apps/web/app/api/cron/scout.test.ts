import { describe, expect, it, vi } from "vitest";

process.env.PGLITE_DIR = "memory://";
process.env.PM_FIXTURES = "1";
process.env.CRON_SECRET = "cron-secret-for-tests-0123456789abcdef";
delete process.env.ANTHROPIC_API_KEY;

const after = vi.fn(); // captured, not run: the chain itself is covered by kick.test.ts
vi.mock("next/server", async (orig) => ({ ...(await orig<typeof import("next/server")>()), after: (f: unknown) => after(f) }));

const ctx = { params: Promise.resolve({ job: "scout" }) };
const req = (secret: string) => new Request("http://x/api/cron/scout", { headers: { authorization: `Bearer ${secret}` } });

describe("cron scout", () => {
  it("needs CRON_SECRET; starts the chain once (after the response), then reports not started while fresh", async () => {
    const { GET, POST } = await import("./[job]/route");
    expect((await GET(req("wrong"), ctx)).status).toBe(401);
    expect(after).not.toHaveBeenCalled();
    const r = await GET(req(process.env.CRON_SECRET!), ctx);
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ started: true });
    expect(after).toHaveBeenCalledTimes(1);
    expect(await (await POST(req(process.env.CRON_SECRET!), ctx)).json()).toEqual({ started: false }); // kick lock + 30 min freshness
    expect(after).toHaveBeenCalledTimes(1);
  });
});

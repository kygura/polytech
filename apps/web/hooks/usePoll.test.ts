import { describe, expect, it, vi } from "vitest";
import { fetchOnce } from "./usePoll";

describe("fetchOnce", () => {
  it("null url: no request", async () => {
    const get = vi.fn();
    expect(await fetchOnce(null, get as unknown as typeof fetch)).toBeNull();
    expect(get).not.toHaveBeenCalled();
  });
  it("ok -> data; non-2xx -> status + error, no data; throw -> network error", async () => {
    const ok = (async () => new Response(JSON.stringify({ a: 1 }), { status: 200 })) as unknown as typeof fetch;
    expect(await fetchOnce("/x", ok)).toMatchObject({ data: { a: 1 }, error: null, status: 200 });
    const nf = (async () => new Response("", { status: 404 })) as unknown as typeof fetch;
    const r = await fetchOnce("/x", nf);
    expect(r).toEqual({ error: "HTTP 404", status: 404 });
    const down = (async () => { throw new Error("x"); }) as unknown as typeof fetch;
    expect(await fetchOnce("/x", down)).toEqual({ error: "network error", status: null });
  });
});

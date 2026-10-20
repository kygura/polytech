import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { DELETE, GET } from "./route";

const ctx = (host: string, ...path: string[]) => ({ params: Promise.resolve({ host, path }) });
let fetchMock: ReturnType<typeof vi.fn>;
beforeEach(() => {
  fetchMock = vi.fn(async () => new Response('{"ok":true}', { status: 201, headers: { "content-type": "application/json", "set-cookie": "a=b", "poly-ratelimit-remaining": "9" } }));
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

it("404 for a host outside the allowlist", async () => {
  for (const host of ["evil.com", "constructor", "__proto__"]) {
    expect((await GET(new Request("http://x/api/pm/x/y"), ctx(host, "y"))).status).toBe(404);
  }
  expect(fetchMock).not.toHaveBeenCalled();
});

it("forwards method, path, query, body and POLY_* headers; strips cookie and forwarding headers", async () => {
  const req = new Request("http://x/api/pm/clob/orders?market=1", {
    method: "DELETE",
    headers: {
      cookie: "a=b",
      "content-type": "application/json",
      POLY_SIGNATURE: "sig",
      POLY_API_KEY: "k",
      "x-forwarded-for": "1.2.3.4",
      authorization: "Bearer nope",
    },
    body: '["o1"]',
  });
  const r = await DELETE(req, ctx("clob", "orders"));
  expect(fetchMock).toHaveBeenCalledOnce();
  const [url, init] = fetchMock.mock.calls[0]! as [string, RequestInit];
  expect(url).toBe("https://clob.polymarket.com/orders?market=1");
  expect(init.method).toBe("DELETE");
  expect(init.body).toBe('["o1"]');
  expect(Object.fromEntries(init.headers as Headers)).toEqual({ "content-type": "application/json", poly_signature: "sig", poly_api_key: "k" });
  expect(r.status).toBe(201);
  expect(await r.json()).toEqual({ ok: true });
  expect(r.headers.get("set-cookie")).toBeNull();
  expect(r.headers.get("poly-ratelimit-remaining")).toBe("9");
});

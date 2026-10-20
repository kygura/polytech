import { afterEach, describe, expect, it } from "vitest";
import { GET } from "./route";

describe("/api/session", () => {
  afterEach(() => { delete process.env.AUTH_DISABLED; });
  it("operator only with a session, or always when AUTH_DISABLED", async () => {
    process.env.JWT_SECRET = "x".repeat(32);
    expect(await (await GET(new Request("http://localhost/api/session"))).json()).toEqual({ operator: false });
    process.env.AUTH_DISABLED = "1";
    expect(await (await GET(new Request("http://localhost/api/session"))).json()).toEqual({ operator: true });
  });
});

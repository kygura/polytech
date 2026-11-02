import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => { vi.unstubAllEnvs(); vi.resetModules(); delete (globalThis as { __pmDb?: unknown }).__pmDb; });

describe("getDb target", () => {
  it("DB_FILE wins over TURSO_DATABASE_URL, so a test run with Turso credentials in the env stays local", async () => {
    vi.stubEnv("TURSO_DATABASE_URL", "libsql://polytech-prod.example.turso.io");
    vi.stubEnv("TURSO_AUTH_TOKEN", "t");
    vi.stubEnv("DB_FILE", ":memory:");
    const c = await import("./client");
    expect(c.hostedDb()).toBe(false);
    await c.migrate(); // a remote URL would fail here (no network in tests)
    await c.closeDb();
  });
  it("TURSO_DATABASE_URL alone is hosted", async () => {
    vi.stubEnv("TURSO_DATABASE_URL", "libsql://polytech-prod.example.turso.io");
    vi.stubEnv("DB_FILE", "");
    delete process.env.DB_FILE;
    expect((await import("./client")).hostedDb()).toBe(true);
  });
});

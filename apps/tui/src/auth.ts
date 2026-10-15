import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

const dir = () => join(homedir(), ".config", "pm-edge");
export const tokenPath = () => join(dir(), "token");

export async function saveToken(token: string): Promise<void> {
  await mkdir(dir(), { recursive: true, mode: 0o700 });
  await chmod(dir(), 0o700);
  const tmp = `${tokenPath()}.${process.pid}.tmp`;
  await writeFile(tmp, token, { mode: 0o600, flag: "wx" });
  await rename(tmp, tokenPath()); // atomic replace, keeps 0600
}

export async function loadToken(): Promise<string | null> {
  try {
    return (await readFile(tokenPath(), "utf8")).trim() || null;
  } catch {
    return null;
  }
}

export async function authHeaders(): Promise<Record<string, string>> {
  const t = await loadToken();
  return t ? { Authorization: `Bearer ${t}` } : {};
}

export async function login(apiBase: string, password: string): Promise<void> {
  const res = await fetch(new URL("/api/login", apiBase), {
    method: "POST",
    headers: { "content-type": "application/json", "x-client": "tui" },
    body: JSON.stringify({ password }),
  });
  if (!res.ok) throw new Error(res.status === 429 ? "too many attempts, try later" : `login failed (${res.status})`);
  const { token } = (await res.json()) as { token?: unknown };
  if (typeof token !== "string" || !token) throw new Error("login response missing token");
  await saveToken(token);
}

import { useEffect, useState } from "react";

export const BASE = process.env.PM_API_BASE ?? "http://localhost:3000";

export async function api<T>(path: string, init: RequestInit & { json?: unknown } = {}): Promise<T> {
  const { json, ...rest } = init;
  const res = await fetch(new URL(path, BASE), {
    ...rest,
    body: json === undefined ? rest.body : JSON.stringify(json),
    headers: { ...(json !== undefined && { "content-type": "application/json" }), ...rest.headers },
  });
  if (!res.ok) throw new Error(`${res.status} ${path}: ${await res.text().catch(() => "")}`.trim());
  return res.json() as Promise<T>;
}
export const post = <T>(path: string, json?: unknown) => api<T>(path, { method: "POST", json });

/** Fetches `path` on mount and whenever `tick` changes. */
export function useFetch<T>(path: string | null, tick = 0) {
  const [s, set] = useState<{ data?: T; error?: string }>({});
  useEffect(() => {
    if (!path) return;
    let on = true;
    api<T>(path).then(
      (data) => on && set({ data }),
      (e: Error) => on && set((p) => ({ ...p, error: e.message })),
    );
    return () => void (on = false);
  }, [path, tick]);
  return s;
}

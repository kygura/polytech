// Display formatting only; nothing is computed here beyond rounding.
export type Fmt = "p" | "cents" | "usd" | "pct" | "int" | "x";

const MINUS = "−";
const sign = (v: number, s: string) => (v < 0 ? MINUS + s : "+" + s);

export function fmt(value: number | null | undefined, f: Fmt, signed = false): string {
  if (value == null || Number.isNaN(value)) return "—";
  const a = Math.abs(value);
  let s: string;
  switch (f) {
    case "p": s = a.toFixed(3); break;
    case "cents": s = a.toFixed(1); break;
    case "usd": s = a < 1000 ? a.toLocaleString("en-US", { maximumFractionDigits: 0 }) : a.toLocaleString("en-US", { minimumFractionDigits: 1, maximumFractionDigits: 1 }); break;
    case "pct": s = a >= 5 ? "500%+" : `${Math.round(a * 100)}%`; break;
    case "int": s = Math.round(a).toLocaleString("en-US"); break;
    case "x": s = `${a.toFixed(2)}×`; break;
  }
  return signed ? sign(value, s) : value < 0 ? MINUS + s : s;
}

const pad = (n: number) => String(n).padStart(2, "0");
export const hms = (t: number) => { const d = new Date(t); return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`; };
export const hm = (t: number) => { const d = new Date(t); return `${pad(d.getHours())}:${pad(d.getMinutes())}`; };
export const mmdd = (t: number) => { const d = new Date(t); return `${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
export const ago = (ms: number) => (ms < 3_600_000 ? `${Math.max(0, Math.round(ms / 60_000))}m ago` : ms < 86_400_000 ? `${Math.round(ms / 3_600_000)}h ago` : `${Math.round(ms / 86_400_000)}d ago`);
export const dur = (s: number) => (s < 60 ? `${Math.round(s)}s` : `${Math.floor(s / 60)}m${pad(Math.round(s % 60))}s`);
export const host = (url: string) => { try { return new URL(url).host; } catch { return url; } };
export const truncate = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + "…" : s);
export const words = (s: string, n: number) => { const w = s.split(/\s+/); return w.length > n ? w.slice(0, n).join(" ") + "…" : s; };

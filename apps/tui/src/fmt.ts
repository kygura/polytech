// Pure formatters. Numbers come back right-aligned to `w` when given.
const r = (s: string, w?: number) => (w ? s.padStart(w) : s);
export const left = (s: string | null | undefined, w: number) => {
  const t = (s ?? "").length > w ? (s ?? "").slice(0, w - 1) + "…" : (s ?? "");
  return t.padEnd(w);
};
export const dash = (w?: number) => r("—", w);

export const num = (v: number | null | undefined, d = 3, w?: number) => (v == null ? dash(w) : r(v.toFixed(d), w));
export const int = (v: number | null | undefined, w?: number) => (v == null ? dash(w) : r(Math.round(v).toLocaleString("en-US"), w));
export const signed = (v: number | null | undefined, d = 1, w?: number) => (v == null ? dash(w) : r((v >= 0 ? "+" : "-") + Math.abs(v).toFixed(d), w));
export const signedInt = (v: number | null | undefined, w?: number) => (v == null ? dash(w) : r((v >= 0 ? "+" : "-") + Math.abs(Math.round(v)).toLocaleString("en-US"), w));
export const usd = (v: number | null | undefined) => (v == null ? "—" : "$" + Math.round(v).toLocaleString("en-US"));
export const pct = (v: number | null | undefined, w?: number, cap?: number) =>
  v == null ? dash(w) : r(cap != null && v >= cap ? `${Math.round(cap * 100)}%+` : `${Math.round(v * 100)}%`, w);
export const big = (n: number) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : String(n));

export const hhmm = (ms: number) => new Date(ms).toTimeString().slice(0, 5);
export const mmdd = (ms: number | null | undefined) => (ms == null ? "—" : new Date(ms).toISOString().slice(5, 10));
export const elapsed = (ms: number) => {
  const s = Math.max(0, Math.floor(ms / 1000));
  return s < 3600 ? `${Math.floor(s / 60)}m${String(s % 60).padStart(2, "0")}s` : `${Math.floor(s / 3600)}h${String(Math.floor((s % 3600) / 60)).padStart(2, "0")}m`;
};
export const ago = (h: number | null | undefined) => (h == null ? "—" : h < 1 ? `${Math.round(h * 60)}m ago` : h < 48 ? `${Math.round(h)}h ago` : `${Math.round(h / 24)}d ago`);

const BARS = "▁▂▃▄▅▆▇█";
export const sparkline = (xs: number[], n = 24) => {
  const v = xs.slice(-n);
  if (!v.length) return "";
  const lo = Math.min(...v), hi = Math.max(...v), span = hi - lo || 1;
  return v.map((x) => BARS[Math.min(7, Math.floor(((x - lo) / span) * 8))]).join("");
};

/** First visible index so that `sel` stays inside a window of `h` rows. */
export const windowStart = (sel: number, h: number, n: number) => Math.max(0, Math.min(sel - Math.floor(h / 2), n - h));

export const clamp = (i: number, n: number) => Math.max(0, Math.min(i, n - 1));

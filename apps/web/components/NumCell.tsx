import { fmt, type Fmt } from "./fmt";

/** Formatted number span; null renders "—". Place inside a right-aligned cell. */
export function NumCell({ value, fmt: f, signed, muted, title }: { value: number | null | undefined; fmt: Fmt; signed?: boolean; muted?: boolean; title?: string }) {
  const cls = muted || value == null ? "muted" : signed ? (value > 0 ? "pos" : value < 0 ? "neg" : "muted") : undefined;
  return <span className={cls} title={title}>{fmt(value, f, signed)}</span>;
}

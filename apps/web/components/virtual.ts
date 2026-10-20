// Pure window math for DataTable `virtual` mode (fixed row height, no deps).
export type VirtualOpts = {
  rowHeight: number;
  overscan: number;
  /** CSS height of the scroll container (the caller's layout decides). */
  height?: string;
  /** Called when the rendered window changes; `end` is exclusive. */
  onWindow?: (w: { start: number; end: number }) => void;
};

export const HEADER_H = 28; // sticky <th> height (globals.css)

/** Rows [start, end) to render plus the spacer heights standing in for the rest. */
export function virtualWindow(o: { scrollTop: number; viewport: number; rowHeight: number; overscan: number; count: number }) {
  const { rowHeight: h, overscan, count } = o;
  const first = Math.max(0, Math.floor(Math.max(0, o.scrollTop) / h));
  const visible = Math.ceil(Math.max(0, o.viewport) / h) + 1;
  const start = Math.max(0, Math.min(count, first - overscan));
  const end = Math.max(start, Math.min(count, first + visible + overscan));
  return { start, end, padTop: start * h, padBottom: (count - end) * h };
}

/** New scrollTop that brings row `index` fully into view (below the sticky header), or null if it already is. */
export function scrollTopForRow(o: { index: number; scrollTop: number; viewport: number; rowHeight: number }): number | null {
  const top = o.index * o.rowHeight; // offset within the rows area
  if (top < o.scrollTop) return top;
  const bottom = top + o.rowHeight + HEADER_H;
  if (bottom > o.scrollTop + o.viewport) return bottom - o.viewport;
  return null;
}

/** Sum of px widths (`width`, else `minWidth`), for the fixed-layout table's min-width. */
export function minTableWidth(cols: { width?: string; minWidth?: string }[]): number {
  return cols.reduce((n, c) => n + (parseInt(c.width ?? c.minWidth ?? "0", 10) || 0), 0);
}

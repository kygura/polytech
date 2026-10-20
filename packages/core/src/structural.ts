// Structural mispricing detection: executable neg-risk overround, sibling-sum inconsistency, ladder monotonicity. Pure.
import { DEFAULT_FEE_RATE, feeExponentOf, takerFeePerShare } from "./fees";

export type StructuralKind = "overround" | "monotonicity_violation" | "sibling_inconsistency";

export type StructuralItem = {
  kind: StructuralKind;
  eventId: string;
  eventTitle: string | null;
  conditionIds: string[]; // markets involved; monotonicity: [lower rung value, higher rung value]
  magnitude: number; // raw violation in probability points
  net: number; // executable edge after taker fees (prob units); <= 0 means not worth trading
  side?: "ask" | "bid"; // overround / sibling: "ask" = buy every YES, "bid" = sell every YES
  description: string;
};

export type StructuralMarket = {
  conditionId: string;
  question: string;
  endDate: number | null; // epoch ms
  bestBid: number | null;
  bestAsk: number | null;
  mid: number | null;
  threshold?: number | null;
  /** Outcome labels (YES first). "Over"/"Under" as outcomes[0] fixes the direction of Over/Under ladders. */
  outcomes?: string[] | null;
  /** Taker fee rate (rate·(p(1−p))^feeExponent per share). Missing → conservative default. */
  feeRate?: number | null;
  /** Gamma feeSchedule.exponent; missing → 1. */
  feeExponent?: number | null;
  /** Shares resting at the best ask / bid, when known (min-ticket check on overround baskets). */
  askSize?: number | null;
  bidSize?: number | null;
};
export type StructuralGroup = {
  eventId: string;
  eventTitle: string | null;
  negRisk: boolean;
  /** Augmented neg-risk events can gain outcomes later (unlisted "other" can win): Σasks<1 is not a lock, so it is skipped. */
  negRiskAugmented?: boolean;
  /** Some of the event's markets are inactive/missing from `markets`: the listed set may not be exhaustive. */
  hasInactiveMarkets?: boolean;
  markets: StructuralMarket[];
};
export type StructuralOptions = {
  /** Slack (prob units, summed over the event) before Σasks<1 / Σbids>1 counts as an objective edge. Default 0.01. */
  overroundTolerance?: number;
  /** Slack between ladder rungs (prob units). Default 0.01. */
  monotonicTolerance?: number;
  /** |Σmid − 1| allowed for a mutually exclusive set. Default 0.05. */
  siblingTolerance?: number;
  /** Basket size (shares ≈ $ of payoff) every leg must be able to fill when sizes are supplied. Default 25. */
  minTicket?: number;
};

const fin = (x: unknown): x is number => typeof x === "number" && Number.isFinite(x);
const pc = (x: number) => `${(x * 100).toFixed(1)}¢`;

// ───────────── ladder keys ─────────────

export type LadderKey =
  | { kind: "date"; value: number; stem: string; decreasing: boolean }
  | { kind: "threshold"; value: number; dir: "above" | "below"; stem: string };

const MONTHS = "january|jan|february|feb|march|mar|april|apr|may|june|jun|july|jul|august|aug|september|sept|sep|october|oct|november|nov|december|dec";
const monthIdx = (s: string) => ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"].indexOf(s.slice(0, 3).toLowerCase());
const DATE_RE = new RegExp(
  `\\b(by|before|until|till|through|on or before)\\s+(?:the\\s+)?(?:end\\s+of\\s+)?(${MONTHS})\\b\\.?(?:\\s+(\\d{1,2})(?!\\d)(?:st|nd|rd|th)?)?(?:,?\\s+(\\d{4}))?`,
  "i",
);
const YEAR_RE = /\b(by|before|until|till|through)\s+(?:the\s+)?(?:end\s+of\s+)?(\d{4})\b/i;
/** "continues/remains/stays/lasts/survives … through|until <date>": P falls as the date moves out. */
const PERSIST_RE = /\b(?:continu(?:es|ed|e|ing)|remain(?:s|ed)?|stay(?:s|ed)?|last(?:s|ed)?|surviv(?:es|e|ed)|persist(?:s|ed)?|endur(?:es|e|ed))\b/i;
const DECREASING_PREP = /^(?:until|till|through)$/i;
// Explicit comparators only. Plain "hit/reach X" is direction-ambiguous (see HIT_RE + HIGH/LOW markers).
const UP = "above|over|exceed(?:s|ing)?|greater than|more than|at least|higher than";
const DOWN = "below|under|less than|fewer than|at most|lower than|dip(?:s)? to|drop(?:s)? to|fall(?:s)? to|fall(?:s)? below";
const NUM = "(-?\\d[\\d,]*(?:\\.\\d+)?)\\s*(thousand|million|billion|trillion|bn|k|m|b|%)?(?![a-z0-9])";
const THRESH_RE = new RegExp(`(?:\\b(${UP}|${DOWN})\\b|(≥|>=|>|≤|<=|<))\\s*\\$?\\s*${NUM}`, "i");
const OR_MORE_RE = new RegExp(`\\$?${NUM}\\s+or\\s+(more|higher|above|greater|over|less|fewer|lower|below|under)\\b`, "i");
const HIT_RE = new RegExp(`\\b(?:hit|hits|reach|reaches|touch|touches)\\s*\\$?\\s*${NUM}`, "i");
const OU_RE = new RegExp(`\\b(?:over\\s*/\\s*under|over-under|o\\s*/\\s*u|total[^:?]*?:\\s*over)\\s*\\$?\\s*${NUM}`, "i");
const MARKER_RE = /\((high|low)\)/i;
/** Range buckets ("6.5-7.5%", "between X and Y", "from X to Y") and exact counts are not ladder rungs. */
const RANGE_RE = /(?<![\d-])\d[\d,]*(?:\.\d+)?\s*[%a-z]{0,3}\s*(?:-|–|—|\bto\b)\s*\$?\d[\d,]*(?:\.\d+)?(?![\d-])|\bbetween\b[^?]*?\band\b|\bexactly\b/i;
const MULT: Record<string, number> = { thousand: 1e3, k: 1e3, million: 1e6, m: 1e6, billion: 1e9, bn: 1e9, b: 1e9, trillion: 1e12 };
const DOWN_RE = new RegExp(`^(?:${DOWN}|≤|<=|<|less|fewer|lower|below|under)$`, "i");
const norm = (s: string) => s.toLowerCase().replace(/[?.!]/g, " ").replace(/\s+/g, " ").trim();
const lastDay = (y: number, m: number) => new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
const DAY = 86_400_000;

export type LadderContext = {
  /** The market's own end date (epoch ms): resolves yearless "by Jun 30" to the year whose Jun 30 is nearest. */
  endDate?: number | null;
  /** Outcome labels; outcomes[0] of "Over"/"Under" fixes the Over/Under direction. */
  outcomes?: readonly string[] | null;
  /** Yearless dates with no endDate/refYear are skipped instead of defaulting to year 2000. */
  strictYear?: boolean;
};

function dateKey(q: string, refYear: number | undefined, ctx: LadderContext): Extract<LadderKey, { kind: "date" }> | null {
  const decreasing = (prep: string) => DECREASING_PREP.test(prep) || PERSIST_RE.test(q);
  const endMs = fin(ctx.endDate) ? ctx.endDate : NaN;
  const m = DATE_RE.exec(q);
  if (m) {
    const prep = m[1]!.toLowerCase();
    const mi = monthIdx(m[2]!);
    const day = m[3] ? Number(m[3]) : null;
    if (day !== null && (day < 1 || day > 31)) return null;
    // "before <Month D>" = through D−1; "before <Month>" = through the last day of the previous month
    const at = (y: number) => (prep === "before" ? Date.UTC(y, mi, day === null ? 0 : day - 1) : Date.UTC(y, mi, day ?? lastDay(y, mi)));
    let value: number;
    if (m[4]) value = at(Number(m[4]));
    else if (Number.isFinite(endMs)) {
      const ey = new Date(endMs).getUTCFullYear();
      value = [ey - 1, ey, ey + 1].map(at).sort((a, b) => Math.abs(a - endMs) - Math.abs(b - endMs))[0]!;
      if (prep !== "before" && Math.abs(value - endMs) <= 3 * DAY) value = Math.floor(endMs / DAY) * DAY; // question date ≈ endDate: use endDate
    } else if (refYear !== undefined) value = at(refYear);
    else if (ctx.strictYear) return null;
    else value = at(2000);
    return { kind: "date", value, stem: norm(q.replace(m[0], " <D> ")), decreasing: decreasing(prep) };
  }
  const y = YEAR_RE.exec(q);
  if (y) {
    const prep = y[1]!.toLowerCase();
    const yr = Number(y[2]);
    return { kind: "date", value: Date.UTC(prep === "before" ? yr - 1 : yr, 11, 31), stem: norm(q.replace(y[0], " <D> ")), decreasing: decreasing(prep) };
  }
  return null;
}

const toValue = (n: string, suf?: string) => {
  const raw = Number(n.replace(/,/g, ""));
  const s = suf?.toLowerCase();
  return raw * (s && MULT[s] ? MULT[s]! : 1);
};

function thresholdKey(q: string, ctx: LadderContext): Extract<LadderKey, { kind: "threshold" }> | null {
  if (RANGE_RE.test(q)) return null;
  const mk = (value: number, dir: "above" | "below", matched: string, tag: string) =>
    Number.isFinite(value) ? ({ kind: "threshold", value, dir, stem: norm(q.replace(matched, ` ${tag} <T> `)) } as const) : null;
  const ou = OU_RE.exec(q);
  if (ou) {
    const first = ctx.outcomes?.[0]?.trim().toLowerCase();
    return mk(toValue(ou[1]!, ou[2]), first === "under" ? "below" : "above", ou[0], "ou");
  }
  const marker = MARKER_RE.exec(q); // "(HIGH)": touched at any time ≥ X; "(LOW)": touched ≤ X
  if (marker) {
    const h = HIT_RE.exec(q) ?? THRESH_RE.exec(q);
    if (!h) return null;
    const isHit = h.length === 3;
    const value = isHit ? toValue(h[1]!, h[2]) : toValue(h[3]!, h[4]);
    return mk(value, marker[1]!.toLowerCase() === "high" ? "above" : "below", h[0], marker[1]!.toLowerCase());
  }
  const m = THRESH_RE.exec(q);
  if (m) {
    const word = (m[1] ?? m[2])!;
    return mk(toValue(m[3]!, m[4]), DOWN_RE.test(word.trim()) ? "below" : "above", m[0], word.toLowerCase());
  }
  const om = OR_MORE_RE.exec(q);
  if (om) return mk(toValue(om[1]!, om[2]), DOWN_RE.test(om[3]!) ? "below" : "above", om[0], `or ${om[3]!.toLowerCase()}`);
  return null;
}

/** Direction words only (no number): used with an explicit `threshold` value. Plain "hit/reach" stays ambiguous (null). */
function directionOnly(q: string, ctx: LadderContext): "above" | "below" | null {
  if (RANGE_RE.test(q)) return null;
  const marker = MARKER_RE.exec(q);
  if (marker) return marker[1]!.toLowerCase() === "high" ? "above" : "below";
  if (/\b(?:over\s*\/\s*under|o\s*\/\s*u)\b/i.test(q)) return ctx.outcomes?.[0]?.trim().toLowerCase() === "under" ? "below" : "above";
  const w = new RegExp(`\\b(${UP}|${DOWN})\\b|(≥|>=|>|≤|<=|<)`, "i").exec(q);
  return w ? (DOWN_RE.test((w[1] ?? w[2])!.trim()) ? "below" : "above") : null;
}

/**
 * Ladder position of a market question: a "by <date>" deadline (preferred) or an explicit above/below/Over-Under/(HIGH)/(LOW)
 * numeric threshold. Range buckets, exact counts and plain "hit/reach X" return null. `refYear` / `ctx.endDate` fill dates lacking a year.
 */
export function parseLadderKey(question: string, refYear?: number, ctx: LadderContext = {}): LadderKey | null {
  return dateKey(question ?? "", refYear, ctx) ?? thresholdKey(question ?? "", ctx);
}

// ───────────── checks ─────────────

const feeOf = (m: Pick<StructuralMarket, "feeRate" | "feeExponent">, price: number) =>
  takerFeePerShare(fin(m.feeRate) && m.feeRate >= 0 ? m.feeRate : DEFAULT_FEE_RATE, Math.min(1, Math.max(0, price)), feeExponentOf(m.feeExponent));

type Basket = { side: "ask" | "bid"; sum: number; fees: number; gap: number; ids: string[] };

/** Σasks<1 (buy every YES) or Σbids>1 (sell every YES) basket for a negRisk event; `gap` is the raw lock, `fees` the taker fees to pay. */
function baskets(g: StructuralGroup, minTicket: number): Basket[] {
  if (!g.negRisk || g.markets.length < 2) return [];
  const incomplete = !!g.negRiskAugmented || !!g.hasInactiveMarkets; // Σasks<1 is no lock if the listed set may not be exhaustive
  const ids = g.markets.map((m) => m.conditionId);
  const sizeOk = (sizes: (number | null | undefined)[]) => !sizes.every(fin) || Math.min(...(sizes as number[])) >= minTicket;
  const out: Basket[] = [];
  const asks = g.markets.map((m) => m.bestAsk);
  if (!incomplete && asks.every(fin) && sizeOk(g.markets.map((m) => m.askSize))) {
    const a = asks as number[];
    const sum = a.reduce((x, y) => x + y, 0);
    out.push({ side: "ask", sum, fees: g.markets.reduce((x, m, i) => x + feeOf(m, a[i]!), 0), gap: 1 - sum, ids });
  }
  const bids = g.markets.map((m) => m.bestBid);
  if (bids.every(fin) && sizeOk(g.markets.map((m) => m.bidSize))) {
    const b = bids as number[];
    const sum = b.reduce((x, y) => x + y, 0);
    out.push({ side: "bid", sum, fees: g.markets.reduce((x, m, i) => x + feeOf(m, b[i]!), 0), gap: sum - 1, ids });
  }
  return out;
}

/** Executable basket arbitrage: raw gap beyond tolerance + taker fees. magnitude = raw gap. */
function overround(g: StructuralGroup, o: Required<StructuralOptions>): StructuralItem | null {
  const cands: StructuralItem[] = baskets(g, o.minTicket)
    .filter((b) => b.gap > o.overroundTolerance + b.fees)
    .map((b) => ({ kind: "overround" as const, eventId: g.eventId, eventTitle: g.eventTitle, conditionIds: b.ids, magnitude: b.gap, net: b.gap - b.fees, side: b.side,
      description: b.side === "ask"
        ? `Σ asks across ${b.ids.length} mutually exclusive outcomes = ${pc(b.sum)} < 100¢: buying every YES locks in ${pc(b.gap)} (fees ≈ ${pc(b.fees)})`
        : `Σ bids across ${b.ids.length} mutually exclusive outcomes = ${pc(b.sum)} > 100¢: selling every YES locks in ${pc(b.gap)} (fees ≈ ${pc(b.fees)})` }));
  return cands.sort((a, b) => b.magnitude - a.magnitude)[0] ?? null;
}

/**
 * Mid-sum deviation (> siblingTolerance) that is also executable AFTER fees but did not clear the overround tolerance band.
 * Mid deviations alone are spread noise; nothing is emitted unless a basket nets positive after fees.
 */
function sibling(g: StructuralGroup, o: Required<StructuralOptions>): StructuralItem | null {
  const mids = g.markets.map((m) => m.mid);
  if (g.markets.length < 2 || !mids.every(fin)) return null;
  const sum = (mids as number[]).reduce((a, b) => a + b, 0);
  if (Math.abs(sum - 1) <= o.siblingTolerance) return null;
  const b = baskets(g, o.minTicket).find((x) => x.side === (sum > 1 ? "bid" : "ask") && x.gap > x.fees);
  if (!b) return null;
  return { kind: "sibling_inconsistency", eventId: g.eventId, eventTitle: g.eventTitle, conditionIds: b.ids, magnitude: Math.abs(sum - 1), net: b.gap - b.fees, side: b.side,
    description: `Mutually exclusive outcomes sum to ${pc(sum)} by mid; executable after fees (net ${pc(b.gap - b.fees)})` };
}

type Rung = { m: StructuralMarket; value: number; bid: number | null; ask: number | null };

function ladders(g: StructuralGroup, tol: number): StructuralItem[] {
  const out: StructuralItem[] = [];
  // decreasing: P falls as value rises ("above X", "continues through <date>"); otherwise P rises ("by <date>", "below X")
  const buckets = new Map<string, { kind: "date" | "threshold"; decreasing: boolean; rungs: Rung[] }>();
  for (const m of g.markets) {
    const bid = fin(m.bestBid) ? m.bestBid : null, ask = fin(m.bestAsk) ? m.bestAsk : null;
    if (bid === null && ask === null) continue;
    const ctx: LadderContext = { endDate: m.endDate, outcomes: m.outcomes, strictYear: true };
    const add = (id: string, kind: "date" | "threshold", decreasing: boolean, value: number) => {
      const b = buckets.get(id) ?? { kind, decreasing, rungs: [] };
      b.rungs.push({ m, value, bid, ask });
      buckets.set(id, b);
    };
    const d = dateKey(m.question, undefined, ctx);
    if (d) add(`d|${d.decreasing}|${d.stem}`, "date", d.decreasing, d.value);
    const t = thresholdKey(m.question, ctx);
    if (t) add(`t|${t.dir}|${t.stem}`, "threshold", t.dir === "above", t.value);
    else if (fin(m.threshold)) {
      const dir = directionOnly(m.question, ctx);
      if (dir) add(`t|${dir}|${norm(m.question).replace(/-?\d[\d,.]*/g, "<T>")}`, "threshold", dir === "above", m.threshold);
    }
  }
  for (const b of buckets.values()) {
    const rungs = b.rungs.sort((x, y) => x.value - y.value);
    for (let j = 1; j < rungs.length; j++) {
      const r = rungs[j]!;
      let best: { gap: number; ref: Rung } | null = null;
      for (let k = 0; k < j; k++) {
        const ref = rungs[k]!;
        if (ref.value === r.value) continue;
        // executable: sell the over-priced rung at its bid, buy the under-priced one at its ask
        const gap = b.decreasing ? (r.bid ?? NaN) - (ref.ask ?? NaN) : (ref.bid ?? NaN) - (r.ask ?? NaN);
        if (Number.isFinite(gap) && (!best || gap > best.gap)) best = { gap, ref };
      }
      if (!best || best.gap <= tol) continue;
      const [lo, hi] = [best.ref, r];
      const [sell, buy] = b.decreasing ? [hi, lo] : [lo, hi];
      const fees = feeOf(sell.m, sell.bid!) + feeOf(buy.m, buy.ask!);
      out.push({ kind: "monotonicity_violation", eventId: g.eventId, eventTitle: g.eventTitle, conditionIds: [lo.m.conditionId, hi.m.conditionId], magnitude: best.gap, net: best.gap - fees,
        description: b.kind === "date"
          ? b.decreasing
            ? `Later date priced above earlier for a "still true through" question: "${hi.m.question}" bid ${pc(hi.bid!)} > "${lo.m.question}" ask ${pc(lo.ask!)}`
            : `Later deadline priced below earlier: "${lo.m.question}" bid ${pc(lo.bid!)} > "${hi.m.question}" ask ${pc(hi.ask!)}`
          : b.decreasing
            ? `Higher threshold priced above lower: "${hi.m.question}" bid ${pc(hi.bid!)} > "${lo.m.question}" ask ${pc(lo.ask!)}`
            : `Higher "below" threshold priced under lower: "${lo.m.question}" bid ${pc(lo.bid!)} > "${hi.m.question}" ask ${pc(hi.ask!)}` });
    }
  }
  return out;
}

/** Run all checks over events. Items are sorted by magnitude (largest first). */
export function findStructural(groups: StructuralGroup[], opts: StructuralOptions = {}): StructuralItem[] {
  const o: Required<StructuralOptions> = { overroundTolerance: 0.01, monotonicTolerance: 0.01, siblingTolerance: 0.05, minTicket: 25, ...opts };
  const items: StructuralItem[] = [];
  for (const g of groups) {
    const ov = overround(g, o);
    if (ov) items.push(ov);
    else {
      const sb = sibling(g, o);
      if (sb) items.push(sb);
    }
    items.push(...ladders(g, o.monotonicTolerance));
  }
  return items.sort((a, b) => b.magnitude - a.magnitude);
}

export function structuralFlagsByMarket(items: StructuralItem[]): Map<string, StructuralKind[]> {
  const map = new Map<string, StructuralKind[]>();
  for (const it of items)
    for (const id of it.conditionIds) {
      const arr = map.get(id) ?? [];
      if (!arr.includes(it.kind)) arr.push(it.kind);
      map.set(id, arr);
    }
  return map;
}

// ───────────── mirrors (no polyscout equivalent) ─────────────

const normQ = (q: string) => q.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

export type MirrorItem = { conditionId: string; question: string; p: number };

/** Same normalized question listed twice with prices further apart than `threshold`. */
export function mirrorPairs(items: MirrorItem[], threshold = 0.03) {
  const out: { a: string; b: string; diff: number }[] = [];
  for (let i = 0; i < items.length; i++)
    for (let j = i + 1; j < items.length; j++) {
      const x = items[i]!, y = items[j]!;
      const diff = Math.abs(x.p - y.p);
      if (normQ(x.question) === normQ(y.question) && diff > threshold)
        out.push({ a: x.conditionId, b: y.conditionId, diff });
    }
  return out;
}

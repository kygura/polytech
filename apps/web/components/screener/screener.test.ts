import { formatQuery, parseQuery, type Filter } from "@pm/core";
import { describe, expect, it } from "vitest";
import { HEADER_H, minTableWidth, scrollTopForRow, virtualWindow } from "../virtual";
import { ageLabel, usdShort, buildColumns, cleanCols, COLUMNS, daysLeft, DEFAULT_COLS, pickCols } from "./columns";
import { acceptHint, applySuggestion, classify, defaultQuery, errorAt, hintContext, hintItems, nextSorts, pagedQuery, setSortInQuery } from "./dsl";
import { addChip, fmtBound, parseBound, removeChip, setBound, toggleValue, triGet, triSet } from "./filter";

const cls = (q: string) => classify(q, parseQuery(q).errors).filter((s) => s.cls !== "ws").map((s) => `${s.cls}${s.err ? "!" : ""}:${s.text}`);

describe("classify (DslHighlighter)", () => {
  it("never loses or reorders a character", () => {
    for (const q of ["", "  ", "liq:5k..50k  vol24h:<2k ", "cat:politics,-sports -is:muted foo \"a b\" sort:-prio,days", "sprd:1 -tag:x liq:", 'tag:"unterminated']) {
      expect(classify(q, parseQuery(q).errors).map((s) => s.text).join("")).toBe(q);
    }
  });
  it("key / op / val", () => {
    expect(cls("liq:5k..50k")).toEqual(["key:liq", "op::", "val:5k", "op:..", "val:50k"]);
    expect(cls("depth:>=1k")).toEqual(["key:depth", "op::", "op:>=", "val:1k"]);
  });
  it("neg on a leading - of a key, a list value or a sort field", () => {
    expect(cls("-is:muted")).toEqual(["neg:-", "key:is", "op::", "val:muted"]);
    expect(cls("cat:politics,-sports")).toEqual(["key:cat", "op::", "val:politics", "op:,", "neg:-", "val:sports"]);
    expect(cls("sort:-prio,days")).toEqual(["key:sort", "op::", "neg:-", "val:prio", "op:,", "val:days"]);
  });
  it("bare text is a word", () => {
    expect(cls("election")).toEqual(["word:election"]);
  });
  it("err marks every segment of the token parseQuery reported, and only that token", () => {
    expect(cls("liq:5k sprd:<0.04 foo")).toEqual(["key:liq", "op::", "val:5k", "word!:sprd", "op!::", "op!:<", "val!:0.04", "word:foo"]);
    expect(cls("liq:9..1")).toContain("val!:9");
    expect(cls("src:offcial")).toContain("val!:offcial");
  });
});

describe("hints", () => {
  const known = { tags: ["politics", "sports", "us elections"], categories: ["Crypto", "Politics"] };
  it("key prefix lists keys and aliases that start with it, in DSL order", () => {
    const ctx = hintContext("liq:5k vo", 9)!;
    expect(ctx.mode).toBe("key");
    expect(hintItems(ctx, known).map((h) => h.label)).toEqual(["vol24h"]);
    expect(hintItems(hintContext("s", 1), known).map((h) => h.label)).toEqual(["spread", "stale", "src", "struct", "sort"]);
  });
  it("opens only while typing a key", () => {
    expect(hintContext("", 0)).toBeNull();
    expect(hintContext("liq:5k ", 7)).toBeNull();
    expect(hintItems(hintContext("liq:", 4), known)).toEqual([]);
    expect(hintItems(hintContext("zzz", 3), known)).toEqual([]);
  });
  it("accepting a key inserts `key:` and puts the caret after it; reuses an existing colon", () => {
    const a = acceptHint("li", hintContext("li", 2)!, { label: "liq", insert: "liq", kind: "key" });
    expect(a).toEqual({ text: "liq:", caret: 4 });
    const b = acceptHint("li:5k", hintContext("li:5k", 2)!, { label: "liq", insert: "liq", kind: "key" });
    expect(b).toEqual({ text: "liq:5k", caret: 4 });
  });
  it("values come from enums and from loaded rows; the active comma segment is replaced", () => {
    expect(hintItems(hintContext("src:o", 5), known).map((h) => h.label)).toEqual(["official_data"]);
    expect(hintItems(hintContext("struct:", 7), known).map((h) => h.label)).toEqual(["overround", "monotonicity_violation", "sibling_inconsistency"]);
    expect(hintItems(hintContext("is:", 3), known).map((h) => h.label)).toEqual(["watch", "pinned", "muted"]);
    expect(hintItems(hintContext("cat:p", 5), known).map((h) => h.label)).toEqual(["Politics"]);
    const q = "tag:politics,sp -is:x";
    const ctx = hintContext(q, 14)!;
    const h = hintItems(ctx, known)[0]!;
    expect(h.label).toBe("sports");
    expect(acceptHint(q, ctx, h)).toEqual({ text: "tag:politics,sports -is:x", caret: 19 });
  });
  it("values with spaces are quoted and still parse", () => {
    const q = "tag:us";
    const ctx = hintContext(q, 6)!;
    const r = acceptHint(q, ctx, hintItems(ctx, known)[0]!);
    expect(r.text).toBe('tag:"us elections"');
    expect(parseQuery(r.text).filter.tags).toEqual(["us elections"]);
  });
});

describe("suggestion chip", () => {
  it("replaces a mistyped key and the query then parses", () => {
    const q = "liq:5k spred:<0.04"; // core suggests only within edit distance max(1, len/3): "sprd" gets none
    const [e] = parseQuery(q).errors;
    expect(e!.suggestion).toBe("spread");
    const r = applySuggestion(q, e!)!;
    expect(r.text).toBe("liq:5k spread:<0.04");
    expect(r.caret).toBe(13);
    expect(parseQuery(r.text).errors).toEqual([]);
  });
  it("replaces a mistyped enum value", () => {
    const q = "src:offcial_data";
    const [e] = parseQuery(q).errors;
    const r = applySuggestion(q, e!)!;
    expect(parseQuery(r.text).errors).toEqual([]);
  });
  it("errorAt finds the error under the caret (token end counts)", () => {
    const q = "liq:5k sprd:1";
    const errs = parseQuery(q).errors;
    expect(errorAt(errs, 3)).toBeUndefined();
    expect(errorAt(errs, 8)?.token).toBe("sprd:1");
    expect(errorAt(errs, q.length)?.token).toBe("sprd:1");
  });
  it("no suggestion -> nothing to apply", () => {
    const q = "liq:9..1";
    expect(applySuggestion(q, parseQuery(q).errors[0]!)).toBeNull();
  });
});

describe("sort in the query", () => {
  it("replaces every sort token, keeps the rest in order", () => {
    expect(setSortInQuery("liq:5k sort:-prio foo", [{ field: "daysToResolution", dir: "asc" }])).toBe("liq:5k foo sort:days");
    expect(setSortInQuery("sort:a sort:b x", [])).toBe("x");
  });
  it("writes secondary keys with short names and direction", () => {
    const q = setSortInQuery("", [{ field: "priority", dir: "desc" }, { field: "daysToResolution", dir: "asc" }]);
    expect(q).toBe("sort:-prio,days");
    expect(parseQuery(q).filter.sort).toEqual([{ field: "priority", dir: "desc" }, { field: "daysToResolution", dir: "asc" }]);
  });
  it("plain click replaces; shift-click appends or flips", () => {
    const cur = [{ field: "priority" as const, dir: "desc" as const }];
    expect(nextSorts(cur, { field: "spread", dir: "asc" }, false)).toEqual([{ field: "spread", dir: "asc" }]);
    expect(nextSorts(cur, { field: "spread", dir: "asc" }, true)).toEqual([...cur, { field: "spread", dir: "asc" }]);
    expect(nextSorts(cur, { field: "priority", dir: "asc" }, true)).toEqual([{ field: "priority", dir: "asc" }]);
    expect(nextSorts([], { field: "spread", dir: "asc" }, true)[0]).toEqual({ field: "priority", dir: "desc" }); // implicit default is the primary
  });
});

describe("paging and default query", () => {
  it("appends limit/offset; a query that sets its own is left alone", () => {
    expect(pagedQuery("liq:5k")).toEqual({ q: "liq:5k limit:200", paged: true });
    expect(pagedQuery("liq:5k", 400)).toEqual({ q: "liq:5k limit:200 offset:400", paged: true });
    expect(pagedQuery("", 200).q).toBe("limit:200 offset:200");
    expect(pagedQuery("liq:5k limit:50")).toEqual({ q: "liq:5k limit:50", paged: false });
    expect(parseQuery(pagedQuery("sort:-prio", 200).q).filter).toMatchObject({ limit: 200, offset: 200 });
  });
  it("Default = Settings → Filters", () => {
    const q = defaultQuery({ minDays: 2, maxDays: 120, minDepthUsd: 200 });
    expect(q).toBe("days:2..120 depth:>200 sort:-prio");
    expect(parseQuery(q).errors).toEqual([]);
  });
});

describe("FilterPanel <-> DSL round trip", () => {
  const rt = (f: Filter) => parseQuery(formatQuery(f));
  it("every panel edit survives format -> parse", () => {
    let f: Filter = parseQuery("sort:-prio foo").filter;
    f = setBound(f, "liquidity", "min", 2000)!;
    f = setBound(f, "liquidity", "max", 1_500_000)!;
    f = setBound(f, "spread", "max", 0.06)!;
    f = setBound(f, "price", "min", 0.05)!;
    f = toggleValue(f, "resolutionSource", "official_data");
    f = toggleValue(f, "resolutionSource", "media_report");
    f = toggleValue(f, "structural", "overround");
    f = triSet(f, "pinned", "yes");
    f = triSet(f, "muted", "no");
    f = triSet(f, "hasThesis", "yes");
    f = addChip(f, "tags", "politics");
    f = addChip(f, "tags", "-sports");
    f = addChip(f, "categories", "Crypto");
    const r = rt(f);
    expect(r.errors).toEqual([]);
    expect(r.filter).toEqual(f);
    expect(formatQuery(f)).toBe('liq:2k..1.5m spread:<=0.06 price:>=0.05 tag:politics,-sports cat:Crypto src:official_data,media_report struct:overround sort:-prio is:pinned -is:muted has:thesis foo');
  });
  it("the bar is the truth: bar text -> Filter -> panel reads the same values back", () => {
    const f = parseQuery("liq:5k..50k vol24h:<2k src:off is:pinned -has:thesis tag:a,-b").filter;
    expect(f.liquidity).toEqual({ min: 5000, max: 50000 });
    expect(f.volume24h).toEqual({ max: 2000 });
    expect(f.resolutionSource).toEqual(["official_data"]);
    expect(triGet(f, "pinned")).toBe("yes");
    expect(triGet(f, "hasThesis")).toBe("no");
    expect(triGet(f, "muted")).toBe("any");
    expect(fmtBound(f.liquidity!.min)).toBe("5k");
    expect(f.tags).toEqual(["a"]);
    expect(f.excludeTags).toEqual(["b"]);
  });
  it("clearing a bound, a list or a flag drops the key from the query", () => {
    let f = parseQuery("liq:5k..50k src:off is:pinned").filter;
    f = setBound(setBound(f, "liquidity", "min", undefined)!, "liquidity", "max", undefined)!;
    f = toggleValue(f, "resolutionSource", "official_data");
    f = triSet(f, "pinned", "any");
    expect(formatQuery(f)).toBe("");
    expect(addChip(parseQuery("tag:a").filter, "tags", "A")).toEqual(parseQuery("tag:a").filter); // duplicate (any case)
    expect(formatQuery(removeChip(parseQuery("tag:a,-b").filter, "tags", "b", true))).toBe("tag:a");
  });
  it("bound input: k/M suffixes, decimals, cents, percent; garbage and min>max rejected", () => {
    expect(parseBound("liquidity", "2k")).toBe(2000);
    expect(parseBound("liquidity", "1.5M")).toBe(1_500_000);
    expect(parseBound("spread", "0.06")).toBe(0.06);
    expect(parseBound("spread", "6¢")).toBe(0.06);
    expect(parseBound("spread", "1.5¢")).toBe(0.015);
    expect(parseBound("edge", "3%")).toBe(0.03);
    expect(parseBound("liquidity", " ")).toBeUndefined();
    expect(parseBound("liquidity", "abc")).toBeNull();
    expect(parseBound("liquidity", "5k..9k")).toBeNull();
    expect(setBound({ liquidity: { min: 10 } }, "liquidity", "max", 5)).toBeNull();
  });
  it("fmtBound is parseBound's inverse", () => {
    for (const v of [0.06, 0.5, 7, 999, 2000, 2500, 1_500_000, 1_234_567, 3e9]) expect(parseBound("liquidity", fmtBound(v))).toBe(v);
  });
});

describe("virtual window", () => {
  const o = { rowHeight: 26, overscan: 20, count: 1000, viewport: 520 };
  it("top of the list: no top spacer, window = visible + overscan", () => {
    const w = virtualWindow({ ...o, scrollTop: 0 });
    expect(w).toEqual({ start: 0, end: 20 + 1 + 20, padTop: 0, padBottom: (1000 - 41) * 26 });
  });
  it("middle: overscan on both sides and spacers add up to the hidden rows", () => {
    const w = virtualWindow({ ...o, scrollTop: 26 * 300 });
    expect(w.start).toBe(280);
    expect(w.end).toBe(300 + 21 + 20);
    expect(w.padTop).toBe(280 * 26);
    expect(w.padTop + (w.end - w.start) * 26 + w.padBottom).toBe(1000 * 26);
  });
  it("bottom and tiny lists clamp", () => {
    const b = virtualWindow({ ...o, scrollTop: 26 * 990 });
    expect(b.end).toBe(1000);
    expect(b.padBottom).toBe(0);
    expect(virtualWindow({ ...o, count: 5, scrollTop: 0 })).toEqual({ start: 0, end: 5, padTop: 0, padBottom: 0 });
    expect(virtualWindow({ ...o, count: 0, scrollTop: 500 })).toEqual({ start: 0, end: 0, padTop: 0, padBottom: 0 });
    expect(virtualWindow({ ...o, scrollTop: -40 }).start).toBe(0);
  });
  it("scrollTopForRow: null when visible, else the minimal scroll below the sticky header", () => {
    const v = { scrollTop: 260, viewport: 520, rowHeight: 26 };
    expect(scrollTopForRow({ ...v, index: 15 })).toBeNull(); // 390
    expect(scrollTopForRow({ ...v, index: 5 })).toBe(130); // above: its own top
    expect(scrollTopForRow({ ...v, index: 40 })).toBe(40 * 26 + 26 + HEADER_H - 520); // below: bottom edge flush
    expect(scrollTopForRow({ ...v, index: 10 })).toBeNull(); // exactly at the top edge, under the header line
  });
  it("min table width sums px widths, flex columns use their floor", () => {
    expect(minTableWidth([{ width: "64px" }, { minWidth: "280px" }, { width: "56px" }])).toBe(400);
  });
});

describe("columns", () => {
  it("default set is the DESIGN 13.5 order and all ids exist", () => {
    expect(DEFAULT_COLS).toEqual(["flags", "market", "yes", "no", "prob", "d24", "sprd", "liq", "vol24", "days", "prio", "edge"]);
    const ids = COLUMNS.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(DEFAULT_COLS.every((c) => ids.includes(c))).toBe(true);
    for (const x of ["bid", "ask", "d1c", "d5c", "exit", "cap", "holders", "hhi", "top5", "flow24", "ticket", "lasttrade", "end", "cat"]) expect(ids).toContain(x);
  });
  it("every non-flex column has a width (fixed layout)", () => {
    for (const c of COLUMNS) expect(Boolean(c.width) || c.id === "market").toBe(true);
    expect(buildColumns(["market", "mid"], { now: 0, researching: new Set() }).map((c) => c.id)).toEqual(["market", "mid"]);
  });
  it("pickCols: a saved view's columns beat localStorage, which beats the defaults", () => {
    const ls = JSON.stringify(["liq", "mid"]);
    expect(pickCols(["prio", "mid"], ls)).toEqual(["prio", "mid"]);
    expect(pickCols([], ls)).toEqual(["liq", "mid"]);
    expect(pickCols(undefined, "{bad")).toEqual(DEFAULT_COLS);
    expect(pickCols(undefined, null)).toEqual(DEFAULT_COLS);
  });
  it("cleanCols drops unknown and repeated ids, empty -> default", () => {
    expect(cleanCols(["mid", "nope", "mid", "liq"])).toEqual(["mid", "liq"]);
    expect(cleanCols([])).toEqual(DEFAULT_COLS);
    expect(cleanCols("x")).toEqual(DEFAULT_COLS);
    expect(cleanCols("flags,market,mid,sprd,liq,vol24,d2,days,stale,top1,src,prio,opp,edge".split(","))).toEqual(DEFAULT_COLS); // saved copy of the Rev 7 default moves on
  });
  it("compact usd fits the narrow cells", () => {
    expect(usdShort(950)).toBe("950");
    expect(usdShort(12000)).toBe("12.0k");
    expect(usdShort(250_000)).toBe("250k");
    expect(usdShort(1_234_567)).toBe("1.2m");
    expect(usdShort(-4200, true)).toBe("\u22124.2k");
    expect(usdShort(300, true)).toBe("+300");
    expect(usdShort(null)).toBe("—");
  });
  it("age and days labels", () => {
    expect(ageLabel(18.2)).toBe("18h");
    expect(ageLabel(96)).toBe("4d");
    expect(ageLabel(null)).toBe("—");
    const now = Date.parse("2026-10-20T00:00:00Z");
    expect(daysLeft("2026-10-30T00:00:00Z", now)).toBe(10);
    expect(daysLeft(null, now)).toBeNull();
  });
});

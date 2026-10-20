"use client";
import { formatQuery, parseQuery } from "@pm/core";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { DataTable } from "../DataTable";
import { EmptyState } from "../EmptyState";
import { ErrorBar } from "../ErrorBar";
import { Skeleton } from "../Skeleton";
import { STALE_MS } from "../StaleBanner";
import { CHORD_MS } from "../../hooks/useGlobalKeys";
import ui from "../ui.module.css";
import { buildColumns, cleanCols, colOfField, DEFAULT_COLS, pickCols, sortFieldOf } from "./columns";
import { DEFAULT_SORT, nextSorts, pagedQuery, setSortInQuery } from "./dsl";
import { FilterPanel } from "./FilterPanel";
import { ColsMenu, ConfirmSheet, NameSheet, ViewMenu } from "./menus";
import { QueryBar } from "./QueryBar";
import css from "./screener.module.css";
import type { SavedView, ScreenerRow } from "./types";

export type Initial = { text: string; viewId: string; rows: ScreenerRow[]; total: number };
type Props = { initial: Initial; views: SavedView[]; defaultText: string; now: number; lastSnapshotAt: number | null };
type Dialog = "save" | "rename" | "delete" | null;
type Popover = "view" | "cols" | null;

const store = {
  get: (k: string) => { try { return localStorage.getItem(k); } catch { return null; } },
  set: (k: string, v: string | null) => { try { if (v == null) localStorage.removeItem(k); else localStorage.setItem(k, v); } catch { /* storage blocked: preference just doesn't persist */ } },
};
const json = { "content-type": "application/json" };
const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));
async function call(url: string, init?: RequestInit) {
  const res = await fetch(url, init);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.errors?.[0]?.message ?? body.error ?? res.statusText);
  return body;
}
const canon = (q: string) => { const r = parseQuery(q); return r.errors.length ? q.trim() : formatQuery(r.filter); };
const BODY_H = "100dvh - 40px - 24px - 32px - 36px";

export function ScreenerView({ initial, views: initialViews, defaultText, now: serverNow, lastSnapshotAt }: Props) {
  const router = useRouter();
  const [text, setText] = useState(initial.text);
  const [viewId, setViewId] = useState(initial.viewId);
  const [views, setViews] = useState(initialViews);
  const [rows, setRows] = useState(initial.rows);
  const [total, setTotal] = useState(initial.total);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<{ msg: string; retry: boolean } | null>(null);
  const [reload, setReload] = useState(0);
  const [selected, setSelected] = useState<string | null>(null);
  const [cols, setCols] = useState(() => cleanCols(initialViews.find((v) => v.id === initial.viewId)?.columns));
  const [panel, setPanel] = useState(true);
  const [pop, setPop] = useState<Popover>(null);
  const [dialog, setDialog] = useState<Dialog>(null);
  const [now, setNow] = useState(serverNow);
  const [winEnd, setWinEnd] = useState(0);
  const [researching, setResearching] = useState<ReadonlySet<string>>(new Set());
  const fetched = useRef(initial.text); // query the rows belong to
  const moreBusy = useRef(false);
  const moreFailed = useRef(false);

  const parsed = useMemo(() => parseQuery(text), [text]);
  const valid = parsed.errors.length === 0;
  const filter = parsed.filter;
  const sorts = filter.sort?.length ? filter.sort : DEFAULT_SORT;
  const active = views.find((v) => v.id === viewId);
  const baseText = active ? active.query : defaultText;
  const dirty = canon(text) !== canon(baseText);
  const stale = lastSnapshotAt == null || now - lastSnapshotAt > STALE_MS;
  const selIdx = selected == null ? -1 : rows.findIndex((r) => r.conditionId === selected);

  // client-only state: clock (hydration-safe), saved panel + column prefs
  useEffect(() => {
    setNow(Date.now());
    if (store.get("pm.screener.panel") === "0") setPanel(false);
    setCols(pickCols(initialViews.find((v) => v.id === initial.viewId)?.columns, store.get(`pm.cols.${initial.viewId}`))); // a saved view's columns win over localStorage
  }, [initial.viewId]); // eslint-disable-line react-hooks/exhaustive-deps -- initialViews changes on every refresh; only a view switch resets columns

  // valid parse -> fetch after 250 ms (invalid parse fetches nothing; the last good rows stay, dimmed)
  useEffect(() => {
    if (!valid || text === fetched.current) return;
    const ac = new AbortController();
    const t = setTimeout(async () => {
      setLoading(true);
      try {
        const body = await call(`/api/markets?q=${encodeURIComponent(pagedQuery(text).q)}`, { signal: ac.signal });
        fetched.current = text;
        moreFailed.current = false;
        setRows(body.rows);
        setTotal(body.total);
        setError(null);
        setNow(Date.now());
      } catch (e) {
        if (!ac.signal.aborted) setError({ msg: `Load failed: ${msg(e)}`, retry: true });
      } finally {
        if (!ac.signal.aborted) setLoading(false);
      }
    }, 250);
    return () => { clearTimeout(t); ac.abort(); setLoading(false); };
  }, [text, valid, reload]);

  // URL is the truth: /markets?q=&view= (replaceState, so the server page is not re-run per keystroke)
  useEffect(() => {
    if (!valid) return;
    const t = setTimeout(() => {
      const u = new URL(location.href);
      u.searchParams.set("q", text);
      if (viewId === "default") u.searchParams.delete("view"); else u.searchParams.set("view", viewId);
      window.history.replaceState(null, "", u);
    }, 250);
    return () => clearTimeout(t);
  }, [text, valid, viewId]);

  // infinite pages: within 50 rows of the end (scroll window or selection) fetch `offset:` next
  const more = useCallback(async () => {
    const q = fetched.current, p = pagedQuery(q, rows.length);
    if (!p.paged || moreBusy.current || moreFailed.current || rows.length >= total) return;
    moreBusy.current = true;
    try {
      const body = await call(`/api/markets?q=${encodeURIComponent(p.q)}`);
      if (fetched.current !== q) return; // query changed while loading
      setRows((cur) => { const seen = new Set(cur.map((r) => r.conditionId)); return [...cur, ...(body.rows as ScreenerRow[]).filter((r) => !seen.has(r.conditionId))]; });
      setTotal(body.total);
    } catch (e) {
      moreFailed.current = true;
      setError({ msg: `Next page failed: ${msg(e)}`, retry: false });
    } finally { moreBusy.current = false; }
  }, [rows.length, total]);
  useEffect(() => {
    if (!loading && Math.max(winEnd, selIdx + 1) >= rows.length - 50) void more();
  }, [winEnd, selIdx, rows.length, loading, more]);

  // a row selected for 300 ms prefetches its detail
  useEffect(() => {
    if (!selected) return;
    const t = setTimeout(() => router.prefetch(`/markets/${selected}`), 300);
    return () => clearTimeout(t);
  }, [selected, router]);

  // ---- actions ----
  const patchRow = (id: string, p: Partial<ScreenerRow>) => setRows((rs) => rs.map((r) => (r.conditionId === id ? { ...r, ...p } : r)));
  async function flag(row: ScreenerRow, key: "pinned" | "muted") {
    patchRow(row.conditionId, { [key]: !row[key] });
    try { await call(`/api/markets/${row.conditionId}/flags`, { method: "POST", headers: json, body: JSON.stringify({ [key]: !row[key] }) }); }
    catch (e) { patchRow(row.conditionId, { [key]: row[key] }); setError({ msg: `${key === "pinned" ? "Pin" : "Mute"} failed: ${msg(e)}`, retry: false }); }
  }
  async function research(row: ScreenerRow) {
    setResearching((s) => new Set(s).add(row.conditionId));
    try { await call(`/api/markets/${row.conditionId}/research`, { method: "POST" }); }
    catch (e) { setError({ msg: `Research failed: ${msg(e)}`, retry: false }); }
    finally { setResearching((s) => { const n = new Set(s); n.delete(row.conditionId); return n; }); }
  }

  const applyCols = (v: SavedView | undefined, id: string) => {
    setCols(pickCols(v?.columns, store.get(`pm.cols.${id}`)));
  };
  const pick = (id: string) => {
    const v = views.find((x) => x.id === id);
    setViewId(v ? id : "default");
    setText(v ? v.query : defaultText);
    applyCols(v, v ? id : "default");
  };
  const changeCols = (next: string[] | null) => {
    const c = next ?? DEFAULT_COLS;
    setCols(c);
    store.set(`pm.cols.${viewId}`, next ? JSON.stringify(c) : null);
  };
  const togglePanel = () => { store.set("pm.screener.panel", panel ? "0" : "1"); setPanel(!panel); };

  const upsert = (v: SavedView) => setViews((vs) => [...vs.filter((x) => x.id !== v.id && x.name !== v.name), v].sort((a, b) => a.name.localeCompare(b.name)));
  const save = async (name: string) => {
    if (!valid) return "Fix the query errors first.";
    try {
      const v = await call("/api/views", { method: "POST", headers: json, body: JSON.stringify({ name, query: text, columns: cols }) });
      upsert(v);
      setViewId(v.id);
      return null;
    } catch (e) { return msg(e); }
  };
  const rename = async (name: string) => {
    if (!active || name === active.name) return null;
    if (views.some((v) => v.name === name)) return "A view with that name exists.";
    try {
      const v = await call("/api/views", { method: "POST", headers: json, body: JSON.stringify({ name, query: active.query, columns: active.columns }) });
      await call(`/api/views?id=${encodeURIComponent(active.id)}`, { method: "DELETE" });
      setViews((vs) => [...vs.filter((x) => x.id !== active.id && x.id !== v.id), v].sort((a, b) => a.name.localeCompare(b.name)));
      setViewId(v.id);
      return null;
    } catch (e) { return msg(e); }
  };
  const remove = async () => {
    if (!active) return;
    try {
      await call(`/api/views?id=${encodeURIComponent(active.id)}`, { method: "DELETE" });
      setViews((vs) => vs.filter((v) => v.id !== active.id));
      pick("default");
    } catch (e) { setError({ msg: `Delete failed: ${msg(e)}`, retry: false }); }
  };

  // view-scope keys (ignored in inputs): f c v p m r, Ctrl+S, Esc closes a popover first
  const key = useRef<(e: KeyboardEvent) => void>(() => {});
  const lastG = useRef(0);
  key.current = (e) => {
    if (document.querySelector("dialog[open]")) return;
    // `g <letter>` is the global go-to chord: its second key must not also fire a view key (g m would mute, g p pin)
    if (e.key === "g") lastG.current = Date.now();
    else if (Date.now() - lastG.current < CHORD_MS && !e.ctrlKey) { lastG.current = 0; return; }
    const row = rows.find((r) => r.conditionId === selected);
    if (e.ctrlKey && !e.metaKey && !e.altKey && e.key.toLowerCase() === "s") { setDialog("save"); setPop(null); e.preventDefault(); return; }
    if (e.key === "Escape") { if (pop) { setPop(null); e.stopPropagation(); } return; }
    const t = e.target as HTMLElement | null;
    if (e.metaKey || e.ctrlKey || e.altKey || (t && (t.tagName === "INPUT" || t.tagName === "SELECT" || t.tagName === "TEXTAREA" || t.isContentEditable))) return;
    if (e.key === "f") togglePanel();
    else if (e.key === "c") setPop((p) => (p === "cols" ? null : "cols"));
    else if (e.key === "v") { setPop((p) => (p === "view" ? null : "view")); e.preventDefault(); }
    else if (row && e.key === "p") void flag(row, "pinned");
    else if (row && e.key === "m") void flag(row, "muted");
    else if (row && e.key === "r") void research(row);
  };
  useEffect(() => {
    const h = (e: KeyboardEvent) => key.current(e);
    window.addEventListener("keydown", h, true); // capture: Esc must reach an open popover before the global blur
    return () => window.removeEventListener("keydown", h, true);
  }, []);

  const known = useMemo(() => {
    const count = (xs: Iterable<string | null>) => { const m = new Map<string, number>(); for (const x of xs) if (x) m.set(x, (m.get(x) ?? 0) + 1); return [...m].sort((a, b) => b[1] - a[1]).map(([k]) => k); };
    return { tags: count(rows.flatMap((r) => r.tags)), categories: count(rows.map((r) => r.category)) };
  }, [rows]);

  const columns = useMemo(() => buildColumns(cols, { now, researching }), [cols, now, researching]);
  const primary = sorts[0]!;
  const sortProp = { id: colOfField(primary.field, cols) ?? "", dir: primary.dir };
  const tableH = `calc(${BODY_H}${error ? " - 46px" : ""})`;
  const virtual = useMemo(() => ({ rowHeight: 26, overscan: 20, height: tableH, onWindow: (w: { end: number }) => setWinEnd(w.end) }), [tableH]);

  let table;
  if (rows.length) {
    table = (
      <div className={valid ? undefined : css.dim}>
        <DataTable key={fetched.current} columns={columns} rows={rows} rowKey={(r) => r.conditionId} sort={sortProp} selectedKey={selected} onSelect={setSelected}
          onOpen={(r) => router.push(`/markets/${r.conditionId}`)} muted={stale} label="markets" virtual={virtual} rowClass={(r) => (r.muted ? css.mutedRow : undefined)}
          onSort={(s, additive) => { const field = sortFieldOf(s.id); if (field) setText(setSortInQuery(text, nextSorts(sorts, { field, dir: s.dir }, !!additive))); }} />
      </div>
    );
  } else if (loading) table = <Skeleton rows={20} />;
  else if (!valid) table = <EmptyState text="Fix the query to load markets." />;
  else table = <EmptyState text="No markets match. Loosen a range or drop a tag." action={<button type="button" onClick={() => setText("")}>Clear query</button>} />;

  return (
    <div className={css.page}>
      <div className={css.barRow}>
        <ViewMenu views={views} activeId={active ? viewId : "default"} dirty={dirty} open={pop === "view"} setOpen={(o) => setPop(o ? "view" : null)}
          onPick={pick} onSaveAs={() => setDialog("save")} onRename={() => setDialog("rename")} onDelete={() => setDialog("delete")} onRevert={() => { setText(baseText); applyCols(active, active ? viewId : "default"); }} />
        <QueryBar value={text} onChange={setText} errors={parsed.errors} known={known} />
        <div className={css.meta}>
          <span className={css.count} aria-live="polite">{total} mkts{loading && <span className={ui.spinner} role="status" aria-label="loading" />}</span>
          <ColsMenu cols={cols} onChange={changeCols} open={pop === "cols"} setOpen={(o) => setPop(o ? "cols" : null)} />
        </div>
      </div>
      <div className={css.body}>
        {panel
          ? <FilterPanel filter={filter} disabled={!valid} known={known} onEdit={(f) => setText(formatQuery(f))} onClose={togglePanel} />
          : <button type="button" className={css.rail} onClick={togglePanel} aria-label="Show filters" title="Show filters (f)">Filters</button>}
        <div className={css.tableCol}>
          {error && <div className={css.errWrap}><ErrorBar message={error.msg} onRetry={error.retry ? () => { setError(null); setReload((n) => n + 1); } : undefined} onDismiss={() => setError(null)} /></div>}
          {table}
        </div>
      </div>
      {dialog === "save" && <NameSheet title="Save view" initial={active?.name ?? ""} action="Save" onClose={() => setDialog(null)} submit={save}
        hint={(n) => (views.some((v) => v.name === n) ? "Replaces the saved view of this name." : null)} />}
      {dialog === "rename" && active && <NameSheet title="Rename view" initial={active.name} action="Rename" onClose={() => setDialog(null)} submit={rename} />}
      {dialog === "delete" && active && <ConfirmSheet title={`Delete view "${active.name}"?`} action="Delete" onConfirm={() => void remove()} onClose={() => setDialog(null)} />}
    </div>
  );
}

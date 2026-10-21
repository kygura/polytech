"use client";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useCategories, useMarketList } from "../../../hooks/useMarketList";
import { daysLabel, emptyCopy, volLabel, type ListRow } from "../../terminal/marketList";
import { MarketTitle } from "../../pageParts";
import { Button, Chip, EmptyState, ErrorBar, Input, Panel, PricePill, Skeleton, Table } from "../../ui";
import ui from "../../ui.module.css";
import pg from "../../page.module.css";
import { chunks, lastText, TRIAGE_CAP, topByVolume, triageBadge, type Live, type QItem, type Run, type Verdict } from "./desk";
import { HowItWorks } from "./HowItWorks";
import { LiveRuns } from "./LiveRuns";
import { post, type Desk as DeskState } from "./useDesk";
import cx from "./desk.module.css";

type Confirm = { items: QItem[]; skip: QItem[] };

async function getJson<T>(url: string): Promise<T | null> {
  try { const r = await fetch(url, { cache: "no-store" }); return r.ok ? ((await r.json()) as T) : null; } catch { return null; }
}

function Spinner() { return <span className={ui.spinner} aria-hidden />; }

/** The Desk tab: pick markets, triage them cheaply, research the chosen ones through the tab's queue, watch the runs. */
export function Desk({ tabs, desk, researchDisabled }: { tabs: ReactNode; desk: DeskState; researchDisabled: boolean }) {
  const [query, setQuery] = useState("");
  const [cat, setCat] = useState<string | null>(null);
  const list = useMarketList(query, cat);
  const cats = useCategories();
  const rows = list.rows;
  const [sel, setSel] = useState<Map<string, QItem>>(new Map());
  const [verdicts, setVerdicts] = useState<Record<string, Verdict>>({});
  const [triaging, setTriaging] = useState<Set<string>>(new Set());
  const [fail, setFail] = useState<{ text: string; retry?: () => void } | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<Confirm | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [past, setPast] = useState<Record<string, Run>>({});
  const asked = useRef(new Set<string>());

  // Stored verdicts and the latest run for rows not asked about yet (no model calls). Results always merge: a superseded list still fills its rows.
  const idsKey = rows.map((r) => r.conditionId).join(",");
  useEffect(() => {
    const ids = idsKey ? idsKey.split(",").filter((id) => !asked.current.has(id)) : [];
    if (!ids.length) return;
    ids.forEach((id) => asked.current.add(id));
    for (const c of chunks(ids, 50)) {
      void getJson<Verdict[]>(`/api/research/triage?ids=${c.join(",")}`).then((v) => { if (v) setVerdicts((m) => ({ ...Object.fromEntries(v.map((x) => [x.conditionId, x])), ...m })); });
      void getJson<Live>(`/api/research/live?ids=${c.join(",")}`).then((l) => {
        if (!l) return;
        setPast((m) => { const o = { ...m }; for (const r of l.runs) if (!o[r.conditionId] || o[r.conditionId]!.startedAt < r.startedAt) o[r.conditionId] = r; return o; });
      });
    }
  }, [idsKey]);

  const lastBy = useMemo(() => {
    const o = { ...past };
    for (const r of desk.live.data?.runs ?? []) if (!o[r.conditionId] || o[r.conditionId]!.startedAt <= r.startedAt) o[r.conditionId] = r;
    return o;
  }, [past, desk.live.data]);

  const item = (r: Pick<ListRow, "conditionId" | "question">): QItem => ({ id: r.conditionId, question: r.question });
  const toggle = (r: ListRow) => setSel((s) => { const n = new Map(s); n.has(r.conditionId) ? n.delete(r.conditionId) : n.set(r.conditionId, item(r)); return n; });
  const allOn = rows.length > 0 && rows.every((r) => sel.has(r.conditionId));
  const someOn = rows.some((r) => sel.has(r.conditionId));
  const head = useRef<HTMLInputElement>(null);
  useEffect(() => { if (head.current) head.current.indeterminate = someOn && !allOn; }, [someOn, allOn]);
  const toggleAll = () => setSel((s) => { const n = new Map(s); rows.forEach((r) => (allOn ? n.delete(r.conditionId) : n.set(r.conditionId, item(r)))); return n; });
  const worth = rows.filter((r) => verdicts[r.conditionId]?.verdict === "research");

  const triage = async (ids: string[]) => {
    if (!ids.length || triaging.size) return;
    const take = ids.slice(0, TRIAGE_CAP);
    setFail(null); setNote(ids.length > TRIAGE_CAP ? `Triaged the first ${TRIAGE_CAP} of ${ids.length}. Run it again for the rest.` : null);
    setTriaging(new Set(take));
    const res = await post("/api/research/triage", { ids: take });
    setTriaging(new Set());
    if (res?.status !== 200 || !Array.isArray(res.j)) { setFail({ text: `Triage failed: ${res?.j?.error ?? (res ? `HTTP ${res.status}` : "network error")}`, retry: () => void triage(ids) }); return; }
    const v = res.j as Verdict[];
    setVerdicts((m) => ({ ...m, ...Object.fromEntries(v.map((x) => [x.conditionId, x])) }));
    const yes = v.filter((x) => x.verdict === "research").length;
    setNote((n) => `${n ? `${n} ` : ""}${yes} of ${v.length} worth researching.`);
  };

  const queueUp = (items: QItem[]) => {
    setConfirm(null);
    const n = desk.enqueue(items);
    setNote(n ? `Queued ${n} market${n === 1 ? "" : "s"}.${n < items.length ? ` ${items.length - n} already queued or running.` : ""}` : "Those markets are already queued or running.");
    if (n) setSel(new Map());
  };
  const research = () => {
    const items = [...sel.values()];
    if (!items.length || researchDisabled) return;
    const skip = items.filter((x) => verdicts[x.id]?.verdict === "skip");
    skip.length ? setConfirm({ items, skip }) : queueUp(items);
  };

  const selIds = [...sel.keys()];
  const busy = triaging.size > 0;
  return (
    <div className={pg.stack}>
      <div className="page-h">
        <h1>Research</h1>
        {tabs}
      </div>
      <p className={cx.intro}>Pick markets, let the cheap check say which are worth it, then research them. Each run finds a fair value; edge is fair value minus price.</p>
      {researchDisabled && <div className={`${ui.bar} ${ui.barWarn}`} role="status"><span className="warn">Research is disabled on this server. Triage works; research runs will not start.</span></div>}
      {fail && <ErrorBar message={fail.text} onRetry={fail.retry && (() => { setFail(null); fail.retry!(); })} onDismiss={() => setFail(null)} />}
      <div className={cx.cols}>
        <Panel title="Pick markets" label="pick markets" right={<>
          <span><span className="n">{sel.size}</span> selected</span>
          {sel.size > 0 && <Button size="sm" variant="ghost" onClick={() => setSel(new Map())}>Clear</Button>}
        </>}>
          <div className={cx.bar}>
            <span className={cx.search}><Input data-filter placeholder="Filter tracked markets" aria-label="filter markets" value={query} onChange={(e) => setQuery(e.target.value)} /></span>
            <span className={cx.chips} role="group" aria-label="categories">
              <Chip pressed={cat == null} onClick={() => setCat(null)}>All</Chip>
              {cats.map((c) => <Chip key={c.category} pressed={cat === c.category} onClick={() => setCat(cat === c.category ? null : c.category)}>{c.category}</Chip>)}
            </span>
          </div>
          <div className={cx.bar} role="toolbar" aria-label="desk actions">
            <Button size="sm" onClick={() => setSel((s) => { const n = new Map(s); worth.forEach((r) => n.set(r.conditionId, item(r))); return n; })} disabled={!worth.length} title="Add every visible market the check marked worth researching">
              Select worth researching ({worth.length})
            </Button>
            <Button size="sm" onClick={() => void triage(selIds)} disabled={!sel.size || busy} title={`Rules, then one cheap model call per market. Up to ${TRIAGE_CAP} per click.`}>
              {busy && <Spinner />}Triage selected{sel.size > TRIAGE_CAP ? ` (first ${TRIAGE_CAP})` : ""}
            </Button>
            <Button size="sm" onClick={() => void triage(topByVolume(rows).map((r) => r.conditionId))} disabled={!rows.length || busy} title={`The ${TRIAGE_CAP} highest-volume markets in this list`}>
              Triage top {TRIAGE_CAP}
            </Button>
            <span className={cx.spacer} />
            <Button variant="primary" onClick={research} disabled={!sel.size || researchDisabled} title={researchDisabled ? "Research is disabled on this server" : undefined}>Research selected ({sel.size})</Button>
          </div>
          {confirm && (
            <div className={cx.confirm} role="alert">
              <span>{confirm.skip.length} of {confirm.items.length} were judged not worth researching — research anyway?</span>
              <Button size="sm" variant="primary" onClick={() => queueUp(confirm.items)}>Research all {confirm.items.length}</Button>
              {confirm.skip.length < confirm.items.length && <Button size="sm" onClick={() => queueUp(confirm.items.filter((x) => !confirm.skip.includes(x)))}>Only the other {confirm.items.length - confirm.skip.length}</Button>}
              <Button size="sm" variant="ghost" onClick={() => setConfirm(null)}>Cancel</Button>
            </div>
          )}
          {note && <p className={`${cx.note} muted`} role="status">{note}</p>}
          {list.error ? <ErrorBar message="Could not load markets." onRetry={list.retry} />
            : list.loading && !rows.length ? <Skeleton rows={8} />
            : !rows.length ? <EmptyState text={`${emptyCopy(query, cat)} Add a market from the header search (/).`} />
            : (
              <Table className={cx.tbl} label="markets to research">
                <thead>
                  <tr>
                    <th className={cx.ck}><input ref={head} type="checkbox" aria-label="select all visible" checked={allOn} onChange={toggleAll} /></th>
                    <th>Market</th>
                    <th className="num" title="YES price now">YES</th>
                    <th className="num" title="days until it resolves">Days</th>
                    <th className="num">Vol 24h</th>
                    <th title="Rules plus a cheap model check. Hover or click a badge for the reason.">Triage</th>
                    <th title="Latest research run">Last result</th>
                  </tr>
                </thead>
                <tbody className={list.stale ? "muted" : undefined}>
                  {rows.map((r) => <Row key={r.conditionId} r={r} on={sel.has(r.conditionId)} onToggle={() => toggle(r)} v={verdicts[r.conditionId]} triaging={triaging.has(r.conditionId)}
                    open={open === r.conditionId} onOpen={() => setOpen(open === r.conditionId ? null : r.conditionId)} last={lastBy[r.conditionId]} desk={desk} />)}
                </tbody>
              </Table>
            )}
          <p className={cx.foot}>Showing {rows.length} of {list.total} tracked markets, biggest 24h volume first. Triage reuses a verdict for 24 hours.</p>
        </Panel>
        <div className={cx.side}>
          <HowItWorks />
          <LiveRuns desk={desk} empty="No research runs in the last 24 hours. Select markets and press Research selected." />
        </div>
      </div>
    </div>
  );
}

function Row({ r, on, onToggle, v, triaging, open, onOpen, last, desk }: {
  r: ListRow; on: boolean; onToggle: () => void; v: Verdict | undefined; triaging: boolean; open: boolean; onOpen: () => void; last: Run | undefined; desk: DeskState;
}) {
  const b = triageBadge(v);
  const id = r.conditionId;
  const state = desk.queue.some((x) => x.id === id) ? "Queued" : desk.starting.some((x) => x.id === id) ? "Starting…" : desk.notStarted.find((x) => x.id === id) ? "Not started" : null;
  return (
    <>
      <tr className="row2" data-on={on || undefined} onClick={onToggle}>
        <td className={cx.ck}><input type="checkbox" aria-label={`select ${r.question}`} checked={on} onChange={onToggle} onClick={(e) => e.stopPropagation()} /></td>
        <td className={cx.qcell}><MarketTitle id={id} question={r.question} category={r.category} newTab /></td>
        <td className="num"><PricePill outcome="YES" price={r.mid} /></td>
        <td className="num n">{daysLabel(r.endDate, Date.now())}</td>
        <td className="num n">{volLabel(r.vol24h) ?? "—"}</td>
        <td>
          {triaging ? <span className="muted ui"><Spinner /> checking</span>
            : b ? <button type="button" className={`${cx.tri} ${b.tone}`} title={b.why} aria-expanded={open} onClick={(e) => { e.stopPropagation(); onOpen(); }}>{b.text}</button>
            : <span className="muted">{"—"}</span>}
        </td>
        <td className={cx.last}>
          {state ? <span className={state === "Not started" ? "warn" : "muted"}>{state}</span>
            : last ? <span className={last.status === "failed" ? "down" : last.status === "running" ? cx.live : last.verdict ? undefined : "muted"}>{lastText(last)}</span>
            : <span className="muted">{"—"}</span>}
        </td>
      </tr>
      {open && v && (
        <tr className={cx.whyRow}><td colSpan={7} className={cx.why}>
          {v.verdict === "research" ? `Worth researching (${v.score.toFixed(2)}): ${v.reason}` : v.failedRules.length ? `Skipped by the rules:\n${b!.why}` : `Skipped by the check: ${v.reason}`}
          {v.model && <span className="muted"> · {v.model}</span>}
        </td></tr>
      )}
    </>
  );
}

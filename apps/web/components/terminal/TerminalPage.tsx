"use client";
// /trade and /trade/[id] (DESIGN 13.4): the one market page. Selection swaps panes in place; the trade layout keeps this mounted.
import { notFound, useParams, useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { createPortal } from "react-dom";
import { useMarketFeed, type MarketFeed } from "../../hooks/useMarketFeed";
import { useCategories, useMarketList } from "../../hooks/useMarketList";
import type { OrderPhase } from "../../hooks/useOrderFlow";
import { chordPending, inInput } from "../../hooks/useGlobalKeys";
import { usePoll } from "../../hooks/usePoll";
import { useWallet } from "../../hooks/useWallet";
import { DEFAULT_RANGE, parseRange, type Range } from "../../lib/history";
import type { PublicMarketDetail } from "../../lib/public";
import { ActionBar, startResearch } from "../ActionBar";
import type { Detail } from "../detail";
import { ProbChart, type ChartOrder } from "../market/ProbChart";
import { Panel } from "../ui";
import { useStatusSlot } from "../ShellContext";
import { type TokenInfo } from "./AccountPane";
import { BookLadder } from "./BookLadder";
import { BottomTabs, isTab, TAB_KEY, type BottomTab } from "./BottomTabs";
import { feedDisplay, forOutcome, type Outcome, type TradeSide } from "./book";
import { FeedBadge } from "./FeedBadge";
import { KeyLegend } from "./KeyLegend";
import { isMarketId } from "./marketList";
import { KeyStats, MarketHeader, type HeaderFlags, type HeaderMeta } from "./MarketHeader";
import { MarketList } from "./MarketList";
import { canSwitch, sellable } from "./rules";
import { TerminalTicket, type TicketHandle } from "./TerminalTicket";
import { DEFAULT_TICK, DISCLAIMER } from "./ticket";
import { TradeTape } from "./TradeTape";
import css from "./terminal.module.css";

const LOCK_NOTE = "Finish or check the current order first";
const LAST_KEY = "pm.trade.last";
const store = {
  get: (k: string) => { try { return localStorage.getItem(k); } catch { return null; } },
  set: (k: string, v: string) => { try { localStorage.setItem(k, v); } catch { /* storage is optional */ } },
};

export function TerminalPage() {
  const router = useRouter();
  const params = useParams<{ id?: string }>();
  if (params.id != null && !isMarketId(params.id)) notFound(); // /trade/autonomy and friends: a 404, not a feed request
  const w = useWallet(), clob = w.clob;
  const slot = useStatusSlot();

  const [picked, setPicked] = useState<string | null>(params.id ?? null); // condition ids are hex: no decoding needed
  const [query, setQuery] = useState("");
  const [cat, setCat] = useState<string | null>(null);
  const [cursorId, setCursorId] = useState<string | null>(null);
  const [drawer, setDrawer] = useState(false);
  const [side, setSide] = useState<TradeSide>("BUY");
  const [outcome, setOutcome] = useState<Outcome>("YES");
  const [tab, setTab] = useState<BottomTab>("research");
  const [expanded, setExpanded] = useState(false);
  const [range, setRange] = useState<Range>(DEFAULT_RANGE);
  const [ladderCursor, setLadderCursor] = useState(-1);
  const [pick, setPick] = useState<{ price: number; n: number } | null>(null);
  const [order, setOrder] = useState<{ phase: OrderPhase["s"]; locked: boolean }>({ phase: "idle", locked: false });
  const [lockNote, setLockNote] = useState(false);
  const switchable = canSwitch(order.phase);
  const blocked = () => setLockNote(true); // every blocked switch or navigation shows the same note
  const searchRef = useRef<HTMLInputElement>(null), ladderRef = useRef<HTMLTableElement>(null), ticket = useRef<TicketHandle>(null);

  // Per-viewer conveniences: the chosen bottom tab and the chart range (?range=).
  useEffect(() => {
    const t = store.get(TAB_KEY);
    if (isTab(t)) setTab(t);
    const r = parseRange(new URLSearchParams(location.search).get("range") ?? undefined);
    if (r) setRange(r);
  }, []);
  const chooseTab = useCallback((t: BottomTab) => { setTab(t); store.set(TAB_KEY, t); }, []);
  const chooseRange = useCallback((r: Range) => {
    setRange(r);
    const u = new URL(location.href);
    r === DEFAULT_RANGE ? u.searchParams.delete("range") : u.searchParams.set("range", r);
    history.replaceState(null, "", u);
  }, []);

  const list = useMarketList(query, cat);
  const cats = useCategories();
  const rows = list.rows;
  const id = picked;
  const det = usePoll<PublicMarketDetail>(id ? `/api/public/markets/${encodeURIComponent(id)}` : null, 60_000);
  const feed = useMarketFeed(id);
  const detail = det.data?.market.conditionId === id ? det.data : null;
  // The research tab's payload: the operator detail (thesis sizing, evidence, agents, metrics, rules). 10 s while a pod runs.
  const [fast, setFast] = useState(false);
  const full = usePoll<Detail>(id ? `/api/markets/${encodeURIComponent(id)}` : null, fast ? 10_000 : 60_000);
  const research = full.data?.market.conditionId === id ? full.data : null;
  const running = research?.pod?.status === "running" ? research.pod : null;
  useEffect(() => setFast(!!running), [running]);
  const changed = useCallback(() => { det.refresh(); full.refresh(); }, [det.refresh, full.refresh]); // eslint-disable-line react-hooks/exhaustive-deps

  // Keep the previous market on screen, dimmed, until the new feed's first payload (no flash of empty panes).
  const shown = useRef<{ detail: PublicMarketDetail | null; feed: MarketFeed } | null>(null);
  if (feed.data) shown.current = { detail, feed: feed.data };
  const dim = feed.status === "loading" && shown.current != null; // an error shows the error state, not the previous market
  const viewFeed = feed.data ?? (dim ? shown.current!.feed : null);
  const viewDetail = feed.data ? detail : dim ? shown.current!.detail : detail;
  const book = viewFeed ? forOutcome(viewFeed, outcome) : null;
  const row = rows.find((r) => r.conditionId === id) ?? null;
  // YES display price: the midpoint, or the last trade when the book is wider than 10¢ (a 1¢ bid / 82¢ ask is not a 42¢ price).
  const yes = viewFeed ? feedDisplay(viewFeed) ?? viewDetail?.snapshot?.mid ?? null : viewDetail?.snapshot?.mid ?? row?.mid ?? null;

  // tokenId -> market, for every market loaded this session (positions and orders carry only a token id).
  const tokens = useRef(new Map<string, TokenInfo>()).current;
  if (detail) {
    const m = detail.market;
    if (m.yesTokenId) tokens.set(m.yesTokenId, { conditionId: m.conditionId, question: m.question, outcome: "YES" });
    if (m.noTokenId) tokens.set(m.noTokenId, { conditionId: m.conditionId, question: m.question, outcome: "NO" });
  }
  const tokenId = detail ? (outcome === "YES" ? detail.market.yesTokenId : detail.market.noTokenId) : null;
  const held = sellable(tokenId ? clob.positions[tokenId] ?? 0 : 0, clob.orders, tokenId);
  const ownOrders = tokenId ? clob.orders.filter((o) => o.tokenId === tokenId) : [];
  const chartOrders = detail ? clob.orders.flatMap((o): ChartOrder[] => {
    const out: Outcome | null = o.tokenId === detail.market.yesTokenId ? "YES" : o.tokenId === detail.market.noTokenId ? "NO" : null;
    return out ? [{ price: o.price, side: o.side, outcome: out, shares: o.shares - o.filled }] : [];
  }) : [];
  const mark = (t: string) => {
    const info = tokens.get(t);
    if (!info) return null;
    const y = info.conditionId === id && yes != null ? yes : rows.find((r) => r.conditionId === info.conditionId)?.mid ?? null;
    return y == null ? null : info.outcome === "YES" ? y : 1 - y;
  };

  // Switching drops the ticket's order view: blocked while the wallet prompt is open or an outcome is being looked up.
  const select = (next: string) => {
    if (!switchable) { blocked(); return; }
    setLockNote(false);
    setPicked(next);
    setCursorId(next);
    setDrawer(false);
    setLadderCursor(-1);
    store.set(LAST_KEY, next);
    router.replace(`/trade/${next}${location.search}`, { scroll: false });
  };
  useEffect(() => { if (switchable) setLockNote(false); }, [switchable]);

  // /trade with no id: the last visited market, else the first row (pinned and watched first), latched once.
  const first = rows[0]?.conditionId;
  useEffect(() => {
    if (picked != null || !first) return;
    const last = store.get(LAST_KEY);
    const at = last && isMarketId(last) ? last : first;
    setPicked(at);
    router.replace(`/trade/${at}${location.search}`, { scroll: false });
  }, [picked, first, router]);
  useEffect(() => { if (picked) store.set(LAST_KEY, picked); }, [picked]);
  // URL changed from outside (g t or the logo -> /trade, a typed /trade/<id>): keep the market, or switch only when allowed.
  useEffect(() => {
    const at = params.id ?? null;
    if (!picked || at === picked) return;
    if (at && switchable) { setPicked(at); setCursorId(at); return; }
    if (!switchable) blocked();
    router.replace(`/trade/${picked}${location.search}`, { scroll: false });
  }, [params.id]); // eslint-disable-line react-hooks/exhaustive-deps -- only a URL change triggers this

  const moveCursor = useCallback((d: number) => {
    if (!rows.length) return;
    if (!switchable) { blocked(); return; }
    const i = rows.findIndex((r) => r.conditionId === (cursorId ?? id));
    const n = rows[Math.min(rows.length - 1, Math.max(0, (i < 0 ? 0 : i + d)))]!.conditionId;
    setCursorId(n);
    document.getElementById(`mrow-${n}`)?.scrollIntoView({ block: "nearest" });
  }, [rows, cursorId, id, switchable]);

  const focusLimit = () => requestAnimationFrame(() => ticket.current?.focusLimit());
  const pickSide = (s: TradeSide) => { if (order.locked || (s === "SELL" && !(held > 0))) return; setSide(s); };
  const pickOutcome = (o: Outcome) => { if (!order.locked) setOutcome(o); };

  // Page keys (DESIGN 13.7), mounted only on /trade. The Shell keeps t, ?, /, Esc blur and the g chords; the key that completes a chord is not a page key.
  // p / m / r / ⇧S are the ActionBar's, [ ] f the chart's. One listener; it calls the latest handler.
  const onKey = useRef<(e: globalThis.KeyboardEvent) => void>(() => {});
  onKey.current = (e) => {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.key === "Escape") { setDrawer(false); return; }
    if (inInput(e) || e.defaultPrevented || chordPending() || document.querySelector("dialog[open]")) return;
    const k = e.key === "T" ? "T" : e.key.toLowerCase();
    const tabs: BottomTab[] = ["research", "positions", "orders", "rules"];
    const act: Record<string, () => void> = {
      j: () => moveCursor(1), k: () => moveCursor(-1),
      b: () => { pickSide("BUY"); focusLimit(); }, s: () => { pickSide("SELL"); focusLimit(); },
      y: () => { pickOutcome("YES"); focusLimit(); }, n: () => { pickOutcome("NO"); focusLimit(); },
      l: () => (ladderRef.current?.querySelector('[tabindex="0"]') as HTMLElement | null)?.focus(),
      T: () => focusLimit(), e: () => setExpanded((x) => !x),
      "1": () => chooseTab(tabs[0]!), "2": () => chooseTab(tabs[1]!), "3": () => chooseTab(tabs[2]!), "4": () => chooseTab(tabs[3]!),
      enter: () => { if (document.activeElement === document.body && cursorId) select(cursorId); },
    };
    const f = act[k];
    if (!f || (e.shiftKey && k !== "T")) return;
    if (k !== "enter") e.preventDefault();
    f();
  };
  useEffect(() => {
    const h = (e: globalThis.KeyboardEvent) => onKey.current(e);
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, []);

  // The list's own filter box: arrows move the cursor, Enter selects.
  const searchKeys = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") { e.preventDefault(); moveCursor(e.key === "ArrowDown" ? 1 : -1); }
    else if (e.key === "Enter") { e.preventDefault(); const c = cursorId && rows.some((r) => r.conditionId === cursorId) ? cursorId : rows[0]?.conditionId; if (c) { select(c); searchRef.current?.blur(); } }
  };

  const now = Date.now();
  const viewKey = `${viewFeed?.tokenId ?? ""}|${outcome}`;
  const notFoundMarket = det.status === 404;
  const marketMeta = (research?.market ?? viewDetail?.market ?? null);
  const meta: HeaderMeta | null = marketMeta ? { conditionId: marketMeta.conditionId, question: marketMeta.question, category: marketMeta.category, endDate: marketMeta.endDate, daysLeft: marketMeta.daysLeft, feeRate: viewDetail?.market.feeRate ?? research?.market.feeRate ?? null }
    : row ? { conditionId: row.conditionId, question: row.question, category: row.category, endDate: row.endDate ? Date.parse(row.endDate) : null, daysLeft: row.endDate ? (Date.parse(row.endDate) - now) / 86_400_000 : 0 } : null;
  const l = research?.latest;
  const flags: HeaderFlags | null = l ? { structural: l.structural, contrarian: !!l.opportunity?.contrarian, lastTradeTs: l.lastTradeTs, detail: (research?.screen?.structural ?? null) as HeaderFlags["detail"] } : null;
  const tick = viewFeed?.tickSize ?? research?.market.tickSize ?? null;
  const thesis = research?.thesis ?? null;
  const pHat = thesis ? thesis.pYes ?? (thesis.side === "YES" ? thesis.pHat : 1 - thesis.pHat) : null;
  const researchDisabled = detail?.research === "disabled" || viewDetail?.research === "disabled";
  const snap = viewDetail?.snapshot;

  const feedAt = feed.data?.at ?? shown.current?.feed.at ?? null;
  return (
    <div className={`${css.grid} ${expanded ? css.x : ""}`} data-workspace>
      {slot && createPortal(<><KeyLegend /><span className={css.feedSeg}><FeedBadge status={feed.status} source={feed.source} at={feedAt} now={now} /></span></>, slot)}
      <div className={`${css.backdrop} ${drawer ? css.open : ""}`} onClick={() => setDrawer(false)} aria-hidden />
      <MarketList rows={rows} total={list.total} loading={list.loading} error={list.error} onRetry={list.retry} now={now} cats={cats} cat={cat} onCat={setCat}
        selectedId={id} cursorId={cursorId} onSelect={select} open={drawer} live={id ? { id, price: yes } : null} note={lockNote ? LOCK_NOTE : null}
        query={query} onQuery={setQuery} searchRef={searchRef} onSearchKey={searchKeys} />

      <Panel label="market" className={`${css.centerp} ${dim ? css.dimmed : ""}`}>
        <div className={css.centerIn}>
          <button type="button" className={css.listBtn} onClick={() => { setDrawer(true); requestAnimationFrame(() => searchRef.current?.focus()); }} aria-label="Show market list">{"☰"} Markets</button>
          <MarketHeader meta={meta} tick={tick} yes={yes} outcome={outcome} onOutcome={pickOutcome} notFound={notFoundMarket} flags={flags} now={now}
            actions={id && research ? <ActionBar conditionId={id} pinned={research.market.pinned} muted={research.market.muted} running={running} question={research.market.question} researchDisabled={researchDisabled} onChanged={changed} /> : null} />
          <KeyStats book={book} vol24h={snap?.vol24h ?? row?.vol24h ?? null} oi={snap?.oi ?? null} depth5c={snap?.depth5cUsd ?? null} />
          <div className={css.chartBox}>
            {id ? <ProbChart conditionId={id} liveMid={yes} pHat={pHat} markers={research?.thesisMarkers.map((m) => ({ ts: m.createdAt, pHat: m.pHat, side: m.side })) ?? []}
              ownOrders={chartOrders} outcome={outcome} tick={tick ?? DEFAULT_TICK} range={range} onRangeChange={chooseRange} /> : null}
          </div>
        </div>
      </Panel>

      <BottomTabs tab={tab} onTab={chooseTab} expanded={expanded} onExpand={() => setExpanded((x) => !x)} id={id} detail={research} detailError={full.error != null && !research} onRetry={full.refresh}
        now={now} clob={clob} connected={w.status === "connected"} tokens={tokens} mark={mark} tick={tick ?? DEFAULT_TICK} yes={yes} researchDisabled={researchDisabled}
        onResearch={() => { if (id) void startResearch(id).then(changed); }} />

      <div className={dim ? css.dimmed : undefined} style={{ display: "contents" }}>
        <BookLadder ref={ladderRef} book={book} status={feed.status} noBook={feed.noBook} outcome={outcome} ownOrders={ownOrders}
          viewKey={viewKey} cursor={ladderCursor} onCursor={setLadderCursor} onPick={(p) => setPick((x) => ({ price: p, n: (x?.n ?? 0) + 1 }))} />
      </div>

      <div className={css.col4}>
        <TerminalTicket ref={ticket} marketId={id} detail={detail} feed={feed.data} noBook={feed.noBook} side={side} outcome={outcome}
          onSide={pickSide} onOutcome={pickOutcome} held={held} pick={pick} wallet={w} onState={setOrder} />
        <div className={dim ? css.dimmed : undefined} style={{ display: "contents" }}><TradeTape feed={viewFeed} status={feed.status} viewKey={viewFeed?.tokenId ?? ""} /></div>
      </div>

      <p className={`${css.disc} ${css.pageDisc}`}>{DISCLAIMER}</p>
    </div>
  );
}

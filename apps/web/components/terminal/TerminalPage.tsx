"use client";
// /trade and /trade/[id] (DESIGN 11): one screen, selection swaps panes in place. Rendered by the (terminal) layout, so it never remounts.
import { useParams, useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { useMarketFeed, type MarketFeed } from "../../hooks/useMarketFeed";
import type { OrderPhase } from "../../hooks/useOrderFlow";
import { inInput } from "../../hooks/useGlobalKeys";
import { usePoll } from "../../hooks/usePoll";
import { useWallet } from "../../hooks/useWallet";
import type { PublicMarketDetail, PublicWatchlist } from "../../lib/public";
import type { ScreenerRow } from "../screener/types";
import { terminalNav } from "../../lib/terminalPath";
import { DISCLAIMER } from "../public/PublicShell";
import { DEFAULT_TICK } from "../public/ticket";
import { AccountPane, type AccountTab, type TokenInfo } from "./AccountPane";
import { BookLadder } from "./BookLadder";
import { forOutcome, type Outcome, type TradeSide } from "./book";
import { KeyStats, MarketHero, PriceChart } from "./ChartPane";
import { KeyLegend } from "./KeyLegend";
import { MarketList } from "./MarketList";
import { allQuery, fromScreener, fromWatch, matchWatch, type ListMode, type SortKey } from "./marketQuery";
import { canSwitch, sellable } from "./rules";
import { TerminalTicket, type TicketHandle } from "./TerminalTicket";
import { TopBar } from "./TopBar";
import { TradeTape } from "./TradeTape";
import css from "./terminal.module.css";

const storedTheme = () => { try { const t = localStorage.theme; return t === "light" || t === "dark" || t === "system"; } catch { return false; } };
const LOCK_NOTE = "Finish or check the current order first";

export function TerminalPage({ fontClass }: { fontClass: string }) {
  const router = useRouter();
  const params = useParams<{ id?: string }>();
  const w = useWallet(), clob = w.clob;
  const wl = usePoll<PublicWatchlist>("/api/public/watchlist", 60_000);

  const [picked, setPicked] = useState<string | null>(params.id ?? null); // condition ids are hex: no decoding needed
  const [query, setQuery] = useState("");
  const [cat, setCat] = useState<string | null>(null);
  const [modePick, setMode] = useState<ListMode | null>(null);
  const [sort, setSort] = useState<SortKey>("-vol24h");
  const [debounced, setDebounced] = useState("");
  const [cursorId, setCursorId] = useState<string | null>(null);
  const [drawer, setDrawer] = useState(false);
  const [side, setSide] = useState<TradeSide>("BUY");
  const [outcome, setOutcome] = useState<Outcome>("YES");
  const [tab, setTab] = useState<AccountTab>("positions");
  const [ladderCursor, setLadderCursor] = useState(-1);
  const [pick, setPick] = useState<{ price: number; n: number } | null>(null);
  const [order, setOrder] = useState<{ phase: OrderPhase["s"]; locked: boolean }>({ phase: "idle", locked: false });
  const [lockNote, setLockNote] = useState(false);
  const switchable = canSwitch(order.phase);
  const blocked = () => setLockNote(true); // every blocked switch or navigation shows the same note
  useEffect(() => { terminalNav.locked = !switchable; terminalNav.onBlocked = blocked; }, [switchable]); // PublicShell g-keys read it
  const searchRef = useRef<HTMLInputElement>(null), ladderRef = useRef<HTMLTableElement>(null), ticket = useRef<TicketHandle>(null);

  // Dark by default on the terminal when the visitor never chose a theme (the root script leaves it dark here too).
  // Leaving the terminal restores the normal resolution (prefers-color-scheme) for the next route.
  useEffect(() => {
    if (!storedTheme()) document.documentElement.dataset.theme = "dark";
    return () => {
      terminalNav.locked = false;
      terminalNav.onBlocked = () => {};
      if (!storedTheme() && matchMedia("(prefers-color-scheme: light)").matches) document.documentElement.dataset.theme = "light";
    };
  }, []);

  const all = wl.data?.rows ?? [];
  // No choice yet: the watchlist when it has rows, else every open market (a fresh instance has no shortlist).
  const mode: ListMode = modePick ?? (wl.data && !all.length ? "all" : "watch");
  useEffect(() => { const t = setTimeout(() => setDebounced(query), 250); return () => clearTimeout(t); }, [query]);
  const q = mode === "all" ? allQuery(debounced, sort) : null;
  const am = usePoll<{ rows: ScreenerRow[]; total: number }>(q == null ? null : `/api/markets?q=${encodeURIComponent(q)}`, 60_000);
  const id = picked;
  const det = usePoll<PublicMarketDetail>(id ? `/api/public/markets/${encodeURIComponent(id)}` : null, 60_000);
  const feed = useMarketFeed(id);
  const detail = det.data?.market.conditionId === id ? det.data : null;

  // Keep the previous market on screen, dimmed, until the new feed's first payload (no flash of empty panes).
  const shown = useRef<{ detail: PublicMarketDetail | null; feed: MarketFeed } | null>(null);
  if (feed.data) shown.current = { detail, feed: feed.data };
  const dim = feed.status === "loading" && shown.current != null; // an error shows the error state, not the previous market
  const viewFeed = feed.data ?? (dim ? shown.current!.feed : null);
  const viewDetail = feed.data ? detail : dim ? shown.current!.detail : detail;
  const book = viewFeed ? forOutcome(viewFeed, outcome) : null;

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
  const mark = (t: string) => {
    const info = tokens.get(t);
    if (!info) return null;
    const yes = info.conditionId === id && feed.data?.mid != null ? feed.data.mid : rows.find((r) => r.conditionId === info.conditionId)?.yes ?? null;
    return yes == null ? null : info.outcome === "YES" ? yes : 1 - yes;
  };

  const cats = useMemo(() => [...new Set(all.map((r) => r.category).filter((c): c is string => !!c))].sort(), [all]);
  const now = Date.now();
  const rows = useMemo(() => mode === "watch"
    ? all.filter((r) => matchWatch(r, query, cat)).map(fromWatch)
    : (am.data?.rows ?? []).map((r) => fromScreener(r, now)),
  [mode, all, cat, query, am.data]); // eslint-disable-line react-hooks/exhaustive-deps

  // Switching drops the ticket's order view: blocked while the wallet prompt is open or an outcome is being looked up.
  const select = (next: string) => {
    if (!switchable) { blocked(); return; }
    setLockNote(false);
    setPicked(next);
    setCursorId(next);
    setDrawer(false);
    setLadderCursor(-1);
    router.replace(`/trade/${next}`, { scroll: false });
  };
  useEffect(() => { if (switchable) setLockNote(false); }, [switchable]);

  // /trade with no id: latch the first row once (a later watchlist reorder never switches the market silently).
  const first = rows[0]?.conditionId;
  useEffect(() => {
    if (picked != null || !first) return;
    setPicked(first);
    router.replace(`/trade/${first}`, { scroll: false });
  }, [picked, first, router]);
  // URL changed from outside (g w or the logo -> /trade, a typed /trade/<id>): keep the market, or switch only when allowed.
  useEffect(() => {
    const at = params.id ?? null;
    if (!picked || at === picked) return;
    if (at && switchable) { setPicked(at); setCursorId(at); return; }
    if (!switchable) blocked();
    router.replace(`/trade/${picked}`, { scroll: false });
  }, [params.id]); // only a URL change triggers this

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

  // Terminal keys (DESIGN 11.5). PublicShell keeps t, ?, Esc blur, g w / g a. One listener; it calls the latest handler.
  const onKey = useRef<(e: globalThis.KeyboardEvent) => void>(() => {});
  onKey.current = (e) => {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.key === "Escape") { setDrawer(false); return; }
    if (inInput(e)) return;
    const k = e.key === "T" ? "T" : e.key.toLowerCase();
    const act: Record<string, () => void> = {
      "/": () => { setDrawer(true); requestAnimationFrame(() => searchRef.current?.focus()); },
      j: () => moveCursor(1), k: () => moveCursor(-1),
      b: () => { pickSide("BUY"); focusLimit(); }, s: () => { pickSide("SELL"); focusLimit(); },
      y: () => { pickOutcome("YES"); focusLimit(); }, n: () => { pickOutcome("NO"); focusLimit(); },
      l: () => (ladderRef.current?.querySelector('[tabindex="0"]') as HTMLElement | null)?.focus(),
      T: () => focusLimit(), p: () => setTab("positions"), o: () => setTab("orders"),
      enter: () => { if (document.activeElement === document.body && cursorId) select(cursorId); },
    };
    const f = act[k];
    if (!f || (e.shiftKey && k !== "T" && k !== "/")) return;
    if (k !== "enter") e.preventDefault();
    f();
  };
  useEffect(() => {
    const h = (e: globalThis.KeyboardEvent) => onKey.current(e);
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, []);

  const searchKeys = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") { e.preventDefault(); moveCursor(e.key === "ArrowDown" ? 1 : -1); }
    else if (e.key === "Enter") { e.preventDefault(); const c = cursorId && rows.some((r) => r.conditionId === cursorId) ? cursorId : rows[0]?.conditionId; if (c) { select(c); searchRef.current?.blur(); } }
  };

  const viewKey = `${viewFeed?.tokenId ?? ""}|${outcome}`;
  const listed = rows.find((r) => r.conditionId === id);
  const meta = viewDetail?.market ?? all.find((r) => r.conditionId === id) ?? (listed ? { ...listed, daysLeft: listed.daysLeft ?? 0 } : null);
  const notFound = det.status === 404;
  const empty = mode === "all" ? "No open markets match. Try fewer words, or keys like cat:politics price:0.2..0.8."
    : query.trim() || cat ? "No watchlist market matches. Switch to All markets to search everything."
    : wl.data?.research === "disabled" ? "Research is paused on this instance. Market data still updates." : "No theses yet. Markets are scanned daily; the first research run is in progress.";
  const listErr = mode === "all"
    ? am.status === 400 ? "Query not understood. Use words plus keys like cat:politics days:<30 sort:-liq." : am.error ? "Could not load markets. Retrying in 60 s." : null
    : wl.error ? "Could not load the watchlist. Retrying in 60 s." : null;

  return (
    <div className={`term ${fontClass} ${css.grid}`}>
      <TopBar feedStatus={feed.status} feedSource={feed.source} feedAt={feed.data?.at ?? shown.current?.feed.at ?? null} now={Date.now()} balance={clob.balance}
        query={query} onQuery={setQuery} placeholder={mode === "all" ? "Search all markets · cat:politics price:0.2..0.8" : "Filter watchlist"} onSearchFocus={() => setDrawer(true)} onSearchKey={searchKeys} searchRef={searchRef} locked={!switchable} onBlocked={blocked} />
      <div className={`${css.backdrop} ${drawer ? css.open : ""}`} onClick={() => setDrawer(false)} aria-hidden />
      <MarketList mode={mode} onMode={(m) => { setMode(m); setCursorId(null); }} rows={rows} total={mode === "all" ? am.data?.total ?? null : null}
        loading={mode === "all" ? am.loading : wl.loading} error={listErr} empty={empty} cats={cats} cat={cat} onCat={setCat} sort={sort} onSort={setSort}
        selectedId={id} cursorId={cursorId} onSelect={select} open={drawer} note={lockNote ? LOCK_NOTE : null} />

      <section className={`${css.pane} ${css.chartp} ${dim ? css.dimmed : ""}`} aria-label="market">
        <div className={css.heroBox}>
          <MarketHero meta={meta} tick={viewFeed?.tickSize ?? null} yesMid={viewFeed?.mid ?? viewDetail?.snapshot?.mid ?? null} outcome={outcome} onOutcome={pickOutcome} notFound={notFound} />
          <KeyStats book={book} vol24h={viewDetail?.snapshot?.vol24h ?? null} />
        </div>
        <PriceChart conditionId={id} fallback={viewDetail?.history ?? []} liveMid={viewFeed?.mid ?? null} ownOrders={ownOrders} outcome={outcome} />
      </section>

      <div className={dim ? css.dimmed : undefined} style={{ display: "contents" }}>
        <BookLadder ref={ladderRef} book={book} status={feed.status} noBook={feed.noBook} outcome={outcome} ownOrders={ownOrders}
          viewKey={viewKey} cursor={ladderCursor} onCursor={setLadderCursor} onPick={(p) => setPick((x) => ({ price: p, n: (x?.n ?? 0) + 1 }))} />
      </div>

      <div className={css.col4}>
        <TerminalTicket ref={ticket} marketId={id} detail={detail} feed={feed.data} noBook={feed.noBook} side={side} outcome={outcome}
          onSide={pickSide} onOutcome={pickOutcome} held={held} pick={pick} wallet={w} onState={setOrder} />
        <div className={dim ? css.dimmed : undefined} style={{ display: "contents" }}><TradeTape feed={viewFeed} status={feed.status} viewKey={viewFeed?.tokenId ?? ""} /></div>
      </div>

      <AccountPane clob={clob} connected={w.status === "connected"} tab={tab} onTab={setTab} tokens={tokens} mark={mark} tick={viewFeed?.tickSize ?? DEFAULT_TICK} />
      <KeyLegend />
      <p className={`${css.disc} ${css.pageDisc}`}>{DISCLAIMER}</p>
    </div>
  );
}

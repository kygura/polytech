"use client";
// Visitor autonomy loop (SPEC Rev 6 flow 4). Runs only while a component using it is mounted and the loop is started; every 60 s:
// public watchlist -> top candidates' detail -> LIVE CLOB book (SDK public client) -> decide() -> propose (L2 queue) or place.
// The caller passes the exchange (trading key for L3/L4, connected wallet for L2 approve); keys are never built here.
import { midOf } from "@pm/core";
import type { ClobExchange } from "@pm/pm/exchange";
import { useCallback, useEffect, useRef, useState } from "react";
import type { PublicMarketDetail, PublicWatchlist } from "../lib/public";
import {
  buildExposure, decide, entryOf, loadLedger, pickCandidates, putEntry, recheck, sendEntry, toLiveBook,
  PROPOSAL_TTL_MS, type Candidate, type Ledger, type LedgerEntry, type LedgerStore, type TokenInfo,
} from "../lib/visitor/autonomy";
import { loadVisitorSettings, saveVisitorSettings, type VisitorMode, type VisitorSettings } from "../lib/visitor/settings";
import { relayEnvironment } from "../lib/visitor/relay";

export const TICK_MS = 60_000;
export const LOG_MAX = 50;
export type LogRow = { ts: number; event: string; thesisId?: string; market?: string; detail?: string };
export type VisitorLoop = {
  running: boolean;
  mode: VisitorMode; // saved choice; `running` says whether it is active in this tab
  settings: VisitorSettings;
  proposals: LedgerEntry[]; // queued, newest first
  log: LogRow[]; // newest first, last 50
  lastError: string | null;
  lastTickAt: number | null;
  nextTickAt: number | null;
  /** Saves (zod-validated, throws ZodError for the form) and applies on the next tick. A mode change starts / stops the loop; manual stops it. */
  setSettings: (patch: Partial<VisitorSettings>) => VisitorSettings;
  /** Start the loop with the saved mode (the page never resumes by itself after a reload). */
  resume: () => void;
  stop: () => void;
  approve: (thesisId: string) => Promise<LedgerEntry | null>;
  reject: (thesisId: string) => void;
  /** Stops the loop, back to manual, cancels this key's open orders. */
  kill: () => Promise<{ cancelled: number; error?: string }>;
};

type Opts = { exchange: ClobExchange | null; storage?: LedgerStore };

const getJson = async <T,>(url: string): Promise<T> => {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`);
  return (await r.json()) as T;
};
let pub: Promise<{ fetchOrderBook(r: { assetId: string }): Promise<Parameters<typeof toLiveBook>[0]> }> | undefined;
/** Live YES-token book + tick size straight from the CLOB (unauthenticated). */
const liveBook = async (assetId: string) => toLiveBook(await (await (pub ??= import("@polymarket/client").then(async (m) => m.createPublicClient({ environment: await relayEnvironment() })))).fetchOrderBook({ assetId }));
const fetchCandidate = async (conditionId: string): Promise<Candidate> => {
  const detail = await getJson<PublicMarketDetail>(`/api/public/markets/${conditionId}`);
  return { detail, book: await liveBook(detail.market.yesTokenId!) };
};
const msg = (e: unknown) => (e instanceof Error ? e.message : String(e)).slice(0, 300);

export function useVisitorLoop({ exchange, storage }: Opts): VisitorLoop {
  const store = (): LedgerStore => storage ?? localStorage;
  const [settings, setS] = useState<VisitorSettings>(() => loadVisitorSettings(storage));
  const [running, setRunning] = useState(false);
  const [ledger, setLedger] = useState<Ledger>({});
  const [log, setLog] = useState<LogRow[]>([]);
  const [lastError, setError] = useState<string | null>(null);
  const [lastTickAt, setLast] = useState<number | null>(null);
  const [nextTickAt, setNext] = useState<number | null>(null);
  const ex = useRef(exchange), st = useRef(settings), alive = useRef(false), busy = useRef(false), skipSeen = useRef(new Map<string, string>());
  ex.current = exchange;
  st.current = settings;

  const say = useCallback((r: Omit<LogRow, "ts">) => setLog((l) => [{ ts: Date.now(), ...r }, ...l].slice(0, LOG_MAX)), []);
  const sync = useCallback(() => {
    try {
      setLedger(loadLedger(store()));
    } catch (e) {
      alive.current = false; // corrupt ledger: never trade on a ledger we cannot read
      setRunning(false);
      setError(msg(e));
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  /** Current exposure from the exchange + ledger; `info` maps candidate tokens so held / sized markets are recognized. */
  const exposure = async (cands: Candidate[]) => {
    const info: Record<string, TokenInfo> = {};
    for (const { detail: d, book } of cands) {
      const yes = midOf(book.bids, book.asks) ?? 0.5;
      const base = { conditionId: d.market.conditionId, eventId: d.market.negRiskGroup ?? d.market.eventId ?? d.market.conditionId, category: d.market.category ?? "other" };
      if (d.market.yesTokenId) info[d.market.yesTokenId] = { ...base, price: yes };
      if (d.market.noTokenId) info[d.market.noTokenId] = { ...base, price: 1 - yes };
    }
    const [positions, orders] = await Promise.all([ex.current!.positions(), ex.current!.openOrders()]);
    return buildExposure({ bankroll: st.current.bankroll, positions, orders, ledger: loadLedger(store()), info, now: Date.now() });
  };

  const tick = useCallback(async () => {
    if (busy.current || !alive.current) return;
    busy.current = true;
    try {
      if (!ex.current) throw new Error("No wallet or trading key connected");
      const now = Date.now(), s = store();
      for (const e of Object.values(loadLedger(s))) // expire stale proposals
        if (e.status === "queued" && now - e.at >= PROPOSAL_TTL_MS) { putEntry(s, { ...e, status: "expired", reason: "TIMEOUT" }); say({ event: "proposal expired", thesisId: e.thesisId, market: e.question, detail: "TIMEOUT" }); }
      const watchlist = await getJson<PublicWatchlist>("/api/public/watchlist");
      const rows = pickCandidates(watchlist, loadLedger(s));
      const settled = await Promise.allSettled(rows.map((r) => fetchCandidate(r.conditionId)));
      const candidates = settled.flatMap((r) => (r.status === "fulfilled" ? [r.value] : []));
      settled.forEach((r, i) => r.status === "rejected" && say({ event: "skipped", market: rows[i]!.question, detail: `FETCH_FAILED: ${msg(r.reason)}` }));
      const actions = decide({ watchlist, candidates, settings: st.current, exposure: await exposure(candidates), ledger: loadLedger(s), now });
      for (const a of actions) {
        if (!alive.current) break; // killed mid-tick
        if (a.kind === "skip") {
          if (skipSeen.current.get(a.conditionId) !== a.reason) { skipSeen.current.set(a.conditionId, a.reason); say({ event: "skipped", thesisId: a.thesisId, market: a.question, detail: a.reason }); }
        } else if (a.kind === "propose") {
          putEntry(s, entryOf(a, now));
          say({ event: "proposed", thesisId: a.thesisId, market: a.question, detail: a.reason });
        } else {
          const r = await sendEntry(ex.current!, entryOf(a, now), "auto", s, now, () => alive.current);
          say({ event: r.status === "sent" ? "sent" : r.status === "unknown" ? "send unknown (not retried)" : "send failed", thesisId: a.thesisId, market: a.question, detail: r.error ?? `${a.shares} @ ${a.limitPrice} (${a.reason})` });
        }
      }
      setError(null);
    } catch (e) {
      setError(msg(e));
    } finally {
      busy.current = false;
      setLast(Date.now());
      sync();
    }
  }, [say, sync]); // eslint-disable-line react-hooks/exhaustive-deps

  // The loop: first tick now, then every TICK_MS. One tab only (Web Lock), so two tabs cannot both send.
  useEffect(() => {
    if (!running) return;
    alive.current = true;
    let timer: ReturnType<typeof setTimeout>, release: (() => void) | undefined, dead = false;
    const run = async () => {
      if (dead) return;
      await tick();
      if (dead || !alive.current) return;
      setNext(Date.now() + TICK_MS);
      timer = setTimeout(run, TICK_MS);
    };
    const start = () => void run();
    if (typeof navigator !== "undefined" && navigator.locks) {
      void navigator.locks.request("polytech.visitor.loop", { ifAvailable: true }, (lock) => {
        if (!lock) { alive.current = false; setRunning(false); setError("The loop is already running in another tab"); return; }
        start();
        return new Promise<void>((res) => (release = res));
      });
    } else start();
    return () => {
      dead = true;
      alive.current = false;
      clearTimeout(timer);
      release?.();
      setNext(null);
    };
  }, [running, tick]);

  useEffect(sync, [sync]);

  const stop = useCallback(() => {
    alive.current = false;
    setRunning(false);
    say({ event: "stopped" });
  }, [say]);
  const setSettings = useCallback((patch: Partial<VisitorSettings>) => {
    const next = saveVisitorSettings({ ...st.current, ...patch }, storage);
    if (patch.mode && patch.mode !== st.current.mode) say({ event: `mode → ${next.mode}` });
    st.current = next;
    setS(next);
    if (patch.mode) patch.mode === "manual" ? stop() : setRunning(true);
    return next;
  }, [say, stop, storage]);
  const resume = useCallback(() => st.current.mode !== "manual" && setRunning(true), []);

  const approve = useCallback(async (thesisId: string) => {
    const s = store(), e = loadLedger(s)[thesisId], x = ex.current;
    if (!e || e.status !== "queued" || !x || busy.current) return null; // busy: a tick may be placing; the proposal stays queued
    busy.current = true;
    try {
      const now = Date.now(), c = await fetchCandidate(e.conditionId);
      const bad = recheck(e, c, await exposure([c]), st.current, now);
      if (bad) {
        const r = putEntry(s, { ...e, status: bad.status, reason: bad.reason, error: bad.status === "failed" ? bad.reason : undefined });
        say({ event: bad.status === "failed" ? "rejected by limits" : "proposal expired", thesisId, market: e.question, detail: bad.reason });
        return r;
      }
      const r = await sendEntry(x, e, "user", s, now);
      say({ event: r.status === "sent" ? "sent" : r.status === "unknown" ? "send unknown (not retried)" : "send failed", thesisId, market: e.question, detail: r.error ?? `${e.shares} @ ${e.limitPrice} (approved)` });
      return r;
    } catch (err) {
      setError(msg(err)); // book / exchange read failed before any send: proposal stays queued
      return null;
    } finally {
      busy.current = false;
      sync();
    }
  }, [say, sync]); // eslint-disable-line react-hooks/exhaustive-deps
  const reject = useCallback((thesisId: string) => {
    const e = loadLedger(store())[thesisId];
    if (e?.status === "queued") { putEntry(store(), { ...e, status: "rejected" }); say({ event: "rejected", thesisId, market: e.question }); sync(); }
  }, [say, sync]); // eslint-disable-line react-hooks/exhaustive-deps

  const kill = useCallback(async () => {
    alive.current = false; // an in-flight tick stops before its next place
    st.current = saveVisitorSettings({ ...st.current, mode: "manual" }, storage);
    setS(st.current);
    setRunning(false);
    for (const e of Object.values(loadLedger(store()))) if (e.status === "queued") putEntry(store(), { ...e, status: "expired", reason: "KILLED" });
    let out: { cancelled: number; error?: string } = { cancelled: 0 };
    try {
      const n = ex.current ? (await ex.current.openOrders()).length : 0;
      await ex.current?.cancelAll();
      out = { cancelled: n };
    } catch (e) {
      out = { cancelled: 0, error: msg(e) };
      setError(out.error!);
    }
    say({ event: "stopped", detail: out.error ? `cancel failed: ${out.error}` : `${out.cancelled} cancelled` });
    sync();
    return out;
  }, [say, storage, sync]); // eslint-disable-line react-hooks/exhaustive-deps

  const proposals = Object.values(ledger).filter((e) => e.status === "queued").sort((a, b) => b.at - a.at);
  return { running, mode: settings.mode, settings, proposals, log, lastError, lastTickAt, nextTickAt, setSettings, resume, stop, approve, reject, kill };
}

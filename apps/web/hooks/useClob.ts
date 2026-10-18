"use client";
import type { ClobExchange, OpenOrder } from "@pm/pm/exchange";
import { useCallback, useEffect, useRef, useState } from "react";

type State = {
  /** CLOB API credentials derived for this exchange (first authed call done). Browser wallet: one signature. */
  credsReady: boolean;
  enabling: boolean;
  /** null = not checked yet. */
  approved: boolean | null;
  approving: boolean;
  balance: number | null;
  orders: OpenOrder[];
  positions: Record<string, number>;
  /** Account data refresh error (balance / orders / positions). */
  error: string | null;
  lastAt: number | null;
};
export type Clob = State & {
  /** Derives credentials (wallet signature prompt for a browser wallet), then checks allowances and loads account data. Throws on failure. */
  enable: () => Promise<void>;
  /** Grants the missing allowances (EOA: on-chain txs). Throws on failure. */
  approve: () => Promise<void>;
  refresh: () => Promise<void>;
  /** Re-reads allowance state. Throws on failure. */
  checkApproval: () => Promise<void>;
  /** Throw on failure; the caller shows the error inline. */
  cancel: (orderIds: string[]) => Promise<void>;
  cancelAll: () => Promise<void>;
};

const INIT: State = { credsReady: false, enabling: false, approved: null, approving: false, balance: null, orders: [], positions: {}, error: null, lastAt: null };
export const CLOB_DOWN = "Could not reach Polymarket. Orders and balances may be out of date.";

/**
 * Session CLOB state for one exchange (the browser wallet's, or the trading key's). Everything resets when `ex` changes,
 * so a new account or chain never sees the old credentials' data. Polls account data every `pollMs` once credentials exist.
 */
export function useClob(ex: ClobExchange | null, pollMs = 30_000): Clob {
  const [s, setS] = useState<State>(INIT);
  const cur = useRef(ex);
  cur.current = ex;
  useEffect(() => setS(INIT), [ex]);
  // Drop results that arrive after the exchange changed.
  const set = useCallback((owner: ClobExchange, f: (p: State) => State) => { if (cur.current === owner) setS(f); }, []);

  const refresh = useCallback(async () => {
    if (!ex) return;
    try {
      const [b, orders, positions] = await Promise.all([ex.balance(), ex.openOrders(), ex.positions()]);
      set(ex, (p) => ({ ...p, balance: b.usdc, orders, positions, error: null, lastAt: Date.now() }));
    } catch {
      set(ex, (p) => ({ ...p, error: CLOB_DOWN }));
    }
  }, [ex, set]);

  const checkApproval = useCallback(async () => {
    if (!ex) return;
    const ok = await ex.approved();
    set(ex, (p) => ({ ...p, approved: ok }));
  }, [ex, set]);

  const enable = useCallback(async () => {
    if (!ex) return;
    set(ex, (p) => ({ ...p, enabling: true }));
    try {
      await ex.wallet(); // first authed call: derives the API credentials
      set(ex, (p) => ({ ...p, credsReady: true }));
    } finally {
      set(ex, (p) => ({ ...p, enabling: false }));
    }
    await Promise.all([checkApproval().catch(() => set(ex, (p) => ({ ...p, error: CLOB_DOWN }))), refresh()]);
  }, [ex, set, checkApproval, refresh]);

  const approve = useCallback(async () => {
    if (!ex) return;
    set(ex, (p) => ({ ...p, approving: true }));
    try {
      await ex.setupApprovals();
      await checkApproval();
    } finally {
      set(ex, (p) => ({ ...p, approving: false }));
    }
  }, [ex, set, checkApproval]);

  const cancel = useCallback(async (ids: string[]) => { if (ex) { await ex.cancel(ids); await refresh(); } }, [ex, refresh]);
  const cancelAll = useCallback(async () => { if (ex) { await ex.cancelAll(); await refresh(); } }, [ex, refresh]);

  useEffect(() => {
    if (!s.credsReady) return;
    const id = setInterval(() => { if (document.visibilityState === "visible") void refresh(); }, pollMs);
    return () => clearInterval(id);
  }, [s.credsReady, refresh, pollMs]);

  return { ...s, enable, approve, refresh, checkApproval, cancel, cancelAll };
}

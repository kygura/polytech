"use client";
import type { ClobExchange } from "@pm/pm/exchange";
import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import { visitorExchange } from "../lib/visitor/exchange";
import { connectWallet, ensurePolygon, injected, resolveFunder, signerFor, watchWallet, type Funder } from "../lib/visitor/wallet";
import type { Clob } from "./useClob";

export type WalletStatus = "unavailable" | "disconnected" | "connecting" | "connected";
export type Wallet = {
  status: WalletStatus;
  address: `0x${string}` | null;
  /** false = the wallet is on another chain: trading must stop. */
  chainOk: boolean;
  funder: Funder | null;
  /** Session exchange for this account; rebuilt (new credentials) on account or chain change. null unless connected. */
  exchange: ClobExchange | null;
  error: string | null;
  connect: () => Promise<void>;
  disconnect: () => void;
  switchChain: () => Promise<void>;
};

/** EIP-1193 user rejection (code 4001), also after the exchange scrubbed the error down to a message. */
export const isRejection = (e: unknown) =>
  (e as { code?: unknown } | null)?.code === 4001 || /user (rejected|denied)/i.test(e instanceof Error ? e.message : String(e));
const ACCOUNT_CHECK = "Could not check your Polymarket account. Try again.";
const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));

type Conn = { address: `0x${string}`; funder: Funder; exchange: ClobExchange };

/** Browser wallet connection for the provider (PublicShell). Components read it through useWallet(). */
export function useWalletConnection(): Wallet {
  const [status, setStatus] = useState<WalletStatus>("disconnected");
  const [conn, setConn] = useState<Conn | null>(null);
  const [chainOk, setChainOk] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const seq = useRef(0); // newest open() wins

  useEffect(() => { if (!injected()) setStatus("unavailable"); }, []);

  const open = useCallback(async (address: `0x${string}`) => {
    const p = injected();
    if (!p) return;
    const n = ++seq.current;
    const [{ signer }, funder] = await Promise.all([signerFor(p, address), resolveFunder(address).catch(() => { throw new Error(ACCOUNT_CHECK); })]);
    if (n !== seq.current) return;
    setConn({ address, funder, exchange: visitorExchange(signer, address, funder) });
    setStatus("connected");
  }, []);

  const disconnect = useCallback(() => {
    seq.current++;
    setConn(null);
    setStatus(injected() ? "disconnected" : "unavailable");
  }, []);

  const connect = useCallback(async () => {
    const p = injected();
    if (!p) return;
    setStatus("connecting");
    setError(null);
    try {
      const c = await connectWallet(p);
      setChainOk(true);
      await open(c.address);
    } catch (e) {
      setStatus("disconnected");
      setError(isRejection(e) ? "You rejected the connection request." : msg(e) === ACCOUNT_CHECK ? ACCOUNT_CHECK : `Could not connect: ${msg(e)}`);
    }
  }, [open]);

  const switchChain = useCallback(async () => {
    const p = injected();
    if (!p) return;
    setError(null);
    try { await ensurePolygon(p); }
    catch (e) { setError(isRejection(e) ? "You rejected the network switch." : `Could not switch network: ${msg(e)}`); }
  }, []);

  // Account or chain change: drop the exchange (credentials are bound to the account) and rebuild it for the new state.
  const address = conn?.address ?? null;
  useEffect(() => {
    const p = injected();
    if (!p || !address) return;
    return watchWallet(p, {
      onAccount: (a) => {
        if (!a) return disconnect();
        if (a !== address) { setConn(null); setStatus("connecting"); open(a).catch((e) => { disconnect(); setError(`Could not switch account: ${msg(e)}`); }); }
      },
      onChain: (ok) => {
        setChainOk(ok);
        if (ok) { setConn(null); setStatus("connecting"); open(address).catch((e) => { disconnect(); setError(`Could not reconnect: ${msg(e)}`); }); }
      },
    });
  }, [address, open, disconnect]);

  return {
    status, address, chainOk, funder: conn?.funder ?? null, error,
    exchange: status === "connected" && chainOk ? conn?.exchange ?? null : null,
    connect, disconnect, switchChain,
  };
}

export const WalletContext = createContext<(Wallet & { clob: Clob }) | null>(null);

/** Wallet connection plus its session CLOB state (credentials, allowance, balance, orders, positions). */
export function useWallet(): Wallet & { clob: Clob } {
  const w = useContext(WalletContext);
  if (!w) throw new Error("useWallet must be used inside PublicShell");
  return w;
}

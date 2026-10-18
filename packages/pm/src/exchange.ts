import type { SecureClient, Signer } from "@polymarket/client";
import { privateKeyToAccount } from "viem/accounts";
import { z } from "zod";
import { bucket } from "./bucket";

export type Side = "BUY" | "SELL";
export type LimitOrder = { tokenId: string; side: Side; price: number; shares: number; expiresAt: Date };
export type Placed = { orderId: string; status: "live" | "matched" | "rejected"; error?: string };
export type OpenOrder = { orderId: string; tokenId: string; side: Side; price: number; shares: number; filled: number };
/** Marketable order. FOK = all-or-nothing, FAK = take what is there, kill the rest. capPrice = worst acceptable price (BUY max / SELL min). */
export type ImmediateOrder = { tokenId: string; side: Side; shares: number; capPrice: number; type: "FOK" | "FAK" };
export type ImmediateResult = { status: "filled" | "partial" | "killed" | "rejected"; clobOrderId?: string; filledShares: number; avgPrice: number; error?: string };
/** Named ExchangeTrade (not Trade) because schemas.ts already exports the Data API `Trade`. */
export type ExchangeTrade = { tradeId: string; orderId: string; tokenId: string; side: Side; price: number; shares: number; fee: number; at: Date };
export interface Exchange {
  address(): string;
  place(o: LimitOrder): Promise<Placed>; // GTD limit only, never market
  placeImmediate(o: ImmediateOrder): Promise<ImmediateResult>; // throws on unknown outcome: caller must treat as unknown, never resend
  cancel(orderIds: string[]): Promise<void>;
  cancelAll(): Promise<void>;
  openOrders(): Promise<OpenOrder[]>;
  trades(since: Date): Promise<ExchangeTrade[]>;
  balance(): Promise<{ usdc: number }>;
  positions(): Promise<Record<string, number>>; // tokenId -> shares
}

const MIN_EXPIRY_MS = 3 * 60_000; // venue rule: GTD expiration >= now + 3 min

/** Throws (before anything is sent) on an order the venue would reject or we never want to send. */
export function validateOrder(o: LimitOrder, now = Date.now()): void {
  if (!o.tokenId) throw new Error("order: tokenId required");
  if (o.side !== "BUY" && o.side !== "SELL") throw new Error(`order: bad side ${o.side}`);
  if (!(o.price > 0 && o.price < 1)) throw new Error(`order: price ${o.price} outside (0,1)`);
  if (!(o.shares > 0) || !Number.isFinite(o.shares)) throw new Error(`order: shares ${o.shares} must be > 0`);
  if (!(o.expiresAt instanceof Date) || !(o.expiresAt.getTime() >= now + MIN_EXPIRY_MS)) throw new Error("order: expiresAt must be >= now + 3 min");
}

export function validateImmediate(o: ImmediateOrder): void {
  if (!o.tokenId) throw new Error("immediate: tokenId required");
  if (o.side !== "BUY" && o.side !== "SELL") throw new Error(`immediate: bad side ${o.side}`);
  if (o.type !== "FOK" && o.type !== "FAK") throw new Error(`immediate: bad type ${o.type}`);
  if (!(o.capPrice > 0 && o.capPrice < 1)) throw new Error(`immediate: capPrice ${o.capPrice} outside (0,1)`);
  if (!(o.shares > 0) || !Number.isFinite(o.shares)) throw new Error(`immediate: shares ${o.shares} must be > 0`);
}

const HEX64 = /(0x)?[0-9a-fA-F]{64}/g;
/** Removes every 32-byte hex blob (keys, also tx/condition ids: acceptable loss) and each listed secret from a message. */
export function scrub(msg: string, secrets: (string | undefined)[] = []): string {
  let out = msg.replace(HEX64, "[redacted]");
  for (const s of secrets) if (s && s.length >= 6) out = out.split(s).join("[redacted]");
  return out;
}
/** New Error carrying only a scrubbed message: no cause, no stack-carried payload, no SDK fields. */
export function safeError(e: unknown, secrets: (string | undefined)[] = []): Error {
  const name = e instanceof Error ? e.name : "Error";
  const msg = e instanceof Error ? e.message : typeof e === "string" ? e : "unknown error";
  return new Error(scrub(`${name}: ${msg}`, secrets));
}

const Env = z.object({
  PM_PRIVATE_KEY: z.string({ error: "PM_PRIVATE_KEY not set" }).trim()
    .regex(/^(0x)?[0-9a-fA-F]{64}$/, "PM_PRIVATE_KEY must be 32-byte hex (64 hex chars, optional 0x)"),
  PM_SIGNATURE_TYPE: z.enum(["eoa", "deposit"]).default("deposit"),
});

const num = (s: unknown) => Number(s);
const side = (s: string): Side => (s.toUpperCase() === "SELL" ? "SELL" : "BUY");
// ponytail: fee = bps/1e4 * min(p, 1-p) * shares (legacy CLOB formula); unverified for V2, reconcile vs balance if it drifts
const fee = (bps: unknown, p: number, n: number) => ((num(bps) || 0) / 1e4) * Math.min(p, 1 - p) * n;

/**
 * What clobExchange signs with. `wallet` picks the account/funder and, through the SDK, the signature type:
 * the signer address = EOA (0); a Poly Proxy / Safe derived from the signer = 1 / 2; undefined = the signer's Deposit Wallet (3).
 */
export type ClobSigner = {
  signer: Signer | (() => Promise<Signer>);
  /** Signer EOA address (what `address()` returns). */
  address: string;
  wallet?: string;
  /** Extra strings scrubbed from every error (e.g. the raw key). API secrets are added automatically. */
  secrets?: string[];
};
export type ClobExchange = Exchange & {
  wallet(): Promise<string>;
  /** True when the account wallet holds every trading allowance the venue needs. */
  approved(): Promise<boolean>;
  /** Grants the missing allowances. EOA: one on-chain tx each, paid in POL by the signer. Other wallets: relayer (needs a relayer/builder key). */
  setupApprovals(): Promise<void>;
};

const isSigner = (x: ClobSigner | Record<string, string | undefined>): x is ClobSigner => typeof x.signer === "object" || typeof x.signer === "function";

/** Env (PM_PRIVATE_KEY, PM_SIGNATURE_TYPE) -> ClobSigner. Throws zod messages only, never the input. */
function envSigner(env: Record<string, string | undefined>): ClobSigner {
  const parsed = Env.safeParse({ PM_PRIVATE_KEY: env.PM_PRIVATE_KEY || undefined, PM_SIGNATURE_TYPE: env.PM_SIGNATURE_TYPE || undefined });
  if (!parsed.success) throw new Error(parsed.error.issues.map((i) => i.message).join("; "));
  const bare = parsed.data.PM_PRIVATE_KEY.replace(/^0x/, "");
  const pk = `0x${bare}` as const;
  const address = privateKeyToAccount(pk).address;
  return {
    signer: async () => (await import("@polymarket/client/viem")).privateKey(pk),
    address,
    wallet: parsed.data.PM_SIGNATURE_TYPE === "eoa" ? address : undefined,
    secrets: [bare],
  };
}

/**
 * Real CLOB exchange, from env (operator key) or from any SDK signer (browser wallet, browser trading key).
 * The signer lives only in this closure; nothing it throws contains key or API secrets.
 */
export function clobExchange(src: ClobSigner | Record<string, string | undefined> = process.env): ClobExchange {
  const acct = isSigner(src) ? src : envSigner(src);
  const signerAddress = acct.address;
  const secrets: (string | undefined)[] = [...(acct.secrets ?? [])];
  const take = bucket(500, 10_000); // ponytail: one bucket for all authed calls, well under POST /order 3500/10s
  let client: Promise<SecureClient> | undefined;

  // Credentials derived lazily, once per instance; a failed derivation is retried on the next call.
  const c = (): Promise<SecureClient> =>
    (client ??= (async () => {
      const { createSecureClient } = await import("@polymarket/client");
      const signer = typeof acct.signer === "function" ? await acct.signer() : acct.signer;
      const cl = await createSecureClient({ signer, wallet: acct.wallet });
      secrets.push(cl.credentials.secret, cl.credentials.passphrase, cl.credentials.key);
      return cl;
    })().catch((e) => {
      client = undefined;
      throw e;
    }));

  /** Every SDK call goes through here: throttled, errors replaced by scrubbed copies. */
  const call = async <T>(f: (cl: SecureClient) => Promise<T>): Promise<T> => {
    try {
      const cl = await c();
      await take();
      return await f(cl);
    } catch (e) {
      throw safeError(e, secrets);
    }
  };
  const all = async <T>(p: AsyncIterable<{ items: T[] }>): Promise<T[]> => {
    const out: T[] = [];
    for await (const page of p) out.push(...page.items);
    return out;
  };

  return {
    address: () => signerAddress,
    wallet: () => call(async (cl) => cl.account.wallet as string),
    approved: () => call(async (cl) => (await cl.fetchTradingApprovalsState()).isFullyApproved),
    setupApprovals: () => call((cl) => cl.setupTradingApprovals()),
    async place(o) {
      validateOrder(o);
      const { OrderSide } = await import("@polymarket/client");
      const r = await call((cl) =>
        cl.placeLimitOrder({
          assetId: o.tokenId, price: o.price, size: o.shares,
          side: o.side === "BUY" ? OrderSide.BUY : OrderSide.SELL,
          expiration: Math.floor(o.expiresAt.getTime() / 1000), // set => GTD
        }),
      );
      if (!r.ok) return { orderId: "", status: "rejected", error: scrub(`${r.code}: ${r.message}`, secrets) };
      return { orderId: r.orderId, status: r.status === "matched" ? "matched" : "live" }; // "delayed" (queued by venue) -> live
    },
    async placeImmediate(o) {
      validateImmediate(o);
      const { OrderSide, OrderType } = await import("@polymarket/client");
      const type = o.type === "FOK" ? OrderType.FOK : OrderType.FAK;
      // BUY is sized in USD: amount = shares*cap is the max spend, so a BUY may return more shares than asked if it fills below cap.
      const r = await call((cl) =>
        cl.placeMarketOrder(
          o.side === "BUY"
            ? { assetId: o.tokenId, side: OrderSide.BUY, amount: o.shares * o.capPrice, maxPrice: o.capPrice, orderType: type }
            : { assetId: o.tokenId, side: OrderSide.SELL, shares: o.shares, minPrice: o.capPrice, orderType: type },
        ),
      );
      if (!r.ok) {
        const msg = scrub(`${r.code}: ${r.message}`, secrets);
        return /^(unmatched|fok_not_filled|fak_not_filled)$/.test(r.code) ? { status: "killed", filledShares: 0, avgPrice: 0, error: msg } : { status: "rejected", filledShares: 0, avgPrice: 0, error: msg };
      }
      if (typeof r !== "object" || r.status !== "matched" || !r.orderId) throw new Error(`placeImmediate: unexpected response status ${String(r.status)}`);
      const usd = num(o.side === "BUY" ? r.makingAmount : r.takingAmount), n = num(o.side === "BUY" ? r.takingAmount : r.makingAmount);
      if (!(n > 0) || !(usd > 0)) throw new Error("placeImmediate: matched with no amounts");
      return { status: n >= o.shares * (1 - 1e-6) ? "filled" : "partial", clobOrderId: r.orderId, filledShares: n, avgPrice: usd / n };
    },
    async cancel(orderIds) {
      if (orderIds.length) await call((cl) => cl.cancelOrders({ orderIds }));
    },
    async cancelAll() {
      await call((cl) => cl.cancelAll());
    },
    openOrders: () =>
      call(async (cl) =>
        (await all(cl.listOpenOrders())).map((x) => ({
          orderId: x.id, tokenId: x.assetId, side: side(x.side), price: num(x.price), shares: num(x.originalSize), filled: num(x.sizeMatched),
        })),
      ),
    trades: (since) =>
      call(async (cl) => {
        const me = (cl.account.wallet as string).toLowerCase();
        const out: ExchangeTrade[] = [];
        for (const t of await all(cl.listAccountTrades({ after: String(Math.floor(since.getTime() / 1000)) }))) {
          const at = new Date(t.matchedAt);
          if (at < since) continue;
          if (t.traderSide === "TAKER") {
            const p = num(t.price), n = num(t.size);
            out.push({ tradeId: t.id, orderId: t.takerOrderId, tokenId: t.assetId, side: side(t.side), price: p, shares: n, fee: fee(t.feeRateBps, p, n), at });
          } else {
            for (const m of t.makerOrders) {
              if (m.makerAddress.toLowerCase() !== me) continue;
              const p = num(m.price), n = num(m.matchedAmount);
              out.push({ tradeId: `${t.id}:${m.orderId}`, orderId: m.orderId, tokenId: m.assetId, side: side(m.side), price: p, shares: n, fee: fee(m.feeRateBps, p, n), at });
            }
          }
        }
        return out;
      }),
    balance: () =>
      call(async (cl) => {
        const [{ fetchBalanceAllowance }, { AssetType }] = await Promise.all([import("@polymarket/client/actions"), import("@polymarket/client")]);
        const r = await fetchBalanceAllowance(cl, { assetType: AssetType.COLLATERAL });
        return { usdc: num(r.balance) / 1e6 }; // base units, 6 decimals
      }),
    positions: () =>
      call(async (cl) => {
        const out: Record<string, number> = {};
        for (const p of await all(cl.listPositions())) if (num(p.currentSize) > 0) out[p.assetId] = (out[p.assetId] ?? 0) + num(p.currentSize);
        return out;
      }),
  };
}

/** null = live trading not configured (fixtures mode or no key). Never returns a fake. */
export function exchangeFromEnv(env: Record<string, string | undefined> = process.env): Exchange | null {
  if (env.PM_FIXTURES === "1" || !env.PM_PRIVATE_KEY) return null;
  return clobExchange(env);
}

export type FakeExchange = Exchange & {
  /** Matches `shares` (default: remaining) of an open order at `price` (default: limit). Creates a trade, moves positions/usdc. */
  fill(orderId: string, shares?: number, price?: number): ExchangeTrade;
  setBalance(usdc: number): void;
  /** Next call to place/cancel/cancelAll fails: a string makes place() return `rejected`, an Error is thrown by whichever runs. */
  failNext(error: string | Error): void;
  /** Next placeImmediate on tokenId fills `filled` shares at capPrice (0 = killed). FOK with filled < shares is killed. Unscripted: fills fully. */
  scriptImmediate(tokenId: string, filled: number): void;
};

/** In-memory deterministic exchange for tests and local demo. */
export function fakeExchange(opts: { usdc?: number; now?: () => Date; address?: string } = {}): FakeExchange {
  const now = opts.now ?? (() => new Date());
  let usdc = opts.usdc ?? 1000;
  let seq = 0;
  let pending: string | Error | undefined;
  const scripts = new Map<string, number>();
  const open = new Map<string, OpenOrder>();
  const done: ExchangeTrade[] = [];
  const pos: Record<string, number> = {};
  const failure = () => {
    const f = pending;
    pending = undefined;
    if (f instanceof Error) throw f;
    return f;
  };

  return {
    address: () => opts.address ?? "0xfake",
    async place(o) {
      validateOrder(o, now().getTime());
      const f = failure();
      if (f !== undefined) return { orderId: "", status: "rejected", error: f };
      const orderId = `fake-${++seq}`;
      open.set(orderId, { orderId, tokenId: o.tokenId, side: o.side, price: o.price, shares: o.shares, filled: 0 });
      return { orderId, status: "live" };
    },
    async placeImmediate(o) {
      validateImmediate(o);
      const f = failure();
      if (f !== undefined) return { status: "rejected", filledShares: 0, avgPrice: 0, error: f };
      const want = scripts.get(o.tokenId) ?? o.shares;
      scripts.delete(o.tokenId);
      const n = Math.min(want, o.shares);
      if (!(n > 0) || (o.type === "FOK" && n < o.shares - 1e-9)) return { status: "killed", filledShares: 0, avgPrice: 0 };
      const orderId = `fake-${++seq}`;
      const sign = o.side === "BUY" ? 1 : -1;
      pos[o.tokenId] = (pos[o.tokenId] ?? 0) + sign * n;
      usdc -= sign * o.capPrice * n;
      done.push({ tradeId: `fake-t-${++seq}`, orderId, tokenId: o.tokenId, side: o.side, price: o.capPrice, shares: n, fee: 0, at: now() });
      return { status: n >= o.shares - 1e-9 ? "filled" : "partial", clobOrderId: orderId, filledShares: n, avgPrice: o.capPrice };
    },
    async cancel(ids) {
      failure();
      for (const id of ids) open.delete(id);
    },
    async cancelAll() {
      failure();
      open.clear();
    },
    openOrders: async () => [...open.values()].map((o) => ({ ...o })),
    trades: async (since) => done.filter((t) => t.at >= since).map((t) => ({ ...t })),
    balance: async () => ({ usdc }),
    positions: async () => ({ ...pos }),
    fill(orderId, shares, price) {
      const o = open.get(orderId);
      if (!o) throw new Error(`fake: no open order ${orderId}`);
      const n = shares ?? o.shares - o.filled;
      if (!(n > 0) || o.filled + n > o.shares + 1e-9) throw new Error(`fake: bad fill size ${n}`);
      const p = price ?? o.price;
      o.filled += n;
      const sign = o.side === "BUY" ? 1 : -1;
      pos[o.tokenId] = (pos[o.tokenId] ?? 0) + sign * n;
      usdc -= sign * p * n;
      if (o.filled >= o.shares - 1e-9) open.delete(orderId);
      const t: ExchangeTrade = { tradeId: `fake-t-${++seq}`, orderId, tokenId: o.tokenId, side: o.side, price: p, shares: n, fee: 0, at: now() };
      done.push(t);
      return { ...t };
    },
    setBalance: (v) => void (usdc = v),
    failNext: (e) => void (pending = e),
    scriptImmediate: (t, n) => void scripts.set(t, n),
  };
}

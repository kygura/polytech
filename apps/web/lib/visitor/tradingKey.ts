// Browser-held trading key for visitor autonomy: generated in, and stored only in, this browser.
// ponytail: plaintext localStorage; any XSS on our origin = key loss. Mitigation: the visitor funds it with a capped amount.
// Upgrade path: WebCrypto non-extractable key wrapping, or a passkey-bound key.
//
// Funding mode: EOA (signature type 0). The key's own address holds pUSD and POL and signs as itself.
// Gasless Deposit Wallet deploy + approvals exist in the SDK but need a relayer/builder API key, which cannot ship to a browser.
import type { Signer } from "@polymarket/client";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { polygon } from "viem/chains";

export type Hex = `0x${string}`;
export type KeyStore = Pick<Storage, "getItem" | "setItem" | "removeItem">;

export const STORAGE_KEY = "polytech.tradingKey";
/** Polymarket V2 collateral on Polygon (SDK production environment `contracts.collateralToken`). */
export const PUSD = "0xC011a7E12a19f7B1f670d46F03B03f3342E82DFB";
const KEY_RE = /^(0x)?[0-9a-fA-F]{64}$/;

const store = (s?: KeyStore): KeyStore => s ?? localStorage;

/** Normalizes a 32-byte hex key (optional 0x, any case). Throws without echoing the input. */
export function parseKey(raw: string): Hex {
  const t = raw.trim();
  if (!KEY_RE.test(t)) throw new Error("Trading key must be 32-byte hex (64 hex chars, optional 0x)");
  const pk = `0x${t.replace(/^0x/, "").toLowerCase()}` as Hex;
  privateKeyToAccount(pk); // throws on a value outside the curve order
  return pk;
}

/** The stored key, or null (none, or a corrupt value). */
export function loadTradingKey(s?: KeyStore): Hex | null {
  const v = store(s).getItem(STORAGE_KEY);
  if (!v) return null;
  try {
    return parseKey(v);
  } catch {
    return null;
  }
}

function save(pk: Hex, s?: KeyStore): Hex {
  // Never overwrite: replacing a funded key loses its funds. The caller must export + forget first.
  if (store(s).getItem(STORAGE_KEY)) throw new Error("A trading key already exists; export and forget it first");
  store(s).setItem(STORAGE_KEY, pk);
  return pk;
}

export const createTradingKey = (s?: KeyStore): Hex => save(generatePrivateKey(), s);
export const importTradingKey = (raw: string, s?: KeyStore): Hex => save(parseKey(raw), s);
/** For the reveal/backup UI. */
export const exportTradingKey = (s?: KeyStore): Hex | null => loadTradingKey(s);
export const forgetTradingKey = (s?: KeyStore): void => store(s).removeItem(STORAGE_KEY);

export const tradingKeyAddress = (pk: Hex): Hex => privateKeyToAccount(pk).address;

/** Same SDK path as the operator env key. Its approval txs go out over viem's default public Polygon RPC. */
export async function tradingKeySigner(pk: Hex): Promise<Signer> {
  const { privateKey } = await import("@polymarket/client/viem");
  return privateKey(pk, { chain: polygon });
}

/** Where to send funds and what is needed before the loop can trade. */
export function fundingInfo(pk: Hex) {
  return {
    address: tradingKeyAddress(pk),
    mode: "eoa" as const,
    chain: "Polygon (137)",
    tokens: [
      { symbol: "pUSD", address: PUSD, purpose: "trading collateral; fund only the capped amount you are willing to lose" },
      { symbol: "POL", address: null, purpose: "gas for the one-time allowance transactions (setupApprovals), a few cents" },
    ],
  };
}

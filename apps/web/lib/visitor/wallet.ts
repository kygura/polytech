// Injected EIP-1193 wallet (MetaMask & co.) -> viem WalletClient on Polygon -> Polymarket SDK signer.
//
// Funding per account mode (resolveFunder):
// - "polymarket": the EOA already owns a Polymarket account wallet (Proxy, Safe or Deposit Wallet, per its public profile).
//   Funds (pUSD) and allowances live in that wallet; they were set up on polymarket.com. Nothing to do here.
// - "eoa": no Polymarket account. The EOA trades as itself: it needs pUSD (V2 collateral) and POL for gas,
//   and must send the allowance txs once (ClobExchange.setupApprovals). A fresh Deposit Wallet is not offered:
//   deploying it goes through Polymarket's relayer, which needs a relayer/builder API key we cannot ship to a browser.
import type { Signer } from "@polymarket/client";
import { createWalletClient, custom, getAddress, type WalletClient } from "viem";
import { polygon } from "viem/chains";

export type Eip1193 = {
  request(args: { method: string; params?: unknown[] }): Promise<unknown>;
  on?(event: string, fn: (...args: any[]) => void): void;
  removeListener?(event: string, fn: (...args: any[]) => void): void;
};
export type Connected = { address: `0x${string}`; walletClient: WalletClient; signer: Signer };

const POLYGON_HEX = `0x${polygon.id.toString(16)}`; // 0x89

/** The injected provider, if any (client side only). */
export const injected = (): Eip1193 | undefined => (globalThis as { ethereum?: Eip1193 }).ethereum;

/** Switches the wallet to Polygon, adding the chain first when the wallet does not know it (EIP-3326 error 4902). */
export async function ensurePolygon(p: Eip1193): Promise<void> {
  if (String(await p.request({ method: "eth_chainId" })).toLowerCase() === POLYGON_HEX) return;
  try {
    await p.request({ method: "wallet_switchEthereumChain", params: [{ chainId: POLYGON_HEX }] });
  } catch (e) {
    if ((e as { code?: number }).code !== 4902) throw e;
    await p.request({
      method: "wallet_addEthereumChain",
      params: [{
        chainId: POLYGON_HEX, chainName: polygon.name, nativeCurrency: polygon.nativeCurrency,
        rpcUrls: polygon.rpcUrls.default.http, blockExplorerUrls: [polygon.blockExplorers.default.url],
      }],
    });
  }
}

/** Asks for accounts, ensures Polygon, returns the signer for the first account. User rejection throws (code 4001). */
export async function connectWallet(p: Eip1193 | undefined = injected()): Promise<Connected> {
  if (!p) throw new Error("No browser wallet found");
  const accounts = (await p.request({ method: "eth_requestAccounts" })) as string[];
  if (!accounts?.[0]) throw new Error("Wallet returned no account");
  await ensurePolygon(p);
  return signerFor(p, getAddress(accounts[0]));
}

export async function signerFor(p: Eip1193, address: `0x${string}`): Promise<Connected> {
  const walletClient = createWalletClient({ account: address, chain: polygon, transport: custom(p) });
  const { signerFrom } = await import("@polymarket/client/viem");
  return { address, walletClient, signer: signerFrom(walletClient) };
}

/**
 * Calls back on account / chain changes; returns an unsubscribe. On any change the caller must drop the
 * current signer and exchange (credentials are bound to the account) and reconnect.
 * `account` is null when the wallet disconnected; `chainOk` is false off Polygon (trading must stop).
 */
export function watchWallet(p: Eip1193, cb: { onAccount(account: `0x${string}` | null): void; onChain(chainOk: boolean): void }): () => void {
  const acc = (a: string[]) => cb.onAccount(a?.[0] ? getAddress(a[0]) : null);
  const chain = (id: string) => cb.onChain(String(id).toLowerCase() === POLYGON_HEX);
  p.on?.("accountsChanged", acc);
  p.on?.("chainChanged", chain);
  return () => {
    p.removeListener?.("accountsChanged", acc);
    p.removeListener?.("chainChanged", chain);
  };
}

export type Funder = { wallet: `0x${string}`; mode: "polymarket" | "eoa" };
type ProfileLookup = (address: string) => Promise<{ wallet?: string | null } | null>;

const sdkProfile: ProfileLookup = async (address) => {
  const { createPublicClient } = await import("@polymarket/client");
  return createPublicClient().fetchPublicProfile({ address });
};

/** The Polymarket account wallet owned by `address` (its public profile's proxyWallet), else the EOA itself. */
export async function resolveFunder(address: `0x${string}`, lookup: ProfileLookup = sdkProfile): Promise<Funder> {
  const w = (await lookup(address))?.wallet;
  return w && w.toLowerCase() !== address.toLowerCase() ? { wallet: getAddress(w), mode: "polymarket" } : { wallet: address, mode: "eoa" };
}

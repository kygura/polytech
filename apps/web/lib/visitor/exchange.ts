// Visitor exchange: the shared clobExchange, signed in the browser. Orders go browser -> clob.polymarket.com directly;
// never relay them through our server (that would bypass Polymarket's jurisdiction checks on the visitor's IP).
// CLOB API credentials are derived once, on the first call, and live only in the exchange closure (memory):
// never written to localStorage/sessionStorage. A reload or account change derives them again.
import type { Signer } from "@polymarket/client";
import { clobExchange, type ClobExchange } from "@pm/pm/exchange";
import type { Funder } from "./wallet";

/** `funder` from resolveFunder(); `secrets` = strings to scrub from errors (the raw trading key, if any). */
export function visitorExchange(signer: Signer, address: `0x${string}`, funder: Funder, secrets: string[] = []): ClobExchange {
  return clobExchange({ signer, address, wallet: funder.wallet, secrets });
}

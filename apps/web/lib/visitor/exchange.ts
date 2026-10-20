// Visitor exchange: the shared clobExchange, signed in the browser. Signed requests go through our session-gated relay
// (app/api/pm, pinned region) because the operator's network cannot reliably reach Polymarket; the server never holds keys.
// CLOB API credentials are derived once, on the first call, and live only in the exchange closure (memory):
// never written to localStorage/sessionStorage. A reload or account change derives them again.
import type { Signer } from "@polymarket/client";
import { clobExchange, type ClobExchange } from "@pm/pm/exchange";
import { relayEnvironment } from "./relay";
import type { Funder } from "./wallet";

/** `funder` from resolveFunder(); `secrets` = strings to scrub from errors (the raw trading key, if any). */
export function visitorExchange(signer: Signer, address: `0x${string}`, funder: Funder, secrets: string[] = []): ClobExchange {
  return clobExchange({ signer, address, wallet: funder.wallet, secrets, environment: () => relayEnvironment() });
}

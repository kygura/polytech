// Live CLOB smoke test. Run ONCE from an unblocked network with PM_PRIVATE_KEY (and optional PM_SIGNATURE_TYPE) set:
//   bun run --cwd packages/pm clob-smoke --token <tokenId> [--price 0.01] [--dry]
// Derives API creds, places one tiny GTD BUY far from the market, cancels it, confirms no open orders remain.
// Never prints the key or API secrets; every error message passes through the exchange scrubber.
import { parseArgs } from "node:util";
import { clobExchange, createPm, scrub, validateOrder, type LimitOrder } from "../src/index";

const { values: a } = parseArgs({ options: { token: { type: "string" }, price: { type: "string", default: "0.01" }, dry: { type: "boolean", default: false } } });
let phase = "setup";

async function main() {
  const ex = clobExchange(process.env); // throws "PM_PRIVATE_KEY not set" before anything else
  console.log(`signer address: ${ex.address()} (mode ${process.env.PM_SIGNATURE_TYPE || "deposit"})`);
  if (!a.token) throw new Error("--token <tokenId> required");
  const price = Number(a.price);

  phase = "book";
  const [book] = await createPm({ fixtures: false }).books([a.token]);
  const shares = book?.min_order_size ?? 5;
  const order: LimitOrder = { tokenId: a.token, side: "BUY", price, shares, expiresAt: new Date(Date.now() + 10 * 60_000) };
  validateOrder(order);
  console.log(`planned: GTD BUY ${shares} @ ${price} on ${a.token}, expires ${order.expiresAt.toISOString()} (best bid ${book?.bids[0]?.price ?? "?"})`);
  if (a.dry) return console.log("--dry: nothing signed or sent");

  phase = "derive";
  console.log(`wallet: ${await ex.wallet()} (API credentials derived)`);
  console.log(`balance: ${(await ex.balance()).usdc} USDC`);

  phase = "place";
  const placed = await ex.place(order);
  console.log(`placed: ${JSON.stringify(placed)}`);
  if (placed.status === "rejected") throw new Error(`order rejected: ${placed.error}`);

  phase = "cancel";
  await ex.cancel([placed.orderId]);
  const left = (await ex.openOrders()).filter((o) => o.orderId === placed.orderId);
  if (left.length) throw new Error(`order ${placed.orderId} still open after cancel`);
  console.log("cancelled; open orders confirmed clear of the test order. OK");
}

main().catch((e) => {
  const msg = scrub(e instanceof Error ? e.message : String(e), [process.env.PM_PRIVATE_KEY?.replace(/^0x/, "")]);
  console.error(`clob-smoke failed [${phase}]: ${msg}`);
  if (phase === "derive" && /\b400\b/.test(msg))
    console.error("HTTP 400 during key derivation: matches open SDK issue #65 (deposit-wallet/EOA keys). Try the other PM_SIGNATURE_TYPE and report.");
  process.exit(1);
});

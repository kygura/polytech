// Builds the offline fixture universe (raw, Gamma/CLOB/Data-shaped JSON) into ../fixtures. Deterministic.
// Run: pnpm --filter @pm/pm fixtures:gen
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";

const NOW = Date.parse("2026-10-15T12:00:00Z");
const DAY = 86_400_000;
const h = (s: string) => createHash("sha256").update(s).digest("hex");
const tokenId = (s: string) => BigInt("0x" + h(s)).toString().slice(0, 77);
let seed = 42;
const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 2 ** 32; };

type Row = {
  k: string; q: string; cat: string; days: number; bid: number; ask: number; ev?: string; evTitle?: string;
  depth?: number; tick?: number; neg?: "uma-id" | "event"; rich?: boolean; dispute?: boolean; closed?: boolean; noOrders?: boolean; extra?: string;
};
const R = (k: string, cat: string, days: number, bid: number, ask: number, q: string, o: Partial<Row> = {}): Row => ({ k, q, cat, days, bid, ask, ...o });

const rows: Row[] = [
  // neg-risk group A (finance): sum asks .87 + fees < 1 -> buy-all arb
  ...[["a1", .03, .04, "Fed cuts rates by 50+ bps at the December 2026 FOMC meeting?"], ["a2", .26, .27, "Fed cuts rates by 25 bps at the December 2026 FOMC meeting?"],
      ["a3", .49, .50, "Fed holds rates at the December 2026 FOMC meeting?"], ["a4", .05, .06, "Fed hikes rates at the December 2026 FOMC meeting?"]]
    .map(([k, b, a, q]) => R(k as string, "finance", 61, b as number, a as number, q as string, { ev: "fed-dec-2026", evTitle: "Fed decision at December 2026 FOMC meeting", neg: "uma-id", rich: true })),
  // neg-risk group B (tech): sum asks 1.03, sum bids .97 -> no arb; no negRiskMarketID (event-id fallback)
  ...[["b1", .39, .41, "Google tops the LMArena text leaderboard on Dec 31, 2026?"], ["b2", .33, .35, "OpenAI tops the LMArena text leaderboard on Dec 31, 2026?"], ["b3", .25, .27, "Anthropic tops the LMArena text leaderboard on Dec 31, 2026?"]]
    .map(([k, b, a, q]) => R(k as string, "tech", 77, b as number, a as number, q as string, { ev: "lmarena-top", evTitle: "Top model on LMArena text leaderboard on Dec 31, 2026", neg: "event" })),
  // neg-risk group C (geopolitics): sum bids 1.02 -> sell-all (reverse) arb
  ...[["c1", .30, .32, "Russia-Ukraine formal ceasefire takes effect before Dec 1, 2026?"], ["c2", .40, .42, "Russia-Ukraine formal ceasefire takes effect between Dec 1, 2026 and Mar 31, 2027?"], ["c3", .32, .34, "Russia-Ukraine formal ceasefire takes effect after Mar 31, 2027 or never?"]]
    .map(([k, b, a, q], i) => R(k as string, "geopolitics", [46, 120, 190][i]!, b as number, a as number, q as string, { ev: "ru-ua-ceasefire", evTitle: "When does a Russia-Ukraine ceasefire take effect?", neg: "uma-id" })),
  // monotonic ladder (crypto): Jan-31 priced .31 > Mar-31 priced .26 -> violation
  R("l1", "crypto", 77, .17, .19, "Will Bitcoin hit $150,000 by December 31, 2026?"),
  R("l2", "crypto", 108, .30, .32, "Will Bitcoin hit $150,000 by January 31, 2027?", { rich: true }),
  R("l3", "crypto", 167, .25, .27, "Will Bitcoin hit $150,000 by March 31, 2027?", { rich: true }),
  // mirror pair (politics): same question, .22 vs .29
  R("m1", "politics", 77, .21, .23, "Will Congress pass the Federal Data Privacy Act before 2027?", { rich: true }),
  R("m2", "politics", 77, .28, .30, "Federal Data Privacy Act signed into law by Dec 31, 2026?", { rich: true }),
  // longshots (p < .07)
  R("s1", "geopolitics", 77, .021, .027, "Will NATO invoke Article 5 before Jan 1, 2027?", { tick: .001, depth: 3000 }),
  R("s2", "tech", 77, .015, .025, "Will Apple announce the acquisition of a frontier AI lab by Dec 31, 2026?", { tick: .001, depth: 3000 }),
  R("s3", "crypto", 77, .03, .04, "Will Ethereum trade above $20,000 by Dec 31, 2026?", { depth: 3000 }),
  R("s4", "sports", 120, .04, .05, "Will the Jacksonville Jaguars win Super Bowl LXI?", { depth: 3000 }),
  // illiquid (depth < $200)
  R("i1", "finance", 28, .12, .19, "Will US CPI YoY for October 2026 print above 3.5%?", { depth: 30 }),
  R("i2", "tech", 77, .34, .44, "Will Nvidia market cap exceed $7T at close on Dec 31, 2026?", { depth: 40 }),
  R("i3", "politics", 19, .55, .66, "Will voter turnout in the 2026 US midterms exceed 50%?", { depth: 25 }),
  R("i4", "crypto", 46, .08, .15, "Will Solana flip BNB in market cap by Nov 30, 2026?", { depth: 35 }),
  // UMA dispute, closed/resolved, not accepting orders
  R("d1", "finance", 1, .88, .91, "Will the Bank of Japan intervene in FX markets before Oct 15, 2026?", { dispute: true, rich: true }),
  R("x1", "sports", 1, .99, 1, "Will the Dodgers win the 2026 World Series?", { closed: true }),
  R("n1", "crypto", 31, .60, .64, "Will a spot Ethereum ETF with staking be approved by Nov 15, 2026?", { noOrders: true }),
  // normal markets
  R("p1", "politics", 19, .60, .61, "Will Republicans win the Senate majority in the 2026 midterms?", { rich: true, depth: 6000 }),
  R("p2", "politics", 46, .22, .24, "Will a US federal government shutdown begin before Dec 1, 2026?"),
  R("p3", "politics", 108, .71, .74, "Will the Supreme Court rule on the tariff case by Jan 31, 2027?"),
  R("f1", "finance", 77, .41, .43, "Will the S&P 500 close above 7,000 on Dec 31, 2026?"),
  R("f2", "finance", 46, .35, .38, "Will gold close above $4,500/oz on Nov 30, 2026?"),
  R("f3", "finance", 77, .29, .32, "Will the US 10-year yield close above 4.5% on Dec 31, 2026?"),
  R("t1", "tech", 77, .33, .36, "Will OpenAI release a new flagship model before Jan 1, 2027?"),
  R("t2", "tech", 77, .14, .17, "Will Tesla run unsupervised robotaxis in 5+ cities by Dec 31, 2026?"),
  R("k1", "crypto", 46, .47, .49, "Will Bitcoin close above $110,000 on Nov 30, 2026?"),
  R("k2", "crypto", 77, .52, .56, "Will a spot Solana ETF be approved by Dec 31, 2026?"),
  R("g1", "geopolitics", 77, .08, .10, "Will Israel and Saudi Arabia announce normalization by Dec 31, 2026?"),
  R("g2", "geopolitics", 77, .55, .58, "Will the EU adopt a 20th Russia sanctions package by Dec 31, 2026?"),
  R("e1", "sports", 200, .17, .18, "Will Real Madrid win the 2026-27 Champions League?"),
  R("e2", "sports", 53, .21, .23, "Will Max Verstappen win the 2026 F1 drivers' championship?"),
];
if (rows.length !== 40) throw new Error(`expected 40 rows, got ${rows.length}`);

const FEE_BPS: Record<string, number> = { politics: 400, finance: 400, tech: 400, crypto: 700, sports: 500, geopolitics: 0 };
const SRC: Record<string, string> = { politics: "official government records", finance: "the official data release", tech: "official company announcements", crypto: "CoinGecko daily close data", geopolitics: "credible reporting from major news agencies", sports: "the official league website" };
const TAG_ID: Record<string, string> = { politics: "2", finance: "120", tech: "1401", crypto: "21", geopolitics: "100265", sports: "1" };
const fmt = (x: number, tick: number) => x.toFixed(tick < 0.01 ? 3 : 2);
const iso = (d: number) => new Date(NOW + d * DAY).toISOString().replace(/\.\d+Z$/, "Z");

const books: Record<string, unknown> = {}, history: Record<string, unknown> = {}, fees: Record<string, number> = {}, holders: Record<string, unknown> = {}, oi: Record<string, number> = {};
const comments: unknown[] = [], trades: unknown[] = [];
const events = new Map<string, any>();
const markets: any[] = [];

function book(tok: string, cond: string, bid: number, ask: number, depth: number, tick: number, neg: boolean) {
  const lv = (p0: number, dir: 1 | -1) => Array.from({ length: 6 }, (_, i) => ({ price: fmt(Math.min(.999, Math.max(.001, p0 + dir * i * tick)), tick), size: (depth * (1 - .12 * i) * (.85 + rnd() * .3)).toFixed(2) }));
  // wire order: worst first, touch last (as in the 3P output)
  books[tok] = { market: cond, asset_id: tok, timestamp: String(NOW), bids: lv(bid, -1).reverse(), asks: lv(ask, 1).reverse(), min_order_size: "5", tick_size: String(tick), neg_risk: neg, hash: h(tok).slice(0, 40) };
}
const wallet = (s: string) => "0x" + h(s).slice(0, 40);

rows.forEach((r, i) => {
  const tick = r.tick ?? .01, depth = r.depth ?? 4000, mid = +((r.bid + r.ask) / 2).toFixed(4);
  const cond = "0x" + h("cond:" + r.k), yes = tokenId("yes:" + r.k), no = tokenId("no:" + r.k);
  const evKey = r.ev ?? "ev-" + r.k, evId = String(90100 + [...events.keys(), evKey].filter((v, j, a) => a.indexOf(v) === j).indexOf(evKey));
  const id = String(530000 + i);
  const neg = !!r.neg;
  const slug = r.q.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60);
  const evLite = { id: evId, slug: r.ev ?? slug, title: r.evTitle ?? r.q, endDate: iso(r.days), negRisk: neg, tags: [{ id: TAG_ID[r.cat], label: r.cat[0]!.toUpperCase() + r.cat.slice(1), slug: r.cat }, { id: String(900 + (i % 7)), label: "Featured", slug: "featured" }] };
  const vol = Math.round(depth * 25 * (1 + rnd()));
  const m: any = {
    id, question: r.q, conditionId: cond, slug,
    description: `This market resolves to "Yes" if the following is true: ${r.q.replace(/\?$/, "")}. Otherwise it resolves to "No". The primary resolution source is ${SRC[r.cat]}; if it is unavailable, consensus of credible reporting is used.`,
    resolutionSource: SRC[r.cat], startDate: iso(-30), endDate: iso(r.days), endDateIso: iso(r.days).slice(0, 10),
    outcomes: '["Yes", "No"]', outcomePrices: JSON.stringify([mid.toFixed(3), (1 - mid).toFixed(3)]),
    clobTokenIds: i % 9 === 5 ? [yes, no] : JSON.stringify([yes, no]), // a few real arrays: both wire forms parse
    volume: i % 2 ? String(vol) : vol, volumeNum: vol, volume24hr: Math.round(vol / 12), liquidity: i % 2 ? String(depth * 3) : depth * 3, liquidityNum: depth * 3,
    lastTradePrice: mid, bestBid: r.bid, bestAsk: r.ask, spread: +(r.ask - r.bid).toFixed(4),
    negRisk: neg, active: !r.closed, closed: !!r.closed, archived: false, acceptingOrders: !r.noOrders && !r.closed, enableOrderBook: true,
    orderPriceMinTickSize: tick, orderMinSize: 5, groupItemTitle: r.ev ? r.q.split(" ")[0] : "", commentCount: r.rich ? 4 : 0,
    events: [evLite],
  };
  if (r.neg === "uma-id") m.negRiskMarketID = "0x" + h("nrm:" + evKey);
  if (r.dispute) m.umaResolutionStatus = "disputed";
  else if (!r.closed) m.umaResolutionStatus = "unresolved";
  if (r.closed) { m.umaResolutionStatus = "resolved"; m.outcomePrices = '["1", "0"]'; }
  markets.push(m);
  const ev = events.get(evKey) ?? events.set(evKey, { ...evLite, ticker: evKey, description: r.evTitle ?? r.q, active: true, closed: !!r.closed, enableNegRisk: neg, volume: 0, markets: [] }).get(evKey);
  ev.markets.push(m);
  ev.volume += vol;

  fees[yes] = fees[no] = FEE_BPS[r.cat]!;
  oi[cond] = Math.round(depth * 6 * (.8 + rnd() * .4));
  if (!r.closed) {
    book(yes, cond, r.bid, r.ask, depth, tick, neg);
    book(no, cond, +(1 - r.ask).toFixed(3), +(1 - r.bid).toFixed(3), depth, tick, neg);
    let p = mid * (.8 + rnd() * .4);
    history[yes] = { history: Array.from({ length: 40 }, (_, j) => { p = Math.min(.98, Math.max(.01, p + (mid - p) * .15 + (rnd() - .5) * .03)); return { t: Math.floor(NOW / 1000) - (39 - j) * 6 * 3600, p: +(j === 39 ? mid : p).toFixed(3) }; }) };
  }
  if (r.rich) {
    const tags = ["thread", "bullish", "bearish"];
    if (!comments.some((c: any) => c.parentEntityID === Number(evId)))
      for (let j = 0; j < 4; j++) comments.push({ id: String(7000 + comments.length), body: [`Priced fair, I'm sitting out. (${tags[j % 3]})`, "Rules say official source only, read the fine print before buying.", "Whales keep lifting the offer here, I'd fade it.", "Dated catalyst is two weeks out, not priced in yet."][j], parentEntityType: "Event", parentEntityID: Number(evId), userAddress: wallet(`c${evId}${j}`), createdAt: new Date(NOW - (j + 1) * 5 * 3600_000).toISOString(), reactionCount: Math.floor(rnd() * 20), profile: { name: `trader${j}`, pseudonym: `Calm-Falcon-${j}` } });
    holders[cond] = [yes, no].map((t, side) => ({ token: t, holders: Array.from({ length: 8 }, (_, j) => ({ proxyWallet: wallet(`h${r.k}${side}${j}`), name: `holder${j}`, amount: Math.round((6000 / (j + 1)) * (.8 + rnd() * .4)), outcomeIndex: side, asset: t })) }));
    for (let j = 0; j < 12; j++) trades.push({ proxyWallet: wallet(`t${r.k}${j}`), side: rnd() > .45 ? "BUY" : "SELL", asset: yes, conditionId: cond, size: +(20 + rnd() * 900).toFixed(1), price: +(mid + (rnd() - .5) * .02).toFixed(3), timestamp: Math.floor(NOW / 1000) - j * 3500, transactionHash: "0x" + h(`tx${r.k}${j}`), title: r.q, outcome: "Yes", outcomeIndex: 0 });
  }
});

const out = new URL("../fixtures/", import.meta.url);
mkdirSync(out, { recursive: true });
const files: Record<string, unknown> = { markets, events: [...events.values()], books, history, fees, comments, holders, oi, trades };
for (const [n, v] of Object.entries(files)) writeFileSync(new URL(`${n}.json`, out), JSON.stringify(v, null, 1) + "\n");
console.log(`fixtures: ${markets.length} markets, ${events.size} events, ${Object.keys(books).length} books`);

// Shared static mock data for the /trade terminal direction mockups. Deterministic (seeded).
(function () {
  let s = 7;
  const r = () => ((s = (s * 16807) % 2147483647) / 2147483647);
  const markets = [
    ["Fed cuts 50+ bps at Dec FOMC?", "finance", 0.412, +1.8, "2.4M", 0.001],
    ["Bitcoin above $110k on Nov 30?", "crypto", 0.520, -0.6, "8.1M", 0.01],
    ["Republicans win Senate 2026?", "politics", 0.605, +0.4, "14.2M", 0.01],
    ["US gov shutdown before Dec 1?", "politics", 0.230, -2.1, "3.3M", 0.001],
    ["ETH above $20k by Dec 31?", "crypto", 0.035, +0.2, "1.1M", 0.001],
    ["Anthropic tops LMArena Dec 31?", "tech", 0.260, +3.4, "920K", 0.01],
    ["Gold above $4,500 on Nov 30?", "finance", 0.365, -0.9, "610K", 0.01],
    ["Russia-Ukraine ceasefire by Dec 1?", "geopolitics", 0.310, +0.0, "5.7M", 0.01],
    ["Spot Solana ETF approved 2026?", "crypto", 0.540, +1.1, "2.0M", 0.01],
    ["Verstappen wins 2026 title?", "sports", 0.220, -0.3, "1.6M", 0.01],
    ["US 10y above 4.5% Dec 31?", "finance", 0.695, +0.7, "480K", 0.01],
    ["Jaguars win Super Bowl LXI?", "sports", 0.045, -0.1, "3.9M", 0.001],
    ["OpenAI flagship before Jan 1?", "tech", 0.345, +5.2, "2.2M", 0.01],
    ["Tesla robotaxi in 5+ cities?", "tech", 0.155, -1.4, "770K", 0.01],
    ["Supreme Court tariff ruling by Jan 31?", "politics", 0.725, +0.2, "1.3M", 0.01],
    ["Fed holds rates at Dec FOMC?", "finance", 0.505, -1.5, "2.4M", 0.001],
  ].map(([q, cat, p, ch, vol, tick]) => ({ q, cat, p, ch, vol, tick }));

  const mid = 0.412, tick = 0.001;
  const asks = [], bids = [];
  for (let i = 0; i < 14; i++) {
    asks.push({ p: +(0.413 + i * tick).toFixed(3), sz: Math.round(400 + r() * 6000) });
    bids.push({ p: +(0.411 - i * tick).toFixed(3), sz: Math.round(400 + r() * 6000) });
  }
  // a couple of walls make the ladder readable
  asks[5].sz = 18400; bids[3].sz = 22150; bids[9].sz = 15020;
  let cum = 0; asks.forEach((a) => (a.cum = cum += a.sz));
  cum = 0; bids.forEach((b) => (b.cum = cum += b.sz));

  const series = [];
  let p = 0.36;
  for (let i = 0; i < 240; i++) {
    p += (r() - 0.48) * 0.006;
    if (i === 150) p += 0.022;
    p = Math.min(0.48, Math.max(0.32, p));
    series.push(+p.toFixed(3));
  }
  series[series.length - 1] = mid;

  const tape = [];
  let t = 14 * 3600 + 32 * 60 + 41;
  for (let i = 0; i < 26; i++) {
    const buy = r() > 0.45;
    tape.push({
      t: new Date(t * 1000).toISOString().slice(11, 19),
      side: buy ? "BUY" : "SELL",
      p: +(mid + (buy ? 0.001 : -0.001) * (r() > 0.7 ? 2 : 1)).toFixed(3),
      sz: Math.round(10 + r() * (r() > 0.85 ? 9000 : 900)),
    });
    t -= Math.round(2 + r() * 40);
  }

  const positions = [
    { q: "Fed cuts 50+ bps at Dec FOMC?", o: "YES", sh: 520, avg: 0.388, mark: 0.412 },
    { q: "US gov shutdown before Dec 1?", o: "NO", sh: 1200, avg: 0.742, mark: 0.770 },
    { q: "Bitcoin above $110k on Nov 30?", o: "YES", sh: 300, avg: 0.561, mark: 0.520 },
  ].map((x) => ({ ...x, pnl: +((x.mark - x.avg) * x.sh).toFixed(2) }));
  const orders = [
    { q: "Fed cuts 50+ bps at Dec FOMC?", side: "BUY", o: "YES", p: 0.405, sz: 800, filled: 0, age: "3m" },
    { q: "Anthropic tops LMArena Dec 31?", side: "SELL", o: "YES", p: 0.290, sz: 250, filled: 90, age: "41m" },
  ];

  window.MOCK = { markets, mid, tick, asks, bids, series, tape, positions, orders, last: 0.412, spread: 0.002 };

  // ?theme=light|dark (or #light) for screenshots; default dark.
  const th = /light/.test(location.search + location.hash) ? "light" : "dark";
  document.documentElement.dataset.theme = th;

  window.fmt = {
    c: (x, d = 1) => (x * 100).toFixed(d), // cents
    n: (x) => x.toLocaleString("en-US"),
    usd: (x) => (x < 0 ? "-$" : "$") + Math.abs(x).toFixed(2),
    k: (x) => (x >= 1000 ? (x / 1000).toFixed(1) + "k" : String(x)),
  };

  // chart path helper: series -> svg path in w x h box, y range lo..hi
  window.pathOf = (arr, w, h, lo, hi) =>
    arr.map((v, i) => `${i ? "L" : "M"}${((i / (arr.length - 1)) * w).toFixed(1)},${(h - ((v - lo) / (hi - lo)) * h).toFixed(1)}`).join("");
})();

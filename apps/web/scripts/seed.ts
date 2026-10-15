// Local demo: fixtures -> sweep -> snapshots -> screen -> 8 fake-runner pods -> L1 -> paper fills. Uses .data/pglite unless DATABASE_URL.
process.env.PM_FIXTURES ??= "1";

async function main() {
  const { fakeJudge, fakeRunner } = await import("@pm/agents");
  const { createPm } = await import("@pm/pm");
  const { deps, sweepUniverse, snapshotBooks, screenAll, researchShortlist, setMode, paperBook, read } = await import("../lib/jobs");
  const d = await deps({ pm: createPm({ fixtures: true }), runner: fakeRunner, judge: fakeJudge }); // never the real runner

  const show = (label: string, v: unknown) => console.log(`${label}:`, JSON.stringify(v));
  show("sweep", await sweepUniverse(d));
  show("snapshots", await snapshotBooks(d, "all"));
  show("screen", await screenAll(d));
  show("research", await researchShortlist(d, { limit: 8 }));
  show("mode", await setMode(d, "L1", "seed"));
  show("paper", await paperBook(d));

  const r = { db: d.db, now: d.now };
  const [small, size, structural, book] = await Promise.all([
    read.watchlist(r, "small-cap"), read.watchlist(r, "size"), read.watchlist(r, "structural"), read.paperBook(r),
  ]);
  const researched = [...small, ...size].filter((w) => w.thesisId);
  console.log(`watchlist small-cap=${small.length} size=${size.length} structural=${structural.length}`);
  console.log(`theses=${researched.length} paper fills=${book.fills.length} open positions=${book.summary.open}`);
  process.exit(0); // PGlite keeps the event loop alive
}
main().catch((e) => { console.error(e); process.exit(1); });

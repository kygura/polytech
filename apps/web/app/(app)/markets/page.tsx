import { parseQuery } from "@pm/core";
import { ScreenerView } from "../../../components/screener/ScreenerView";
import { defaultQuery, pagedQuery, PAGE } from "../../../components/screener/dsl";
import type { SavedView, ScreenerRow } from "../../../components/screener/types";
import { getSettings, read } from "../../../lib/jobs";
import { listMarkets } from "../../../lib/jobs/markets";

const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

export default async function ScreenerPage({ searchParams }: { searchParams: Promise<{ q?: string | string[]; view?: string | string[] }> }) {
  const sp = await searchParams;
  const r = await read.readDeps();
  const [settings, views, snap] = await Promise.all([
    getSettings(r.db),
    // views is small (saved screener views): full scan, ORDER BY name (codepoint order, like the C collation)
    r.db.views.all().then((vs) => vs.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
      .map((v): SavedView => ({ id: v.id, name: v.name, query: v.query, columns: v.columns }))),
    r.db.snapshots.first("byTs", {}, { order: "desc" }).then((x) => x?.ts.getTime() ?? null),
  ]);
  const defaultText = defaultQuery(settings.filters);
  const view = views.find((v) => v.id === first(sp.view));
  const text = first(sp.q) ?? view?.query ?? defaultText;
  const { filter, errors } = parseQuery(text);
  // bad `q` from the URL: no rows, the client bar shows the error line
  const res = errors.length ? { rows: [], total: 0 } : await listMarkets(r.db, filter, r.now(), { limit: pagedQuery(text).paged ? PAGE : undefined });
  return (
    <ScreenerView
      initial={{ text, viewId: view?.id ?? "default", rows: JSON.parse(JSON.stringify(res.rows)) as ScreenerRow[], total: res.total }}
      views={views} defaultText={defaultText} now={r.now()} lastSnapshotAt={snap} />
  );
}

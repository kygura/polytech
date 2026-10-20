import { parseQuery } from "@pm/core";
import { schema as s } from "@pm/db";
import { asc, desc } from "drizzle-orm";
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
    r.db.select({ id: s.views.id, name: s.views.name, query: s.views.query, columns: s.views.columns }).from(s.views).orderBy(asc(s.views.name)) as Promise<SavedView[]>,
    r.db.select({ ts: s.snapshots.ts }).from(s.snapshots).orderBy(desc(s.snapshots.ts)).limit(1).then((x) => x[0]?.ts.getTime() ?? null),
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

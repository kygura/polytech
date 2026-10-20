import { read, terminal } from "../../../lib/jobs";
import { isGroupBy, parseMinN } from "../../../components/journal/journal";
import { JournalView, type Filters } from "./JournalView";

type SP = Partial<Record<"category" | "model" | "sinceDays" | "groupBy" | "minN", string>>;

export default async function JournalPage({ searchParams }: { searchParams: Promise<SP> }) {
  const q = await searchParams;
  const filters: Filters = {
    category: q.category ?? "", model: q.model ?? "", sinceDays: /^\d+$/.test(q.sinceDays ?? "") ? q.sinceDays! : "",
    groupBy: isGroupBy(q.groupBy) ? q.groupBy : "category", minN: parseMinN(q.minN),
  };
  const r = await read.readDeps();
  const [data, all, settings] = await Promise.all([
    terminal.journalView(r, { category: filters.category || undefined, model: filters.model || undefined, days: filters.sinceDays ? Number(filters.sinceDays) : undefined }),
    // unfiltered lists so the selects keep every option once a filter is on
    read.calibration(r),
    read.settingsGet(r),
  ]);
  const models = [...new Set([...Object.keys(all.byModel), ...data.summary.byModel.map((m) => m.key), filters.model].filter(Boolean))].sort();
  const categories = [...new Set([...Object.keys(all.byCategory), ...data.summary.byCategory.map((c) => c.key), filters.category].filter((c) => c && c !== "unknown"))].sort();
  return <JournalView data={data} filters={filters} categories={categories} models={models} extremize={settings.extremize} />;
}

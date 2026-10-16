import { read } from "../../../lib/jobs";
import { CalibrationView, type Filters } from "./CalibrationView";

export default async function CalibrationPage({ searchParams }: { searchParams: Promise<Partial<Filters>> }) {
  const q = await searchParams;
  const filters: Filters = { category: q.category ?? "", model: q.model ?? "", sinceDays: /^\d+$/.test(q.sinceDays ?? "") ? q.sinceDays! : "" };
  const r = await read.readDeps();
  const data = await read.calibration(r, { category: filters.category || undefined, model: filters.model || undefined, sinceDays: filters.sinceDays ? Number(filters.sinceDays) : undefined });
  // byCategory is computed over all rows (full list); byModel over the filtered rows, so keep the selected model listed.
  const models = [...new Set([...Object.keys(data.byModel), filters.model].filter(Boolean))].sort();
  return <CalibrationView data={data} filters={filters} categories={Object.keys(data.byCategory).sort()} models={models} />;
}

import { notFound } from "next/navigation";
import { RunDetail } from "../../../../components/runs/RunDetail";
import { read } from "../../../../lib/jobs";

export default async function RunPage({ params }: { params: Promise<{ podId: string }> }) {
  const { podId } = await params;
  const r = await read.readDeps();
  const d = await read.podDetail(r, podId);
  if (!d) notFound();
  return <RunDetail initial={d} now={r.now()} />;
}

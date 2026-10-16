import Link from "next/link";
import { EmptyState } from "../../../components/EmptyState";
import { currentMode, read } from "../../../lib/jobs";
import { PaperView } from "./PaperView";

export default async function PaperPage() {
  const r = await read.readDeps();
  if ((await currentMode(r.db)) === "L0")
    return <EmptyState text="Paper book is off. Set mode L1 Paper in Autonomy." action={<Link href="/autonomy">Autonomy →</Link>} />;
  return <PaperView data={await read.paperBook(r)} />;
}

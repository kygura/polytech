import Link from "next/link";
import { EmptyState } from "../../../components/EmptyState";
import { currentMode, read } from "../../../lib/jobs";
import { BookView } from "./BookView";
import { PaperView } from "./PaperView";

export default async function BookPage() {
  const r = await read.readDeps();
  const mode = await currentMode(r.db);
  const data = mode === "L0" ? null : await read.paperBook(r);
  return (
    <BookView mode={mode} at={r.now()} paperCount={data?.summary.open}>
      {data ? <PaperView data={data} /> : <EmptyState text="Paper book is off. Set mode L1 Paper in Autonomy." action={<Link href="/autonomy">Autonomy →</Link>} />}
    </BookView>
  );
}

import { currentMode, read } from "../../../lib/jobs";
import { BookView } from "./BookView";
import { PaperView } from "./PaperView";

// Manual paper trades work in every autonomy mode, so the paper book always loads.
export default async function BookPage() {
  const r = await read.readDeps();
  const [mode, data] = await Promise.all([currentMode(r.db), read.paperBook(r)]);
  return (
    <BookView mode={mode} at={r.now()} paperCount={data.summary.open}>
      <PaperView data={data} />
    </BookView>
  );
}

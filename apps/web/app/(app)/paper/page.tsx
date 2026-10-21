import { EmptyState } from "../../../components/EmptyState";
import { LinkButton } from "../../../components/pageParts";
import { Panel } from "../../../components/ui";
import { currentMode, read } from "../../../lib/jobs";
import { BookView } from "./BookView";
import { PaperView } from "./PaperView";

export default async function BookPage() {
  const r = await read.readDeps();
  const mode = await currentMode(r.db);
  const data = mode === "L0" ? null : await read.paperBook(r);
  return (
    <BookView mode={mode} at={r.now()} paperCount={data?.summary.open}>
      {data ? <PaperView data={data} /> : (
        <Panel title="Paper book" label="Paper book">
          <EmptyState text="Paper trading is off. Set mode L1 Paper in Autonomy." action={<LinkButton href="/autonomy">Autonomy {"→"}</LinkButton>} />
        </Panel>
      )}
    </BookView>
  );
}

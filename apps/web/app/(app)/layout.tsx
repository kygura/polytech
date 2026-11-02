import type { ReactNode } from "react";
import { Shell } from "../../components/Shell";
import { currentMode, read } from "../../lib/jobs";

export const dynamic = "force-dynamic";

export default async function AppLayout({ children }: { children: ReactNode }) {
  // currentMode is the same source read.autonomy() uses; skips the gate/exposure work on every nav.
  const r = await read.readDeps();
  const [mode, lastSnapshotAt] = await Promise.all([
    currentMode(r.db),
    r.db.snapshots.first("byTs", {}, { order: "desc" }).then((x) => x?.ts.getTime() ?? null),
  ]);
  return <Shell mode={mode} lastSnapshotAt={lastSnapshotAt} now={r.now()}>{children}</Shell>;
}

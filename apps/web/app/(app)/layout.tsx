import { schema as s } from "@pm/db";
import { desc } from "drizzle-orm";
import type { ReactNode } from "react";
import { Shell } from "../../components/Shell";
import { currentMode, read } from "../../lib/jobs";

export const dynamic = "force-dynamic";

export default async function AppLayout({ children }: { children: ReactNode }) {
  // currentMode is the same source read.autonomy() uses; skips the gate/exposure work on every nav.
  const r = await read.readDeps();
  const [mode, lastSnapshotAt] = await Promise.all([
    currentMode(r.db),
    r.db.select({ ts: s.snapshots.ts }).from(s.snapshots).orderBy(desc(s.snapshots.ts)).limit(1).then((x) => x[0]?.ts.getTime() ?? null),
  ]);
  return <Shell mode={mode} lastSnapshotAt={lastSnapshotAt} now={r.now()}>{children}</Shell>;
}

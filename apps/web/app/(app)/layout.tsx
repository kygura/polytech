import type { ReactNode } from "react";
import { Shell } from "../../components/Shell";
import { currentMode, read } from "../../lib/jobs";

export const dynamic = "force-dynamic";

export default async function AppLayout({ children }: { children: ReactNode }) {
  // currentMode is the same source read.autonomy() uses; skips the gate/exposure work on every nav.
  const mode = await currentMode((await read.readDeps()).db);
  return <Shell mode={mode}>{children}</Shell>;
}

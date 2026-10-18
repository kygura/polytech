import type { ReactNode } from "react";
import { PublicShell } from "../../components/public/PublicShell";

// Anonymous visitor surface (DESIGN 10): no server reads here; pages poll /api/public/*.
export default function PublicLayout({ children }: { children: ReactNode }) {
  return <PublicShell>{children}</PublicShell>;
}

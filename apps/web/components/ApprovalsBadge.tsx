import Link from "next/link";
import type { Recon } from "./live";
import css from "./ui.module.css";

/** Header: `SET ✗ N` while sets are flagged, `RECON ✗` on mismatch, then `N PENDING`; each hidden when there is nothing to say (DESIGN 8.1, 8.4, 9.2). */
export function ApprovalsBadge({ pendingCount, recon, flaggedSets = 0 }: { pendingCount: number; recon: Recon | null | undefined; flaggedSets?: number }) {
  return (
    <>
      {flaggedSets > 0 && (
        <Link href="/autonomy#flagged" className={`${css.mode} ${css.modeSm}`} style={{ color: "var(--neg)", textDecoration: "none" }}
          aria-label={`${flaggedSets} flagged set${flaggedSets === 1 ? "" : "s"} need manual action`}>SET ✗ {flaggedSets}</Link>
      )}
      {recon?.status === "mismatch" && (
        <Link href="/autonomy#approvals" className={`${css.mode} ${css.modeSm}`} style={{ color: "var(--neg)", textDecoration: "none" }} aria-label="Reconciliation mismatch, new orders halted">RECON ✗</Link>
      )}
      {pendingCount > 0 && (
        <Link href="/autonomy#approvals" className={`${css.mode} ${css.modeSm}`} style={{ color: "var(--mode-2)", textDecoration: "none" }}
          aria-label={`${pendingCount} order${pendingCount === 1 ? "" : "s"} waiting for approval`}>{pendingCount} PENDING</Link>
      )}
    </>
  );
}

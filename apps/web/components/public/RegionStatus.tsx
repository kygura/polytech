"use client";
import { useRegion } from "../../hooks/useRegion";
import ui from "../ui.module.css";
import css from "./public.module.css";

/** Text plus dot, never a dot alone. Hidden until something asked for the check (wallet connected or a ticket opened). */
export function RegionStatus() {
  const r = useRegion();
  const where = r.geo && "country" in r.geo ? [r.geo.country, r.geo.region].filter(Boolean).join(" · ") : "";
  switch (r.status) {
    case "idle": return null;
    case "checking": return <span className={`${ui.status} muted`}><span className={ui.spinner} aria-hidden /> checking region</span>;
    case "ok": return <span className={`${ui.status} pos`} title={where || undefined}>{"●"} region ok</span>;
    case "blocked": return <span className={`${ui.status} neg`} role="status" title={where || undefined}>{"●"} trading blocked in your region</span>;
    case "failed":
      return (
        <span className={`${ui.status} warn`} role="status" title="Could not reach Polymarket's region check. Trading stays off.">
          {"●"} region check failed <button type="button" className={css.linkBtn} onClick={r.retry}>Retry</button>
        </span>
      );
  }
}

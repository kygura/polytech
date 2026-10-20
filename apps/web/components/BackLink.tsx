"use client";
import Link from "next/link";
import { useEffect, useState } from "react";

/** DESIGN 12.6.5: back to the list the visitor came from (`/markets` or `/watchlist`), default `/markets`. */
export const backTarget = (referrer: string, origin: string): "/markets" | "/watchlist" => {
  try {
    const u = new URL(referrer);
    return u.origin === origin && /^\/watchlist(\/|$)/.test(u.pathname) ? "/watchlist" : "/markets";
  } catch { return "/markets"; }
};

export function BackLink({ className }: { className?: string }) {
  const [to, setTo] = useState<"/markets" | "/watchlist">("/markets");
  useEffect(() => setTo(backTarget(document.referrer, location.origin)), []);
  return <Link href={to} className={className}>{"←"} Back</Link>;
}

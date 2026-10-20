"use client";
import Link from "next/link";
import { useEffect, useState } from "react";

// DESIGN 12.6.5: back to the list the visitor was last on in this tab (the Shell records it on every navigation), default `/markets`.
export const LISTS = ["/markets", "/watchlist", "/runs", "/journal"] as const;
export type ListPath = (typeof LISTS)[number];
const KEY = "pm.lastList";

/** The list route a pathname is (exactly), else null. */
export const listOf = (path: string): ListPath | null => LISTS.find((l) => l === path) ?? null;
/** Stored value -> back target; anything unknown falls back to the screener. */
export const backTarget = (stored: string | null): ListPath => LISTS.find((l) => l === stored) ?? "/markets";

export function rememberList(path: string) {
  const l = listOf(path);
  if (l) try { sessionStorage.setItem(KEY, l); } catch { /* storage blocked: Back falls back to /markets */ }
}

export function BackLink({ className }: { className?: string }) {
  const [to, setTo] = useState<ListPath>("/markets");
  useEffect(() => { try { setTo(backTarget(sessionStorage.getItem(KEY))); } catch { /* default */ } }, []);
  return <Link href={to} className={className}>{"←"} Back</Link>;
}

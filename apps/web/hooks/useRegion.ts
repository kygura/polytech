"use client";
import { createContext, useCallback, useContext, useRef, useState } from "react";
import { checkGeoblock, type Geo } from "../lib/visitor/geoblock";

export type RegionStatus = "idle" | "checking" | "ok" | "blocked" | "failed";
export type Region = {
  status: RegionStatus;
  geo: Geo | null;
  /** Runs the check once per page session (no-op when already run or running). */
  ensure: () => void;
  retry: () => void;
};

/** Geoblock state for the provider (PublicShell). Fails closed: anything but an explicit "not blocked" disables trading. */
export function useRegionCheck(): Region {
  const [geo, setGeo] = useState<Geo | null>(null);
  const [checking, setChecking] = useState(false);
  const started = useRef(false), busy = useRef(false);

  const retry = useCallback(async () => {
    if (busy.current) return;
    busy.current = started.current = true;
    setChecking(true);
    const g = await checkGeoblock();
    busy.current = false;
    setGeo(g);
    setChecking(false);
  }, []);
  const ensure = useCallback(() => { if (!started.current) void retry(); }, [retry]);

  const status: RegionStatus = checking ? "checking" : !geo ? "idle" : !geo.blocked ? "ok" : geo.reason === "blocked" ? "blocked" : "failed";
  return { status, geo, ensure, retry: () => void retry() };
}

export const RegionContext = createContext<Region | null>(null);

export function useRegion(): Region {
  const r = useContext(RegionContext);
  if (!r) throw new Error("useRegion must be used inside PublicShell");
  return r;
}

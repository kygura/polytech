"use client";
import { useEffect, useState } from "react";

/** DESIGN 12.1.4: `GET /api/session` once on mount; true only for an operator session. Any failure = anonymous. `enabled=false` skips the call. */
export function useOperator(enabled = true) {
  const [operator, setOperator] = useState(false);
  useEffect(() => {
    if (!enabled) return;
    let live = true;
    fetch("/api/session").then((r) => (r.ok ? r.json() : null)).then((j) => { if (live && j?.operator === true) setOperator(true); }).catch(() => {});
    return () => { live = false; };
  }, [enabled]);
  return operator;
}

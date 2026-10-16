"use client";
import { ErrorBar } from "./ErrorBar";

/** Shared `error.tsx` body: ErrorBar with Retry (Next's reset). */
export default function RouteError({ error, reset }: { error: Error; reset: () => void }) {
  return <ErrorBar message={error.message || "Failed to load"} onRetry={reset} />;
}

"use client";
import { ErrorBar } from "../../../components/ErrorBar";

export default function Error({ error, reset }: { error: Error; reset: () => void }) {
  return <ErrorBar message={error.message || "Failed to load watchlist"} onRetry={reset} />;
}

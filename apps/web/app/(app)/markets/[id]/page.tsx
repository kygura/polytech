import { permanentRedirect } from "next/navigation";
import { parseRange } from "../../../../lib/history";

// The market page is /trade/[id] (DESIGN 13.4); old links and bookmarks land there (308), keeping a valid ?range.
export default async function MarketRedirect({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ range?: string | string[] }> }) {
  const [{ id }, sp] = await Promise.all([params, searchParams]);
  const range = parseRange(Array.isArray(sp.range) ? sp.range[0] : sp.range);
  permanentRedirect(`/trade/${encodeURIComponent(id)}${range ? `?range=${range}` : ""}`);
}

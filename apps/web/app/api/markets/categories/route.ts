import { getRead, json } from "../../../../lib/api";
import { topCategories } from "../../../../lib/jobs/markets";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Category chips for the /trade market list: top 8 by active-market count. Empty until the sweep has stored categories. */
export async function GET() {
  return json({ categories: await topCategories((await getRead()).db, 8) });
}

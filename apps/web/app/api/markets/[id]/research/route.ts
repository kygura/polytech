import { after } from "next/server";
import { eq } from "drizzle-orm";
import { schema as s } from "@pm/db";
import { getDeps, json, notFound } from "../../../../../lib/api";
import { researchMarket } from "../../../../../lib/jobs";

export const runtime = "nodejs";
export const maxDuration = 300;

// A pod takes minutes: answer 202 now, run after the response. researchMarket locks per market itself.
export async function POST(_: Request, { params }: { params: Promise<{ id: string }> }) {
  const id = (await params).id, d = await getDeps();
  if (!(await d.db.select({ id: s.markets.conditionId }).from(s.markets).where(eq(s.markets.conditionId, id)))[0]) return notFound();
  after(() => researchMarket(d, id, "manual").catch((e) => console.error("research failed", id, e)));
  return json({ started: true, conditionId: id }, 202);
}

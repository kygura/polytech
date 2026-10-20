import { parseQuery } from "@pm/core";
import { schema as s } from "@pm/db";
import { asc, eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { getRead, json, notFound, parse, parseBody } from "../../../lib/api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const Body = z.object({
  name: z.string().trim().min(1).max(60),
  query: z.string().max(2000),
  columns: z.array(z.string().min(1).max(40)).max(40),
}).strict();

export async function GET() {
  return json(await (await getRead()).db.select().from(s.views).orderBy(asc(s.views.name)));
}

/** Upsert by name. */
export async function POST(req: Request) {
  const b = await parseBody(req, Body);
  if (b.res) return b.res;
  const { errors } = parseQuery(b.data.query);
  if (errors.length) return json({ error: "invalid query", errors }, 400);
  const [row] = await (await getRead()).db.insert(s.views).values({ id: randomUUID(), ...b.data })
    .onConflictDoUpdate({ target: s.views.name, set: { query: b.data.query, columns: b.data.columns } }).returning();
  return json(row);
}

export async function DELETE(req: Request) {
  const id = parse(z.string().min(1).max(100), new URL(req.url).searchParams.get("id"));
  if (id.res) return id.res;
  const rows = await (await getRead()).db.delete(s.views).where(eq(s.views.id, id.data)).returning({ id: s.views.id });
  return rows.length ? json({ ok: true }) : notFound();
}

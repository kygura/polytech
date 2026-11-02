import { parseQuery } from "@pm/core";
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
  // small table: full scan, ORDER BY name (codepoint order, like the C collation)
  return json((await (await getRead()).db.views.all()).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)));
}

/** Upsert by name. */
export async function POST(req: Request) {
  const b = await parseBody(req, Body);
  if (b.res) return b.res;
  const { errors } = parseQuery(b.data.query);
  if (errors.length) return json({ error: "invalid query", errors }, 400);
  // ON CONFLICT (name) DO UPDATE: the unique name keeps one row per name; id and createdAt stay from the existing row
  const row = await (await getRead()).db.views.upsertBy("name", { id: randomUUID(), ...b.data }, { query: b.data.query, columns: b.data.columns });
  return json(row);
}

export async function DELETE(req: Request) {
  const id = parse(z.string().min(1).max(100), new URL(req.url).searchParams.get("id"));
  if (id.res) return id.res;
  const row = await (await getRead()).db.views.delete(id.data);
  return row ? json({ ok: true }) : notFound();
}

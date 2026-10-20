export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// No login: every request is the operator. Kept only because hooks/useOperator.ts still fetches it; delete both together.
export function GET() {
  return Response.json({ operator: true }, { headers: { "cache-control": "no-store" } });
}

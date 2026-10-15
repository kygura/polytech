import { NextResponse } from "next/server";
import { sessionCookie } from "../../../lib/auth";

export function POST() {
  const res = NextResponse.json({ ok: true });
  res.cookies.set(sessionCookie("", 0));
  return res;
}

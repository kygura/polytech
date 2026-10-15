import { subscribe } from "../../../lib/jobs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300; // clients reconnect (EventSource does by itself)

export function GET(req: Request) {
  const enc = new TextEncoder();
  let cleanup = () => {};
  const stream = new ReadableStream({
    start(c) {
      const send = (s: string) => { try { c.enqueue(enc.encode(s)); } catch { cleanup(); } };
      const off = subscribe((e) => send(`event: ${e.type}\ndata: ${JSON.stringify(e.payload)}\n\n`));
      const timer = setInterval(() => send(`event: ping\ndata: ${Date.now()}\n\n`), 15_000);
      cleanup = () => { off(); clearInterval(timer); req.signal.removeEventListener("abort", cleanup); try { c.close(); } catch {} };
      req.signal.addEventListener("abort", cleanup);
      send(": connected\n\n");
    },
    cancel: () => cleanup(),
  });
  return new Response(stream, { headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache, no-transform", Connection: "keep-alive" } });
}

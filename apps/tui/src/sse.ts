import { AuthError } from "./api";

export type SseEvent = { event: string; data: string };

/** Incremental SSE parser: feed text chunks, get complete events (handles chunks split anywhere). */
export function sseParser() {
  let buf = "";
  return (chunk: string): SseEvent[] => {
    buf = (buf + chunk).replace(/\r\n/g, "\n");
    const blocks = buf.split("\n\n");
    buf = blocks.pop()!;
    const out: SseEvent[] = [];
    for (const block of blocks) {
      let event = "message";
      const data: string[] = [];
      for (const line of block.split("\n")) {
        if (line.startsWith("event:")) event = line.slice(6).trim();
        else if (line.startsWith("data:")) data.push(line.slice(5).replace(/^ /, ""));
      }
      if (data.length) out.push({ event, data: data.join("\n") });
    }
    return out;
  };
}

const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((r) => {
    const t = setTimeout(r, ms);
    signal.addEventListener("abort", () => (clearTimeout(t), r()), { once: true });
  });

/** Streams `/api/stream` until aborted; reconnects with exponential backoff (1s..30s). Throws AuthError on 401. */
export async function streamEvents(
  url: string | URL,
  headers: () => Promise<Record<string, string>>,
  onEvent: (e: SseEvent) => void,
  onStatus: (live: boolean) => void,
  signal: AbortSignal,
) {
  let delay = 1000;
  while (!signal.aborted) {
    try {
      const res = await fetch(url, { headers: { ...(await headers()), accept: "text/event-stream" }, signal });
      if (res.status === 401) throw new AuthError("run pm login");
      if (!res.ok || !res.body) throw new Error(`stream ${res.status}`);
      onStatus(true);
      delay = 1000;
      const feed = sseParser(), dec = new TextDecoder();
      for await (const chunk of res.body) for (const e of feed(dec.decode(chunk, { stream: true }))) onEvent(e);
    } catch (e) {
      if (e instanceof AuthError) throw e;
    }
    if (signal.aborted) return;
    onStatus(false);
    await sleep(delay, signal);
    delay = Math.min(delay * 2, 30_000);
  }
}

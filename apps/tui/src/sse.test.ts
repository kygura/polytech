import { expect, it } from "vitest";
import { sseParser } from "./sse";

it("parses events split across chunk boundaries (incl. CRLF and multi-line data)", () => {
  const feed = sseParser();
  const text = ": connected\n\nevent: thesis.created\ndata: {\"a\":1}\n\nevent: ping\r\ndata: 1\r\n\r\ndata: x\ndata: y\n\n";
  const out = [];
  for (let i = 0; i < text.length; i += 3) out.push(...feed(text.slice(i, i + 3)));
  expect(out).toEqual([
    { event: "thesis.created", data: '{"a":1}' },
    { event: "ping", data: "1" },
    { event: "message", data: "x\ny" },
  ]);
  expect(feed("event: partial\ndata: 1")).toEqual([]); // waits for the blank line
  expect(feed("\n\n")).toEqual([{ event: "partial", data: "1" }]);
});

// SSRF-guarded page fetch for the agent's fetch_url tool. Plain ESM, stdlib only: copied verbatim into the Vercel Sandbox
// next to agent-query.mjs. Ported from polyscout (tools/net.ts + untrusted.ts), with the DNS answer pinned at connect time.
import dns from "node:dns";
import { lookup as dnsLookup } from "node:dns/promises";
import http from "node:http";
import https from "node:https";
import { isIP } from "node:net";

export class BlockedUrlError extends Error {
  constructor(message) {
    super(message);
    this.name = "BlockedUrlError";
  }
}

const v4ToInt = (ip) => ip.split(".").reduce((acc, o) => (acc << 8) + Number(o), 0) >>> 0;
const V4_BLOCKED = [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16], ["172.16.0.0", 12], ["192.0.0.0", 24],
  ["192.0.2.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15], ["198.51.100.0", 24], ["203.0.113.0", 24], ["224.0.0.0", 4], ["240.0.0.0", 4],
];
const v4Private = (ip) => {
  const x = v4ToInt(ip);
  return V4_BLOCKED.some(([base, bits]) => x >>> (32 - bits) === v4ToInt(base) >>> (32 - bits));
};

/** 8 hextets of an IPv6 literal (handles ::, embedded IPv4), or null when malformed. */
function v6Hextets(ip) {
  let s = ip.toLowerCase().split("%")[0];
  const v4 = /(\d+\.\d+\.\d+\.\d+)$/.exec(s);
  if (v4) {
    const n = v4ToInt(v4[1]);
    s = s.slice(0, -v4[1].length) + `${(n >>> 16).toString(16)}:${(n & 0xffff).toString(16)}`;
  }
  const [head, tail] = s.split("::");
  const h = head ? head.split(":") : [];
  const t = tail !== undefined ? (tail ? tail.split(":") : []) : [];
  const fill = tail !== undefined ? 8 - h.length - t.length : 0;
  const parts = [...h, ...Array(Math.max(0, fill)).fill("0"), ...t];
  return parts.length === 8 ? parts.map((p) => parseInt(p || "0", 16)) : null;
}
function v6Private(ip) {
  const h = v6Hextets(ip);
  if (!h) return true;
  const [a, b] = h;
  if (h.every((x) => x === 0)) return true; // ::
  if (h.slice(0, 7).every((x) => x === 0) && h[7] === 1) return true; // ::1
  if ((a & 0xfe00) === 0xfc00) return true; // fc00::/7 ULA
  if ((a & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
  if ((a & 0xff00) === 0xff00) return true; // multicast
  if (h.slice(0, 5).every((x) => x === 0) && h[5] === 0xffff) return v4Private(`${h[6] >>> 8}.${h[6] & 255}.${h[7] >>> 8}.${h[7] & 255}`); // ::ffff:0:0/96 IPv4-mapped
  if (h.slice(0, 6).every((x) => x === 0)) return true; // IPv4-compatible
  if (h.slice(0, 4).every((x) => x === 0) && h[4] === 0xffff && h[5] === 0) return true; // IPv4-translated
  if (a === 0x64 && b === 0xff9b) return true; // NAT64
  if (a === 0x2002) return true; // 6to4 (embeds arbitrary IPv4)
  if (a === 0x2001 && (b === 0 || b === 0x0db8)) return true; // Teredo, documentation
  return false;
}

/** Loopback, private, link-local (cloud metadata 169.254.169.254), CGNAT, multicast, reserved, or not an IP at all. */
export function isPrivateAddress(ip) {
  const kind = isIP(ip);
  return kind === 4 ? v4Private(ip) : kind === 6 ? v6Private(ip) : true;
}

const normalizeHost = (h) => h.replace(/^\[|\]$/g, "").replace(/\.+$/, "").toLowerCase();
// Briefs are blind: agents must not read the market they are pricing.
const hostPolicy = (host) => {
  if (/(^|\.)polymarket\.com$/.test(host)) throw new BlockedUrlError(`host not allowed: ${host}`);
};

/** Scheme/port/host checks plus DNS: every resolved address must be public. */
export async function assertPublicUrl(raw, net) {
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new BlockedUrlError(`invalid URL: ${String(raw).slice(0, 200)}`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new BlockedUrlError(`scheme not allowed: ${url.protocol}`);
  if (url.username || url.password) throw new BlockedUrlError("credentials in URL not allowed");
  if (!["", "80", "443"].includes(url.port)) throw new BlockedUrlError(`port not allowed: ${url.port}`);
  const host = normalizeHost(url.hostname);
  if (!host) throw new BlockedUrlError("missing host");
  hostPolicy(host);
  if (host === "localhost" || /\.(localhost|local|internal|home\.arpa)$/.test(host) || (!host.includes(".") && !isIP(host))) throw new BlockedUrlError(`host not allowed: ${host}`);
  const addrs = isIP(host) ? [host] : await net.lookup(host).catch(() => { throw new BlockedUrlError(`cannot resolve ${host}`); });
  if (!addrs.length || addrs.some(isPrivateAddress)) throw new BlockedUrlError(`host resolves to a private/reserved address: ${host}`);
  return url;
}

// Connect-time check: the address the socket dials is the one vetted here, so DNS rebinding between check and connect cannot win.
const guardedLookup = (host, opts, cb) =>
  dns.lookup(host, { all: true, verbatim: true }, (err, addrs) => {
    if (err) return cb(err);
    if (!addrs.length || addrs.some((a) => isPrivateAddress(a.address))) return cb(new BlockedUrlError(`host resolves to a private/reserved address: ${host}`));
    return opts?.all ? cb(null, addrs) : cb(null, addrs[0].address, addrs[0].family);
  });

/** Network seam so tests run offline. `get` resolves to { status, location, contentType, body (async iterable of bytes), destroy() }. */
export const realNet = {
  lookup: async (host) => (await dnsLookup(host, { all: true, verbatim: true })).map((a) => a.address),
  get: (url, { signal }) =>
    new Promise((resolve, reject) => {
      const req = (url.protocol === "https:" ? https : http).get(
        url,
        { lookup: guardedLookup, signal, headers: { "user-agent": "polytech-research/1.0 (+public sources only)", accept: "text/html,text/plain;q=0.9,application/json;q=0.8,*/*;q=0.1", "accept-encoding": "identity" } },
        (res) => resolve({ status: res.statusCode ?? 0, location: res.headers.location, contentType: res.headers["content-type"] ?? "", body: res, destroy: () => res.destroy() }),
      );
      req.on("error", reject);
    }),
};

/** GET a public http(s) URL: SSRF check on every redirect hop, time cap, byte cap. Returns { url, status, contentType, text, truncated }. */
export async function safeFetch(raw, net = realNet, { maxBytes = 1_000_000, timeoutMs = 15_000, maxRedirects = 5, signal } = {}) {
  const sig = signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs);
  let current = raw;
  for (let hop = 0; hop <= maxRedirects; hop++) {
    const url = await assertPublicUrl(current, net);
    const res = await net.get(url, { signal: sig });
    if (res.status >= 300 && res.status < 400 && res.location) {
      res.destroy();
      current = new URL(res.location, url).toString();
      continue;
    }
    const chunks = [];
    let size = 0, truncated = false;
    try {
      for await (const c of res.body) {
        if (size + c.byteLength > maxBytes) {
          chunks.push(c.subarray(0, maxBytes - size));
          size = maxBytes;
          truncated = true;
          break;
        }
        chunks.push(c);
        size += c.byteLength;
      }
    } finally {
      res.destroy();
    }
    return { url: url.toString(), status: res.status, contentType: res.contentType, text: Buffer.concat(chunks).toString("utf8"), truncated };
  }
  throw new BlockedUrlError("too many redirects");
}

const attr = (s) => s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;").slice(0, 500);
/** Wrap tool output as untrusted data. Every `<` in the body is escaped, so no variant of the closing tag can break out. */
export const wrapUntrusted = (source, body) => `<untrusted_content source="${attr(source)}">\n${body.replace(/</g, "&lt;")}\n</untrusted_content>`;

const cp = (n) => (Number.isInteger(n) && n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : " ");
const ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };
/** Minimal HTML -> readable text: drops script/style/etc, keeps block boundaries as newlines. */
export function htmlToText(html) {
  return html
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(script|style|noscript|svg|template|iframe|head)\b[\s\S]*?<\/\1\s*>/gi, " ")
    .replace(/<(br|\/p|\/div|\/li|\/tr|\/h[1-6]|\/section|\/article|\/table|hr)\b[^>]*>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+\d*);/gi, (m, e) => {
      const k = e.toLowerCase();
      return k.startsWith("#x") ? cp(parseInt(k.slice(2), 16)) : k.startsWith("#") ? cp(Number(k.slice(1))) : ENTITIES[k] ?? m;
    })
    .replace(/[ \t\f\v\r]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** The fetch_url tool body: guarded fetch -> text -> `<untrusted_content>`. Throws BlockedUrlError / network errors / Error("HTTP n"). */
export async function fetchUrlText(url, { net = realNet, signal, maxChars = 20_000 } = {}) {
  const r = await safeFetch(url, net, { signal });
  if (r.status >= 400) throw new Error(`HTTP ${r.status}`);
  const ct = r.contentType.toLowerCase();
  if (ct && !/^(text\/|application\/(json|xml|xhtml))/.test(ct)) throw new Error(`unsupported content type: ${ct.split(";")[0]}`);
  const text = ct.includes("html") || !ct ? htmlToText(r.text) : r.text;
  const cut = text.length > maxChars || r.truncated;
  return wrapUntrusted(r.url, text.slice(0, maxChars) + (cut ? "\n[truncated]" : ""));
}

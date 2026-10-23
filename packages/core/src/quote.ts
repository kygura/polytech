// Quote check: does an analyst's verbatim quote actually appear in the page text its runner fetched for that url?

/** Text an agent's runner actually read: a fetched page, or a search result / cited passage. */
export type Page = { url: string; text: string };
/** found: in the fetched text; not_found: the page was read and the quote is not in it; unfetched: no text for that url. */
export type QuoteCheck = "found" | "not_found" | "unfetched";

/** Url identity for matching: fragment, trailing slash, `www.` and case ignored. */
export const urlKey = (u: string) => u.trim().replace(/#.*$/, "").replace(/\/+$/, "").replace(/^(https?:\/\/)www\./i, "$1").toLowerCase();

/** Case, curly quotes, dashes, punctuation and whitespace ignored: models re-type punctuation; the words must match. */
const norm = (s: string) => s.normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}%$.]+/gu, " ").replace(/\s+/g, " ").trim();

/** Every fragment of the quote (split on ellipses) must appear in one page fetched for the url. */
export function checkQuote(quote: string, url: string, pages: readonly Page[]): QuoteCheck {
  const k = urlKey(url), texts = pages.filter((p) => urlKey(p.url) === k).map((p) => norm(p.text));
  if (!texts.length) return "unfetched";
  const parts = quote.split(/\[?(?:\.\.\.|…)\]?/).map(norm).filter((p) => p.length >= 3);
  if (!parts.length) return "not_found";
  return texts.some((t) => parts.every((p) => t.includes(p))) ? "found" : "not_found";
}

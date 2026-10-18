"use client";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { Drawer } from "./Drawer";
import { Field } from "./Field";
import { fmt } from "./fmt";
import ui from "./ui.module.css";

type Hit = { id: string; question: string; price: number | null; liquidity: number | null; endDate: string | null };

/** Find a live Polymarket market by name (or pasted polymarket.com URL): pick -> upsert -> start the research pod -> open the market page. */
export function MarketSearch({ open, onClose }: { open: boolean; onClose: () => void }) {
  const router = useRouter();
  const [q, setQ] = useState("");
  const [hits, setHits] = useState<Hit[]>([]);
  const [sel, setSel] = useState(0);
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => { if (open) { setQ(""); setHits([]); setSel(0); setMsg(null); setBusy(false); setTimeout(() => input.current?.focus(), 0); } }, [open]);

  useEffect(() => {
    setHits([]); setSel(0); // a stale hit must never be pickable for newer text
    const term = q.trim();
    if (term.length < 2) { setHits([]); setMsg(null); return; }
    const ac = new AbortController();
    const t = setTimeout(async () => {
      setMsg("Searching…");
      try {
        const r = await fetch(`/api/markets/search?q=${encodeURIComponent(term)}`, { signal: ac.signal });
        if (!r.ok) { setHits([]); setMsg(r.status === 502 ? "Polymarket search is unavailable, try again." : `Search failed: ${r.status}`); return; }
        const j: Hit[] = await r.json();
        setHits(j); setSel(0); setMsg(j.length ? null : "No open markets match.");
      } catch (e) { if ((e as Error).name !== "AbortError") setMsg("Search failed: network error"); }
    }, 300);
    return () => { clearTimeout(t); ac.abort(); };
  }, [q]);

  const pick = async (h: Hit) => {
    if (busy) return;
    setBusy(true); setMsg("Adding market…");
    try {
      const r = await fetch("/api/markets/ingest", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id: h.id }) });
      const j = await r.json().catch(() => null);
      if (!r.ok) { setMsg(`Failed: ${j?.error ?? r.status}`); setBusy(false); return; }
      if (!j.hasBook) { setMsg("Market added, but it has no order book yet, so research was not started."); setBusy(false); return; }
      const rr = await fetch(`/api/markets/${j.conditionId}/research`, { method: "POST" }).catch(() => null);
      if (!rr || rr.status !== 202) {
        const e = await rr?.json().catch(() => null);
        setMsg(`Market added, research not started: ${e?.error ?? (rr ? rr.status : "network error")}`);
        setBusy(false);
        return;
      }
      onClose();
      router.push(`/markets/${j.conditionId}`);
    } catch { setMsg("Failed: network error"); setBusy(false); }
  };

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") { e.preventDefault(); if (hits.length) setSel((s) => (s + (e.key === "ArrowDown" ? 1 : hits.length - 1)) % hits.length); }
    else if (e.key === "Enter" && hits[sel]) { e.preventDefault(); void pick(hits[sel]!); }
  };

  return (
    <Drawer open={open} title="Find market" onClose={onClose}>
      <div className={ui.grid2}>
        <Field label="market" htmlFor="market-search">
          <input
            id="market-search" ref={input} type="search" className={`${ui.filter} ${ui.search}`} placeholder="name or polymarket.com link, e.g. fed rate cut"
            role="combobox" aria-expanded={hits.length > 0} aria-controls="market-hits" aria-autocomplete="list"
            aria-activedescendant={hits[sel] ? `hit-${hits[sel]!.id}` : undefined}
            value={q} maxLength={100} onChange={(e) => setQ(e.target.value)} onKeyDown={onKey}
          />
        </Field>
      </div>
      <p className={`ui muted ${ui.searchMsg}`} role="status">{msg}</p>
      <ul id="market-hits" role="listbox" aria-label="matching markets" className={ui.hits}>
        {hits.map((h, i) => (
          <li key={h.id} id={`hit-${h.id}`} role="option" aria-selected={i === sel} className={ui.hit} onMouseEnter={() => setSel(i)} onClick={() => void pick(h)}>
            <span>{h.question}</span>
            <span className="ui muted">yes {fmt(h.price, "p")} · liq ${fmt(h.liquidity, "usd")} · ends {h.endDate?.slice(0, 10) ?? "—"}</span>
          </li>
        ))}
      </ul>
      <p className="ui muted">Enter adds the market and starts research · ↑↓ move · Esc closes</p>
    </Drawer>
  );
}

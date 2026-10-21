"use client";
import Link from "next/link";
import { useState, type ReactNode } from "react";
import type { Clob } from "../../hooks/useClob";
import { usePoll } from "../../hooks/usePoll";
import { AgentEstimates } from "../AgentEstimates";
import { CatalystList } from "../CatalystList";
import type { Detail } from "../detail";
import { EvidenceTable } from "../EvidenceTable";
import { hm } from "../fmt";
import { KillCriteriaList } from "../KillCriteriaList";
import type { Proposal } from "../live";
import { MetricsGrid } from "../MetricsGrid";
import { ResearchRunning } from "../ResearchRunning";
import { SlippagePane } from "../SlippagePane";
import { ThesisPane } from "../ThesisPane";
import { Button, EmptyState, ErrorBar, Panel, Skeleton, Tabs, type TabItem } from "../ui";
import { AccountBody, accountCounts, type TokenInfo } from "./AccountPane";
import { cents, sh, usd } from "./book";
import css from "./terminal.module.css";

export type BottomTab = "research" | "positions" | "orders" | "rules";
export const TAB_IDS: readonly BottomTab[] = ["research", "positions", "orders", "rules"];
export const TAB_KEY = "pm.trade.tab";
export const isTab = (v: unknown): v is BottomTab => typeof v === "string" && (TAB_IDS as readonly string[]).includes(v);
const PANEL = "bt-panel";

type Props = {
  tab: BottomTab; onTab: (t: BottomTab) => void; expanded: boolean; onExpand: () => void;
  id: string | null; detail: Detail | null; detailError: boolean; onRetry: () => void; now: number;
  clob: Clob; connected: boolean; tokens: Map<string, TokenInfo>; mark: (tokenId: string) => number | null; tick: number;
  /** YES display price (mid, or last trade on a wide book): the paper rows' mark. */
  yes: number | null; researchDisabled: boolean; onResearch: () => void;
  /** Why the last research start was refused, in plain words. */
  researchNote: string | null;
  /** Live analyst progress of the running pod, when known. */
  progress: { done: number; total: number } | null;
  /** Paper trading mode: paper rows first. */
  paperMode: boolean;
};

/** Research · Positions · Orders · Rules (DESIGN 13.4 BottomTabs). Keys 1–4, `e` expands the pane over the chart. */
export function BottomTabs(p: Props) {
  const n = accountCounts(p.clob, p.connected);
  const paperN = p.detail?.positions.filter((x) => x.closedAt == null).length ?? 0;
  const posN = n.positions == null && !paperN ? undefined : (n.positions ?? 0) + paperN;
  const items: TabItem[] = [
    { id: "research", label: "Research", kbd: "1" }, { id: "positions", label: "Positions", count: posN, kbd: "2" },
    { id: "orders", label: "Orders", count: n.orders, kbd: "3" }, { id: "rules", label: "Rules", kbd: "4" },
  ];
  return (
    <Panel className={css.bottom} label="Market tabs"
      title={<Tabs items={items} active={p.tab} onChange={(t) => p.onTab(t as BottomTab)} panelId={PANEL} label="Market tabs" />}
      right={<Button variant="ghost" size="sm" onClick={p.onExpand} aria-pressed={p.expanded} title={p.expanded ? "Restore (e)" : "Expand over the chart (e)"}>{p.expanded ? "⤡ Restore" : "⤢"}<kbd>e</kbd></Button>}>
      <div role="tabpanel" id={PANEL} aria-labelledby={`${PANEL}-tab-${p.tab}`} className={css.tabBody}>
        {p.tab === "research" ? <ResearchTab {...p} />
          : p.tab === "rules" ? <RulesTab detail={p.detail} />
          : p.tab === "positions" ? <PositionsTab {...p} />
          : <OrdersTab {...p} />}
      </div>
    </Panel>
  );
}

function Loading({ error, onRetry }: { error: boolean; onRetry: () => void }) {
  return error ? <ErrorBar message="Could not load this market's research. Retrying…" onRetry={onRetry} /> : <div className={css.skBox} role="status" aria-label="Loading"><Skeleton rows={5} /></div>;
}

function ResearchTab({ detail: d, detailError, onRetry, now, id, researchDisabled, onResearch, researchNote, progress }: Props) {
  if (!d) return <Loading error={detailError} onRetry={onRetry} />;
  const running = d.pod?.status === "running" ? d.pod : null;
  const t = d.thesis, l = d.latest;
  return (
    <div className={css.research}>
      {running && <div className={css.runBanner}><ResearchRunning done={progress?.done} total={progress?.total} elapsedS={Math.max(0, (now - running.startedAt) / 1000)} /></div>}
      {!t ? (
        <EmptyState text={researchDisabled ? "No research yet. Research is off on this server: ANTHROPIC_API_KEY is not set." : "No research yet. 5 AI analysts read the rules and sources, then a judge sets a fair value (~3 min)."}
          action={!researchDisabled && !running && id ? <Button variant="primary" size="sm" onClick={onResearch}>Research<kbd>r</kbd></Button> : undefined} />
      ) : null}
      {researchNote && <p className={`${css.line} ${css.neg}`} role="alert">{researchNote}</p>}
      <div className={css.rRow1}>
        <div className={css.rSpan}><ThesisPane thesis={t} now={now} /></div>
        <AgentEstimates agents={d.agents} />
      </div>
      <div className={css.rRow2}>
        <KillCriteriaList items={t?.killCriteria ?? []} />
        <CatalystList items={t?.catalysts ?? []} now={now} />
        <Panel title="Metrics"><MetricsGrid latest={l} market={d.market} oi={d.snapshot?.oi ?? null} now={now} /></Panel>
        {t && t.sizeUsd > 0 && id && <SlippagePane conditionId={id} snapshot={d.snapshot && { ts: d.snapshot.ts, bids: d.snapshot.bids, asks: d.snapshot.asks }} defaultSide={t.side} />}
      </div>
      <Panel title={`Evidence (${d.evidence.length})`}><EvidenceTable evidence={d.evidence} /></Panel>
    </div>
  );
}

function PositionsTab({ clob, connected, id, tokens, mark, tick, detail: d, yes, paperMode }: Props) {
  const paper = d?.positions.filter((x) => x.closedAt == null) ?? [];
  const yesTok = d?.market.yesTokenId;
  const live = <AccountBody clob={clob} connected={connected} view="positions" currentId={id} tokens={tokens} mark={mark} tick={tick} />;
  const rows = paper.length ? (
    <table aria-label="paper positions">
      <thead><tr><th>Outcome</th><th>Shares</th><th title="What you paid per share, fees included">Avg cost</th><th title="What a share trades at now">Price now</th><th title="Shares × (price now − avg cost)">Unrealized</th><th>Realized</th><th>Opened</th></tr></thead>
      <tbody>
        {paper.map((x) => {
          const o = x.tokenId === yesTok ? "YES" : "NO", m = yes == null ? null : o === "YES" ? yes : 1 - yes, u = m == null ? null : x.size * (m - x.avgCost);
          return (
            <tr key={x.id}>
              <td><span className={`${css.tag} ${o === "YES" ? css.yes : css.no}`}>{o}</span></td><td>{sh(x.size)}</td><td>{cents(x.avgCost, tick)}{"¢"}</td>
              <td>{m == null ? "—" : `${cents(m, tick)}¢`}</td>
              <td className={u == null ? css.dim : u > 0 ? css.up : u < 0 ? css.down : css.dim}>{u == null ? "—" : `${u >= 0 ? "+" : "−"}${usd(Math.abs(u))}`}</td>
              <td className={x.realizedPnl > 0 ? css.up : x.realizedPnl < 0 ? css.down : css.dim}>{usd(x.realizedPnl)}</td><td>{hm(x.openedAt)}</td>
            </tr>
          );
        })}
      </tbody>
    </table>
  ) : <p className={`${css.line} ${css.msg}`}>No paper positions in this market. Paper orders from the ticket show up here.</p>;
  const paperHead = <div className={css.divider} title="Filled against the real order book, no real money">Paper</div>;
  return paperMode
    ? <>{paperHead}{rows}<div className={css.divider}>Live (wallet)</div>{live}</>
    : <>{live}{paper.length > 0 && <>{paperHead}{rows}</>}</>;
}

function OrdersTab({ clob, connected, id, tokens, mark, tick }: Props) {
  const pr = usePoll<{ pending: Proposal[] }>("/api/proposals", 30_000);
  const mine = (pr.data?.pending ?? []).filter((x) => x.conditionId === id);
  return (
    <>
      <AccountBody clob={clob} connected={connected} view="orders" currentId={id} tokens={tokens} mark={mark} tick={tick} />
      {mine.length > 0 && (
        <>
          <div className={css.divider}>Pending approvals ({mine.length}) {"·"} <Link href="/autonomy#approvals">decide in Autonomy {"→"}</Link></div>
          <table aria-label="pending approvals for this market">
            <thead><tr><th>Outcome</th><th>Side</th><th>Shares</th><th>Limit</th><th>Cost</th><th>Expires</th></tr></thead>
            <tbody>
              {mine.map((x) => (
                <tr key={x.id}>
                  <td><span className={`${css.tag} ${x.side === "YES" ? css.yes : css.no}`}>{x.side}</span></td><td className={x.orderSide === "BUY" ? css.up : css.down}>{x.orderSide}</td>
                  <td>{sh(x.shares)}</td><td>{cents(x.limitPrice, tick)}{"¢"}</td><td>{usd(x.costUsd)}</td><td>{hm(x.expiresAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </>
  );
}

function Copy({ text, label }: { text: string; label: string }) {
  const [done, setDone] = useState(false);
  return (
    <Button variant="ghost" size="sm" aria-label={`Copy ${label}`} onClick={() => { try { void navigator.clipboard.writeText(text).then(() => { setDone(true); setTimeout(() => setDone(false), 1500); }); } catch { /* clipboard is optional */ } }}>
      {done ? "Copied" : "Copy"}
    </Button>
  );
}

function Id({ label, value }: { label: string; value: string | null | undefined }): ReactNode {
  return (
    <div className={css.idRow}>
      <dt>{label}</dt>
      <dd>{value ? <><code title={value}>{value}</code><Copy text={value} label={label} /></> : <span className="muted">{"—"}</span>}</dd>
    </div>
  );
}

function RulesTab({ detail: d }: { detail: Detail | null }) {
  if (!d) return <div className={css.skBox} role="status" aria-label="Loading"><Skeleton rows={5} /></div>;
  const m = d.market;
  return (
    <div className={css.rules}>
      <p className={css.rulesText}>{m.rules || "No rules text available for this market."}</p>
      <dl className={css.ids}>
        <div className={css.idRow}><dt>Resolution source</dt><dd className="ui">{m.resolutionSource ?? "—"}</dd></div>
        <Id label="YES token" value={m.yesTokenId} />
        <Id label="NO token" value={m.noTokenId} />
        <Id label="Condition" value={m.conditionId} />
        <Id label="Event" value={m.eventId} />
        {m.negRiskGroup && <Id label="Neg-risk group" value={m.negRiskGroup} />}
      </dl>
    </div>
  );
}

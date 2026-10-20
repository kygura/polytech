# DESIGN — Polymarket Edge Engine (web + TUI)

Scope: phases 1–5. One operator. Dense, calm, numeric-first. Dark default, light available. Not a SaaS dashboard: no cards with shadows, no hero numbers, no illustrations. Everything is a table or a pane with a one-line header.

Stack decisions: Next.js App Router, CSS variables in one `globals.css` + CSS modules per component. No UI kit. Charts are inline SVG components (no chart lib; the three charts needed are simple enough). Numbers always in the mono font with `font-variant-numeric: tabular-nums`.

## 1. Design tokens

All tokens live in `apps/web/app/globals.css` under `:root` (dark) and `:root[data-theme="light"]`. Theme toggle in Settings writes `data-theme` on `<html>` and `localStorage.theme`; default follows `prefers-color-scheme` only when no stored value.

### Color (dark / light)

| Token | Dark | Light | Use |
|---|---|---|---|
| `--bg` | `#0b0d10` | `#f6f7f8` | page |
| `--surface` | `#12151a` | `#ffffff` | panes, table body |
| `--surface-2` | `#1a1e25` | `#eef0f3` | table header, hover row, inputs |
| `--border` | `#262b33` | `#d6dae0` | 1px rules |
| `--text` | `#e6e8eb` | `#15181c` | primary |
| `--muted` | `#8a919c` | `#5f6773` | labels, secondary |
| `--faint` | `#4b525c` | `#9aa1ab` | disabled, gridlines |
| `--pos` | `#3ecf8e` | `#0f8a5f` | positive edge, YES side, up |
| `--neg` | `#f0616d` | `#c6333f` | negative edge, NO side, down |
| `--warn` | `#f5b544` | `#b06f00` | stale, caution |
| `--accent` | `#6ea8fe` | `#2563eb` | links, focus ring, selected row bar |
| `--mode-0` | `#8a919c` | `#5f6773` | L0 Observe (grey) |
| `--mode-1` | `#6ea8fe` | `#2563eb` | L1 Paper (blue) |
| `--mode-2` | `#f5b544` | `#b06f00` | L2 Approve (amber) |
| `--mode-3` | `#f58a44` | `#c2410c` | L3 Bounded (orange) |
| `--mode-4` | `#f0616d` | `#c6333f` | L4 Full (red) |
| `--kill` | `#ff3b3b` | `#d00000` | kill switch button bg |

Contrast: every text/bg pair above is ≥ 4.5:1 (checked: `--muted` on `--surface` dark = 5.1:1, light = 5.4:1). `--faint` is decorative only, never for text that carries meaning.

### Type

- `--font-mono`: `"JetBrains Mono", "SF Mono", ui-monospace, Menlo, monospace` — all numbers, tickers, ids, table cells, TUI-like panes.
- `--font-ui`: `Inter, system-ui, sans-serif` — nav, labels, prose (thesis text).
- Scale (px / line-height): `--fs-xs 11/14`, `--fs-sm 12/16`, `--fs-md 13/18` (default body and table cells), `--fs-lg 15/20` (pane titles), `--fs-xl 20/24` (only the mode badge in header and login title). Nothing larger.
- Weights: 400 default, 600 for headers and selected states. No 700.

### Spacing, radius, misc

- `--sp-1 4px`, `--sp-2 8px`, `--sp-3 12px`, `--sp-4 16px`, `--sp-6 24px`. Table cell padding `4px 8px`. Pane padding `12px`.
- `--radius 3px` everywhere (buttons, inputs, badges). No pills, no 8px+ radii.
- Row height 26px. Header row 28px sticky.
- Focus ring: `outline: 2px solid var(--accent); outline-offset: 1px` on every focusable and on the keyboard-selected table row.
- Transitions: none except 120ms on hover bg. No animations beyond a 1s blink for the SSE "reconnecting" dot and a spinner for research-running.

## 2. Global layout (web)

```
┌ header 40px ──────────────────────────────────────────────────────────────┐
│ PM-EDGE  Watchlist Fleet Calibration Paper Autonomy Settings   ● live  [L1 PAPER]  [■ KILL SWITCH] │
├────────────────────────────────────────────────────────────────────────────┤
│ view content, max-width none, padding 12px, scrolls                        │
└────────────────────────────────────────────────────────────────────────────┘
```

- Header: fixed, `--surface`, bottom border. Left: wordmark `PM-EDGE` (mono, 600) then nav links (ui font, `--muted`, active = `--text` with 2px bottom border `--accent`). Right, in order: `SseIndicator`, `ModeBadge` (current global mode, `--fs-xl` mono, e.g. `L1 PAPER`), `KillSwitchButton`.
- `KillSwitchButton`: always visible, bg `--kill`, white text, label `KILL SWITCH → L0`. One click fires `POST /api/autonomy/kill`. No confirm dialog (SPEC: one action). Instead: label states the effect, the button has `aria-label="Kill switch: drop to L0 and cancel all open orders, immediate, no undo"`, and after click it shows `KILLED · L0` disabled for 3s then returns. At L0 the button is still present but reads `AT L0 · CANCEL OPEN` (still cancels orders).
- `SseIndicator`: dot + text. `● live` (`--pos`), `● reconnecting` (`--warn`, blinking), `● offline` (`--neg`). Tooltip shows last event timestamp.
- Nav routes: `/watchlist`, `/fleet`, `/calibration`, `/paper`, `/autonomy`, `/settings`, `/m/[conditionId]` (detail), `/login`.
- No sidebar. No breadcrumbs; detail view has a `← Watchlist` link at top-left.

Keyboard (web, global, ignored while an input is focused):
`g w` watchlist, `g f` fleet, `g c` calibration, `g p` paper, `g a` autonomy, `g s` settings, `/` focus filter input, `Esc` blur/close, `?` shortcut sheet, `t` toggle theme. Implement in one `useGlobalKeys` hook in the root layout.

## 3. Views

### 3.1 Login `/login`

Centered 320px box on `--bg`. Title `PM-EDGE` (`--fs-xl` mono). One password input (`type=password`, autofocus), one button `Sign in`. Error line under input in `--neg`: `Wrong password` or `Too many attempts, wait 15 min` (429). No logo, no marketing copy.

### 3.2 Watchlist `/watchlist`

Top bar: `Tabs` [`Small-cap` `Size` `Structural`] with row counts; right side: `FilterInput` (placeholder `filter question / category`, `/` focuses), `StaleBanner` slot, last-sweep time `swept 14:32:05`.

`DataTable` columns for small-cap and size tabs, in this order (header label · field · align · format):

| # | Header | Field | Fmt |
|---|---|---|---|
| 1 | `#` | rank | int |
| 2 | `Market` | question (truncate 56ch, title attr full) + category tag | text |
| 3 | `Side` | side | `YES`/`NO` colored pos/neg |
| 4 | `p_mid` | p_mid | `0.000` |
| 5 | `p̂` | p_hat | `0.000` |
| 6 | `p_post` | p_post | `0.000` |
| 7 | `Edge¢` | edge_c | `EdgeBadge` signed `+3.4` |
| 8 | `Size$` | size_usd | `1,250` |
| 9 | `E[P]$` | expected_profit_usd | `+42.1` signed |
| 10 | `r_ann` | r_ann | `%` capped `500%+` |
| 11 | `Payoff` | payoff | `0.00×` |
| 12 | `Days` | days_left | int |
| 13 | `Catalyst` | next_catalyst | `MM-DD label` truncate 24ch |
| 14 | `c` | c (confidence) | `0.00`, `--warn` if disagreement cap tripped (`≤0.5*`) |

Structural tab columns: `#`, `Market`, `Type` (`neg-risk-sum` / `ladder` / `mirror`), `Legs` (count), `Σ asks` or `Σ bids`, `Locked¢` (`EdgeBadge`), `Size$`, `Days`. No thesis columns.

Behavior:
- Default sort: rank asc. Click header toggles; sortable columns per SPEC at minimum: rank, Edge¢, r_ann, Days. Sort indicator `▲/▼` in header. Sorting is client-side on the loaded list (lists are ≤ 100 rows).
- Filter: substring match on question + category, case-insensitive, client-side.
- Row click or `Enter` → `/m/[conditionId]`. `j`/`k` move selection, `Enter` opens, `p` pin, `m` mute, `r` re-research on selected row. Selected row has a 2px left bar `--accent` and `--surface-2` bg.
- Pinned rows: `📌`-free; use a `--accent` dot before `#`. Muted rows hidden by default, `show muted` checkbox at the bar.
- Numbers right-aligned, mono, tabular. Text left-aligned.
- Row age: if the thesis is > 72h old, `p̂` cell gets `--muted` and title `thesis 80h old`.

### 3.3 Market detail `/m/[conditionId]`

Two-column grid: left 60%, right 40%. Stacks to one column under 1100px.

Left column, top to bottom:
1. `MarketHeader`: question (ui font, `--fs-lg`), category tag, end date, days left, fee rate, `Open on Polymarket ↗`. Second line: `KeyStats` strip: `mid 0.412 · bid 0.40 · ask 0.42 · depth5¢ $1,840 · vol24h $12k · OI $45k · top10 61%`.
2. `ActionBar`: buttons `Re-research` (`r`), `Pin` (`p`, toggles to `Unpin`), `Mute` (`m`). Re-research disables while a pod is running and shows `ResearchRunning` inline.
3. `PriceHistoryChart` (SVG, 100% × 180px): mid price line over the stored snapshot history, y 0–1 with gridlines at .25 steps, x time. Thesis markers: vertical dashed line at each thesis `created_at` with a small label `p̂ 0.58`; marker color `--pos` if thesis side YES, `--neg` NO. Hover shows nearest point `ts · mid`.
4. `DepthChart` (SVG, 100% × 140px): cumulative bids (left, `--pos` fill at 25% opacity, line solid) and asks (right, `--neg`) from the latest book snapshot. Vertical marker at mid, and at the sizing level `k(S)` labeled `k 0.447`. Below the chart a 2-column text table of the top 8 levels each side (price · size).
5. `EvidenceTable`: columns `Dir` (`+`/`−` colored), `Role`, `Claim`, `Quote` (≤25 words, italic), `Published`, `Retrieved`, `URL` (host only, link). Sortable by Dir, Role, Published. Empty: `No evidence yet`.

Right column:
1. `ThesisPane`: header `Thesis · judge · opus · 14:02 · 3h ago`. Numbers grid (2 cols): `p̂`, `c`, `p_post`, `p_mid at thesis`, `Edge¢`, `Size$`, `E[P]$`, `r_ann`, `Payoff`, `f*`. Then the thesis prose (ui font). If disagreement cap tripped: amber line `Confidence capped 0.5: agents straddle mid`. If stale (> 72h): warn line `Thesis 80h old`. If the thesis has expired: `--muted` line `Expired — re-research`.
2. `KillCriteriaList`: bullet list, each with a checkbox-like glyph `○` (not fired) or `●` in `--neg` (fired) when the server marks it.
3. `CatalystList`: date, label, `in N d`; past catalysts `--muted` with `passed`.
4. `AgentEstimates`: tiny table of the five roles: role, `p`, `conf`, model, duration. Rules reader shows `—` for `p`.

### 3.4 Fleet `/fleet`

Top: `BudgetStrip`: `pods today 12/40 · sandboxes 3/5 · sandbox min 142 · tokens in 1.2M / out 310k · spend $14.20 / cap $50`.

`PodTable`: columns `Pod`, `Market` (truncate 40ch), `Trigger` (`initial`/`price-move`/`catalyst`/`stale`/`manual`), `Started`, `Elapsed`, `Status` (`StatusDot` + text: `queued` grey, `running` accent, `judging` accent, `done` pos, `failed` neg), `Agents` (5 small `StatusDot`s in role order R S B N J-red), `Tokens`, `Sandbox s`. Sort by Started desc default. Row expand (click or `Enter`) shows `AgentRunTable`: role, model, status, duration, tokens in/out, `retry` badge if schema retry happened, and a `view output` link opening a `<pre>` of `output_json` in a `Drawer`.

Live: rows update from SSE events `pod.*`. New pods insert at top with a 1s `--surface-2` flash (that is the one allowed flash).

### 3.5 Calibration `/calibration`

Top controls: category `<select>` (all + list), model `<select>`, window `<select>` (30d/90d/all).

Left 50%: `ReliabilityChart` (SVG 100% × 320px square-ish): x predicted p̂ (10 bins), y observed frequency, diagonal `--faint` dashed, points sized by n (radius 3–9px), with a `--muted` label `n=..` at hover. Below the chart: `Brier 0.182 · log loss 0.54 · n 73 · market Brier 0.201` in one line; the comparison to market Brier gets `EdgeBadge` semantics (`-0.019` is good: use `--pos` when ours < market).

Right 50%: `BrierTable`: rows by category, then a second table by model; columns `Category`, `n`, `Brier`, `Mkt Brier`, `Δ` (ours − market, signed, `--pos` when negative), `log loss`, `c` (current confidence applied), `gate` (`30 resolved` progress like `12/30`). Rows with n < 30 show `c` in `--warn` with title `c ≤ 0.4 until 30 resolved`.

Empty: `No resolved forecasts yet. Calibration runs nightly.`

### 3.6 Paper book `/paper`

Only meaningful at L1; at L0 show `EmptyState` `Paper book is off. Set mode L1 Paper in Autonomy.` with a link.

Top: `PnlStrip`: `open 14 · closed 31 · paper P&L +$212.40 · modeled edge +$340 · realized edge +$198 · capture 58%`.

`PositionsTable` (open, then closed below with a divider): `Market`, `Side`, `Size`, `Avg cost (k)`, `Mid now`, `Unreal $` signed colored, `Modeled e¢`, `Realized e¢` (null until resolved → `—`), `Opened`, `Thesis` (link to detail). Closed rows add `Closed`, `Result` (`YES`/`NO`), `Realized $`.

`FillsTable` below: `ts`, `Market`, `Side`, `Price`, `Size`, `Fee`, `k(S) modeled`, `Slip¢` (fill − modeled; colored). All paper fills are tagged with a small `PAPER` chip in `--mode-1`.

### 3.7 Autonomy `/autonomy`

Single column, panes in this order:

1. `ModeSelector`: five `ModeOption` radio-like buttons in a row. Each shows `L0 Observe`, `L1 Paper`, `L2 Approve each`, `L3 Bounded auto`, `L4 Full auto`, colored border by `--mode-N`, selected one filled. Options the server does not allow are rendered `disabled` (`--faint` text, cursor not-allowed) with the reason on a line under the row (8.5, 9.6). Clicking an enabled option fires `POST /api/autonomy/mode` immediately (no confirm; SPEC one action). The server reply updates `ModeBadge` in the header via SSE. If the server refuses (`EXECUTION_DISABLED`) show the reason inline in `--neg`.
2. `CategoryOverrides`: table `Category`, `Override` (`<select>`: `inherit`, `L0`, `L1` — options above the global mode are disabled with title `cannot raise above global`). Effective mode column computed server-side.
3. `RiskLimits` (read-only here, edit in Settings): two-column key/value list: per-trade max USD / %B, per-market, per-event, per-category, total open, daily notional, daily loss. Each row shows `limit · used today · bar` using `MeterBar` (thin 4px, `--accent`, turns `--warn` at 80%, `--neg` at 100%).
4. `GatePanel`: three rows `L1→L2`, `L2→L3`, `L3→L4`; each shows criteria text from SPEC and progress `MeterBar` + `12/50 resolved · Brier 0.19 vs mkt 0.21 ✓`. Unmet criteria in `--muted`, met in `--pos`. Header line: `Gates are advisory; skipping is logged.`
5. `KillSwitchButton` repeated full-width with the same semantics as the header one, plus one line below: `Drops to L0 and cancels all open orders. Immediate. No undo. Logged to autonomy_events.`
6. `EventLog`: table of `autonomy_events`, newest first: `ts`, `from → to` (two `ModeBadge` small), `scope`, `reason`, `actor` (`user`/`auto-downgrade`/`kill`). `EXECUTION_DISABLED` rows show the reason in `--warn`.

### 3.8 Settings `/settings`

One form, grouped in `FormGroup` panes with a title and a 2-column key/input grid. Save button per group (`Save filters`, …); unsaved changes mark the group title with `•`. Inputs are plain `<input type=number>`/`<select>`, mono font, right-aligned numbers, unit suffix in `--muted`.

Groups and fields:
- Filters: min days, max days, min depth 5¢ USD, excluded categories (multi-select), excluded tags (comma list).
- Weights: not editable multipliers of the formula; expose `small-cap target USD`, `size target USD`, `T decay days` (60), `C weight` (0.5), `C_against weight` (0.2).
- Bankroll & sizing: bankroll B, Kelly fraction (0.25), per-trade cap %B (0.05), min edge ¢ (2).
- Models per role: six `<select>`s (rules, source, base_rate, news, red_team, judge) with options `claude-haiku-5-5`, `claude-sonnet-5-5`, `claude-opus-5-5`.
- Budget: max pods/day, max concurrent sandboxes, sandbox timeout min, Exa calls per pod, daily Anthropic spend cap USD.
- Risk limits: the full list from SPEC (per-trade USD and %B, per-market, per-event, per-category, total open, daily notional, daily loss, L3 auto ceiling, daily auto notional, category allowlist, structural auto yes/no). L3 fields bound L3 auto-sends (9.3).
- Appearance: theme `dark/light/system`.

Validation errors render under the field in `--neg`; server validates with zod and returns `{field, message}`.

## 4. States (every data view)

| State | Rendering |
|---|---|
| Loading | `Skeleton` rows: 8 rows of `--surface-2` bars in the table at real row height. No spinners for tables. |
| Empty | `EmptyState` component: one `--muted` line + optional action. Texts: watchlist `No theses yet. Next sweep at 15:00.`; structural `No structural edges in the last sweep.`; fleet `No pods running.`; calibration as in 3.5; paper as in 3.6; evidence `No evidence yet`. |
| Error | `ErrorBar` at the top of the view, `--neg` left border, message + `Retry` button. Table keeps last good data beneath it if any. |
| Stale (> 5 min since last snapshot for that view's data) | `StaleBanner`: full-width `--warn` left border, text `Data stale · last snapshot 14:21 (7 min)`. Numbers in the table switch to `--muted`. Autonomy auto-downgrade events caused by staleness show in the EventLog. |
| Research running | `ResearchRunning` inline chip: spinner (CSS border rotate, 12px) + `researching · 3/5 agents · 2m14s`. On detail view it sits in `ActionBar`; on watchlist it replaces the `p̂` cell content for that row. |
| Disconnected SSE | header dot as in §2; views keep polling fallback every 30s. |

## 5. Component inventory (web)

Names are file names under `apps/web/components/`. Props are TypeScript sketches.

- `NumCell({ value: number | null, fmt: 'p' | 'cents' | 'usd' | 'pct' | 'int' | 'x', signed?: boolean, muted?: boolean })` → `<td class=num>`; null renders `—`. `p` = 3 decimals, `cents` = 1 decimal, `usd` = thousands sep no decimals under 1000 else 1 decimal, `pct` = 0 decimals with `500%+` cap, `x` = 2 decimals + `×`.
- `EdgeBadge({ cents: number })` → mono, sign always shown (`+3.4` / `−1.2`), color `--pos`/`--neg`/`--muted` for |e| < 0.5. Sign + color, never color alone.
- `ModeBadge({ mode: 0|1|2|3|4, size?: 'sm' | 'lg' })` → `L1 PAPER`, border + text in `--mode-N`. `lg` only in header.
- `KillSwitchButton({ mode, onKill })` → §2 semantics.
- `SseIndicator({ status: 'live' | 'reconnecting' | 'offline', lastEventAt })`.
- `Tabs({ items: {id, label, count?}[], active, onChange })`.
- `FilterInput({ value, onChange, placeholder })` — registers `/` focus.
- `DataTable<T>({ columns: Column<T>[], rows: T[], rowKey, sort, onSort, selectedKey, onSelect, onOpen, renderExpanded? })` where `Column<T> = { id, header, align: 'l'|'r', sortable?: boolean, width?: string, cell: (row) => ReactNode }`. Handles j/k/Enter, sticky header, selection bar. One implementation for every table in the app.
- `StatusDot({ status: 'queued'|'running'|'done'|'failed'|'judging', label? })` → dot + text; dot alone only inside `PodTable` agents cell with `title`.
- `Sparkline({ points: number[], width?: 80, height?: 18 })` — used in `KeyStats` for 24h mid; SVG polyline, stroke `--muted`.
- `PriceHistoryChart({ series: {ts, mid}[], markers: {ts, pHat, side}[], height?: 180 })`.
- `DepthChart({ bids: {price,size}[], asks: {price,size}[], mid, k?, height?: 140 })`.
- `ReliabilityChart({ bins: {pHat, observed, n}[], height?: 320 })`.
- `MeterBar({ value, max, warnAt?: 0.8 })`.
- `ThesisPane`, `EvidenceTable`, `KillCriteriaList`, `CatalystList`, `AgentEstimates`, `MarketHeader`, `KeyStats`, `ActionBar` — detail-only composites, props = the API detail payload slices.
- `PodTable`, `AgentRunTable`, `BudgetStrip`, `Drawer({ open, title, onClose, children })`.
- `BrierTable`, `PnlStrip`, `PositionsTable`, `FillsTable`.
- `ModeSelector({ mode, enabledModes: number[], disabledReason, onChange })`, `CategoryOverrides`, `RiskLimits`, `GatePanel`, `EventLog`.
- `FormGroup({ title, dirty, onSave, children })`, `Field({ label, unit?, error?, children })`.
- `Skeleton({ rows })`, `EmptyState({ text, action? })`, `ErrorBar({ message, onRetry })`, `StaleBanner({ lastSnapshotAt })`, `ResearchRunning({ done, total, elapsedS })`.
- Hooks: `useSse()` (one EventSource, exposes status + typed events), `useGlobalKeys()`, `useTheme()`.

Charts: all pure SVG with `viewBox`, `preserveAspectRatio="none"` for width-fill, text labels in `--fs-xs` mono, `--faint` gridlines, `--muted` axes. Hover via a transparent full-size `<rect>` and `onMouseMove` → nearest index; tooltip is a positioned `<div>` on `--surface-2`. Each chart has `role="img"` and an `aria-label` that states the headline number (e.g. `Depth chart, mid 0.412, bids $1,840 within 5 cents`).

## 6. TUI (Ink)

Fixed 2-line header, body, 1-line footer. Minimum 100×30; below that, columns collapse per view (hide Catalyst, Payoff, then p_mid). Colors use chalk names mapped to tokens:

| Token | chalk |
|---|---|
| `--text` | default |
| `--muted` | `gray` |
| `--pos` | `green` |
| `--neg` | `red` |
| `--warn` | `yellow` |
| `--accent` / selected | `cyan` (selected row: `inverse`) |
| `--mode-0..4` | `gray`, `blue`, `yellow`, `magenta`, `red` |
| kill | `bgRed.white.bold` |

Sign + color everywhere, same as web. Numbers right-aligned with fixed widths.

### Global keys

`1`–`6` or `Tab`/`Shift-Tab` switch views (order as nav), `j`/`k` or arrows move, `Enter` open, `Esc`/`Backspace` back, `/` filter (type, `Enter` apply, `Esc` clear), `s` cycle sort column, `S` flip direction, `r` re-research, `p` pin, `m` mute, `K` kill switch (capital, immediate, no prompt; footer shows `KILLED → L0` for 3s), `R` force refresh, `?` help overlay, `q` quit. Mode change: in Autonomy view `0`/`1` set L0/L1; `2`–`4` set L2–L4 when the exchange is configured, otherwise the footer shows `disabled: L2–L4 need a configured exchange`.

### Header / footer (all views)

```
 PM-EDGE  [1]Watchlist [2]Fleet [3]Calib [4]Paper [5]Autonomy [6]Settings      ● live  L1 PAPER   K=KILL
 ──────────────────────────────────────────────────────────────────────────────────────────────────────
 ... body ...
 ──────────────────────────────────────────────────────────────────────────────────────────────────────
 j/k move  Enter open  / filter  s sort  r research  p pin  m mute  K kill  ? help  q quit   swept 14:32
```

Stale: footer right turns yellow `STALE 7m`. SSE down: header dot red `● offline`.

### Watchlist

```
 [Small-cap 23] [Size 11] [Structural 4]        filter: ▮                      sort: rank ▲
  #  Market                                   Side p_mid  p̂    p_post Edge¢  Size$   E[P]$  r_ann Days Catalyst
  1  Will the Fed cut in Dec 2026?            YES  0.412 0.580 0.512  +10.0  1,250   +125   312%   41 11-02 FOMC
  2  Senate confirms X by Nov 30?             NO   0.700 0.520 0.600   +9.8    900    +88   185%   46 11-14 vote
 ▶3  ETH ETF approved by Q1?                  YES  0.210 0.300 0.260   +4.6    600    +28    98%   88 —
 ...
```
Selected row inverse. Structural tab swaps the columns as in §3.2. `Enter` → detail.

### Market detail

```
 ← Watchlist   Will the Fed cut in Dec 2026?                       politics · ends 12-18 · 41d · fee 4%
 mid 0.412  bid 0.40  ask 0.42  depth5¢ $1,840  vol24h $12k  OI $45k  top10 61%
 ┌ Thesis · opus · 3h ago ──────────────────────┐ ┌ Book ──────────────────────────────────┐
 │ p̂ 0.580  c 0.60  p_post 0.512  edge +10.0¢   │ │   bids            asks                  │
 │ size $1,250  E[P] +$125  r_ann 312%  pay 1.2× │ │ 0.410  1,200   0.420    800             │
 │                                               │ │ 0.400  2,500   0.430  1,900             │
 │ The dot plot and three regional presidents... │ │ 0.390    900   0.440  3,100             │
 │                                               │ │ k(S)=0.447                              │
 ├ Kill criteria ────────────────────────────────┤ ├ Catalysts ─────────────────────────────┤
 │ ○ CPI print > 3.4% y/y                        │ │ 11-02 FOMC minutes        in 18d        │
 │ ● Powell signals hold (fired)                 │ │ 12-10 CPI                 in 56d        │
 ├ Evidence (12) ────────────────────────────────┴─┴────────────────────────────────────────┤
 │ + source  Fed dot plot median shows one cut    "median participant sees..."  09-18  fed.gov│
 │ − news    Two presidents argued for hold       "we should wait for..."       10-10  wsj.com│
 └──────────────────────────────────────────────────────────────────────────────────────────┘
 r re-research  p pin  m mute  j/k scroll evidence  Esc back
```
Panes are `Box` with `borderStyle="single"`, border color `gray`. No charts: book as text, history as a one-line sparkline string (`▁▂▃▅▆▇` from the last 24 mids) under the stats line.

### Fleet

```
 pods today 12/40  sandboxes 3/5  sandbox min 142  tokens 1.2M/310k  spend $14.20/$50
  Pod      Market                              Trigger    Started  Elapsed  Status   R S B N J  Tokens  Sbx s
 ▶a81f     Will the Fed cut in Dec 2026?       price-move 14:30    2m14s    running  ● ● ◐ ◐ ○  41k     134
  7c02     Senate confirms X by Nov 30?        initial    14:12    8m02s    done     ● ● ● ● ●  88k     480
 Enter → agent list + last 20 log lines for the selected pod (scroll j/k, Esc back).
```
Glyphs: `○` queued, `◐` running, `●` done (green), `✗` failed (red).

### Calibration

```
 category: all ▾   model: all ▾   window: 90d ▾
 Brier 0.182  log loss 0.54  n 73   market Brier 0.201   Δ -0.019
  Category     n   Brier  Mkt    Δ       logloss  c     gate
  politics    31   0.171  0.195  -0.024  0.51     0.60  31/30 ✓
  crypto      12   0.210  0.198  +0.012  0.60     0.40  12/30
```
No reliability curve in TUI (table only, per SPEC). `Tab` inside view cycles the three selects, arrows change value.

### Paper book

```
 open 14  closed 31  paper P&L +$212.40  modeled edge +$340  realized +$198  capture 58%
  Market                           Side Size   Cost   Mid    Unreal$  Mod e¢  Real e¢  Opened
 ▶Will the Fed cut in Dec 2026?    YES  1,250  0.447  0.470   +64.3   +10.0   —        10-14
 ── closed ──
  ...                                                                  +6.1    +4.2     10-01
 Enter → fills for that position.
```
At L0: body shows `Paper book is off. Autonomy view: press 1 to set L1.`

### Autonomy

```
 Mode   [L0 Observe]  [L1 PAPER]  L2 Approve  L3 Bounded  L4 Full      ← L2–L4 need a configured exchange
 Overrides   politics: inherit   crypto: L0   sports: L0            (o to edit, only lowering allowed)
 Limits      per-trade $250 (5%)  used 0 ▏          daily loss $500  used $0 ▏
 Gates       L1→L2  12/50 resolved · Brier 0.182 vs mkt 0.201 ✓        advisory
             L2→L3  12/30 approved trades · avg slip +0.6¢ vs ≤1.0¢ ✓  advisory
             L3→L4  12/100 live trades · realized edge 30d +1.4¢ ✓      advisory
 K  KILL SWITCH → L0, cancels open orders, immediate, no undo
 Events
  14:32 L1→L1  global   EXECUTION_DISABLED (requested L2)   user
  09:00 L0→L1  global   manual                               user
```

### Settings

Read-only key/value list grouped as in §3.8, scroll with j/k. Footer: `read-only · edit in web`.

## 7. Accessibility

- All meaningful color pairs ≥ 4.5:1 in both themes (table in §1). `--faint` never carries meaning.
- Every number that is signed shows its sign; side shows the word `YES`/`NO`; status shows text next to dots. Nothing is color-only. TUI glyphs differ by shape, not only color.
- Visible focus ring on every interactive element and on the keyboard-selected row; the row also sets `aria-selected`.
- Tables use real `<table>` with `<th scope="col">`; sortable headers are `<button>`s with `aria-sort`.
- Kill switch and mode buttons have full-sentence `aria-label`s stating the effect. Disabled modes keep the reason in `title` and in visible text, not only in `disabled`.
- Charts: `role="img"` + `aria-label` summary; the data they draw is also present as a text table (book levels, Brier table) so nothing is chart-only.
- `prefers-reduced-motion`: disable the blink and the pod flash.
- Keyboard shortcuts never fire while focus is in an input; `?` lists them.

## Phase 6 — Live execution

Scope: L2 Approve each. Extends sections 1–7; no new tokens, no new routes. Live money uses `--mode-2` (amber) as its identity color, the same color as the L2 badge, so "amber means real money" holds everywhere. Paper keeps `--mode-1` (blue).

### 8.1 Pending approvals (web)

Placement: a new `ApprovalsPane` on `/autonomy`, directly under `ModeSelector` and above `CategoryOverrides` (anchor `#approvals`). Not its own route: there is one operator, proposals are only produced at L2, and the decision to approve sits next to the controls that bound it (mode, risk limits, kill switch). Proposals are urgent, so the pane goes to the top of the view instead of after the gates.

Header badge: `ApprovalsBadge` in the global header between `ModeBadge` and `KillSwitchButton`, reading `2 PENDING` in `--mode-2` border and text, linking to `/autonomy#approvals`. Hidden when the count is 0. `aria-label` "2 orders waiting for approval".

Pane title line: `Approvals · 2 pending`, then the reconciliation status (8.4) right-aligned on the same line.

The pane holds one `DataTable` of pending and sending proposals, oldest first (the one closest to expiry on top). Columns in order:

| Header | Content |
|---|---|
| `Market` | question truncated to 48ch, link to `/m/[conditionId]` (the thesis lives there) |
| `Side` | `BUY YES` / `BUY NO` (word plus pos/neg color); `SELL` for exit proposals |
| `Shares` | int |
| `Limit` | `0.000` |
| `Cost$` | shares × limit, the money that leaves the wallet |
| `Edge¢` | `EdgeBadge` at proposal time |
| `E[P]$` | signed |
| `Drift¢` | current mid minus mid at proposal, signed `+0.8`. At `|drift| ≥ 1.5` the cell turns `--warn` and gains a `⚠` prefix with title "Expires at 2.0¢ move". The server expires at > 2¢; the UI never decides expiry. |
| `Expires` | countdown text `12:04 left`; under 2 min `⚠ 1:42 left` in `--warn`. Title holds the absolute time `expires 14:47:10`. |
| actions | `Approve` and `Reject` buttons |

Row states (shown in the actions cell, the row stays in place):
- pending: `Approve` (border `--mode-2`) and `Reject` (plain).
- confirm: clicking `Approve` swaps the cell to `Send $366.54 live?` with `Confirm` (bg `--mode-2`) and `Cancel`; focus moves to `Confirm`, `Esc` cancels. The confirm reverts to pending after 10 s without input. `Reject` has no confirm (no money moves).
- sending: buttons replaced by `sending…` text plus the 12px spinner, row not interactive.
- After the server answers, the row leaves the pending table and appears in `Recent` below.

`Recent`: a second small table under the first, last 10 resolved proposals, newest first, columns `ts`, `Market`, `Side`, `Shares`, `Limit`, `State`. State text and color:
- `sent · ord 0x3fa1…` in `--pos` (order id first 6 hex, title full id)
- `rejected` in `--muted`
- `expired · TIMEOUT` in `--muted`
- `expired · PRICE_MOVED` in `--warn`
- `failed · <error message>` in `--neg`, message truncated 60ch, title full

Empty states: at L2 with nothing pending, `No pending approvals.` in `--muted`. Below L2 the whole pane collapses to one line: `Approvals appear at L2 Approve each.` `Recent` is hidden when empty.

When reconciliation is in mismatch (8.4) or the mode is below L2 (e.g. after auto-downgrade), every `Approve` button is disabled with visible text `orders halted` in the actions cell and the reason in `title`. `Reject` stays enabled.

### 8.2 Live vs paper (book)

Nav label `Paper` becomes `Book`; the route stays `/paper` and `g p` still works. The view gets `Tabs` [`Live` `Paper`] with counts. Default tab: `Live` when the mode is L2 or above, otherwise `Paper`. Live and paper rows never share a table.

Live tab, top to bottom:
1. `PnlStrip` prefixed with a `LIVE` chip: `LIVE · open 3 · closed 1 · P&L +$12.40 · USDC $1,840.22 · slippage vs model +0.4¢`.
2. `Open orders` table: `ts`, `Market`, `Side`, `Shares`, `Limit`, `Filled` (`120/820`), `Status` (`open` / `partial` / `filled` / `cancelled` / `expired`, text), `Expires`, `Order` (short id). Empty: `No open live orders.`
3. `PositionsTable` and `FillsTable` as in 3.6, same columns.

Every live row (orders, positions, fills) carries a `LIVE` chip: `--mode-2` border and text, mono `--fs-xs`, same shape as the existing `PAPER` chip in `--mode-1`. The chip is text, so the distinction never relies on color. The paper tab is unchanged apart from the tab bar and the strip gaining a `PAPER` chip prefix. The L0 empty state from 3.6 applies to the paper tab only; the live tab with no data shows `No live trades yet. Approvals appear at L2.`

### 8.3 Kill switch with live orders

`KillSwitchButton` gains `liveOpenOrders: number`.
- `liveOpenOrders === 0` (always the case at L0/L1 unless orders were left over): unchanged, one click, no confirm.
- `liveOpenOrders > 0`: the first click turns the button into `CONFIRM · CANCEL 3 LIVE ORDERS → L0` for 5 s; a second click (or `Enter`, since focus stays on it) fires; `Esc` or the timeout aborts. The `aria-label` reads "Kill switch: drop to L0 and cancel 3 live orders, press again to confirm".
- Result, shown on the button for 3 s: `KILLED · L0 · 3 cancelled`. If any cancel failed: `KILLED · L0 · 2 cancelled · 1 FAILED`, and an `ErrorBar` appears on the current view: `Kill: 1 live order not cancelled (ord 0x3fa1…: <error>). Cancel it on Polymarket or retry.` with `Retry` firing the kill again (at L0 it only cancels). The bar stays until dismissed or a retry succeeds.

### 8.4 Reconciliation status

One `ReconStatus` line, shown in the `Approvals` pane title (right side) and as a row at the top of the book's Live tab:
- ok: `recon ✓ ok · 14:35 (2 min ago)` in `--muted`, `✓` in `--pos`.
- late (no run for > 10 min): `recon ⚠ late · 14:20 (17 min ago)` in `--warn`.
- mismatch: `recon ✗ MISMATCH · new orders halted · 14:35` in `--neg`, followed by the server's detail (`position 0x… ledger 820 vs chain 700`, truncated, title full).
- never run: `recon — not run yet` in `--muted`.

On mismatch the header also shows a `RECON ✗` chip in `--neg` (text, not a dot) before `ApprovalsBadge`, linking to `/autonomy#approvals`. Nothing in the header when ok.

### 8.5 Mode selector

`enabledModes` is `L0 L1 L2 L3 L4` when the exchange is configured, `L0 L1` otherwise (amended in 9.6).
- Disabled title and visible line: `L2–L4 need a configured exchange (PM_PRIVATE_KEY on the server).`
- Selecting any enabled mode stays one click (SPEC).

### 8.6 TUI

No new view. Approvals live at the top of the Autonomy view `[5]`, between the `Mode` line and `Overrides`, matching the web.

Header: after the mode badge, `2 PENDING` in yellow when the count is > 0, and `RECON ✗` in red when in mismatch. Pressing `5` jumps there from any view.

Approvals block: a title line `Approvals 2 pending` with the recon status right-aligned (same texts as 8.4, `✓`/`⚠`/`✗` glyphs). Then one row per pending proposal with the web columns in short form: market (truncated), side, shares, limit, cost, edge, drift (`⚠` prefix and yellow at ≥ 1.5¢), countdown `12:04` (`⚠` prefix and yellow under 2 min). Selected row inverse. Below L2: one gray line `approvals appear at L2`. Empty at L2: `no pending approvals`. A `recent` line lists the last 3 resolved proposals as `14:31 sent`, `14:20 expired PRICE_MOVED`, `14:02 failed <msg>` with the same colors as web.

Keys inside the Autonomy view (checked against current bindings: global `q K ? R Tab 1-6`, Autonomy `0-4`; `a`, `x`, `y` are free here; `x` already means close/dismiss in the paper view, so the meaning carries over):
- `j`/`k` move the selection among pending rows.
- `a` approve: the footer turns into a prompt `SEND LIVE: BUY YES 820 @ 0.447 = $366.54 ? y = confirm, any other key aborts`, in yellow bold. `y` sends; the row shows `sending…` until the reply, then the footer flashes `sent ord 0x3fa1` (green) or `failed: <msg>` (red).
- `x` reject, no prompt, footer flashes `rejected`.
- Approve is refused with a footer message when recon is in mismatch: `orders halted: recon mismatch`.
Footer key hints in this view gain `a approve  x reject`. Mode keys: `2`/`3`/`4` set L2/L3/L4 when the exchange is configured, otherwise footer `disabled: L2–L4 need a configured exchange`.

Book `[4]`: header label `Book`. `h`/`l` switch `Live`/`Paper` (same as watchlist tabs). Every row starts with a `LIVE` (yellow) or `PAPER` (blue) tag; the strip line starts with the same tag. The live tab adds an `open orders` block above positions with the 8.2 columns. `x` closes paper positions only; on a live row it flashes `live positions close via an exit proposal`.

Kill: `K` with 0 live open orders is unchanged (immediate). With live open orders the footer shows `K again: kill + cancel 3 LIVE orders · any other key aborts` (red bold) for 5 s; a second `K` fires. Result in the footer: `KILLED → L0 · 3 cancelled`, or `KILLED → L0 · 2 cancelled · 1 FAILED (see Autonomy)` in red; the failed order ids are listed in the Autonomy events block.

### 8.7 Live updates (SSE event names)

Existing events stay (`mode.changed`, `paper.fill`, `pod.*`, …). New ones, payload ids plus state only; the client refetches the affected view on receipt:
- `proposal.created` — id, conditionId. Bumps the pending count.
- `proposal.updated` — id, state (`pending|sending|sent|rejected|expired|failed`), reason (`TIMEOUT|PRICE_MOVED` when expired), error (when failed), orderId (when sent).
- `order.updated` — id, status (`open|partial|filled|cancelled|expired`), filledShares.
- `order.filled` — id, fill price, shares (feeds the live fills table).
- `recon.done` — at, status (`ok|mismatch`), detail. Covers both ok and mismatch so the indicator can clear.

Countdowns tick client-side from `expiresAt`; drift updates on the existing snapshot refresh. No per-second server events.

Data the UI reads (fields on the autonomy read payload and the shell status the header uses): `exchangeConfigured`, `pendingCount`, `liveOpenOrders`, `recon {at, status, detail}`, and per proposal `id, conditionId, question, thesisId, side, shares, limitPrice, costUsd, edgeC, expectedProfitUsd, midAtProposal, midNow, createdAt, expiresAt, state, reason, error, orderId`. Kill response: `cancelled` (count) and `failed` (list of order id and error).

### 8.8 Accessibility

- Countdowns and drift are text with a `⚠` glyph at the warning threshold; color only reinforces. Countdown cells are not `aria-live` (one announcement per second is noise); the pane title count is `aria-live="polite"` so new proposals are announced once.
- `Approve`, `Confirm`, `Cancel`, `Reject` and the kill confirm are real `<button>`s in tab order; focus moves to `Confirm` when it appears and back to `Approve` on cancel. `Esc` cancels any pending confirm.
- `Confirm` carries the full sentence `aria-label` "Send live order: buy YES 820 shares at 0.447, cost $366.54".
- Disabled approve buttons keep the reason in visible text (`orders halted`) and in `title`, not only `disabled`.
- `LIVE`/`PAPER` and `RECON ✗` are words, never color-only marks.

## Phase 7 — Autonomy (L3/L4) and neg-risk sets

Scope: L3 bounded auto, L4 full auto, structural neg-risk sets, exit proposals, L2→L3 and L3→L4 gate stats. Extends section 8; no new tokens, no new routes. Amber `--mode-2` stays the live-money color; `--mode-3`/`--mode-4` mark what L3/L4 sent without a human. The `ApprovalsPane` is shown at L2, L3 and L4 (at L3 it holds fallbacks; at L4 it holds only `Recent` and flagged sets); below L2 it still collapses to one line.

Proposals carry `kind`: `single` (section 8), `set`, or `exit`.

### 9.1 Set proposal (web)

A set is one row-group in the pending table: a set row plus leg rows, one `Approve`/`Reject` for the whole set (build decision 5). The set row reuses the 8.1 columns:

| Header | Set row content |
|---|---|
| `Market` | `▸` toggle, `SET` chip (border `--border`, mono `--fs-xs`), then `buy-all · 5 legs · <event title>` truncated to 48ch, link to the event's first market |
| `Side` | `BUY ALL` or `SELL ALL` (sell-all = BUY NO on every leg; the leg rows show that) |
| `Shares` | shares per leg (equal on every leg) |
| `Limit` | `Σ 0.962`: sum of leg caps |
| `Cost$` | Σ leg costs, the money that leaves the wallet |
| `Edge¢` | `lock 3.8¢`: locked margin per share set, in `--pos` |
| `E[P]$` | expected profit for the whole set, signed |
| `Drift¢` | largest absolute leg drift, same thresholds as 8.1 |
| `Expires` | as 8.1 |
| actions | `Approve` / `Reject` for the whole set |

Expanded (`▾`, toggled by click or `Enter` on the focused row, collapsed by default), one leg row per leg, indented 16px, `--surface-2` background, no actions: `Market` (question, link), `Side` (`YES`/`NO` token word, pos/neg color), `Shares`, `Limit` (cap price `0.212`), `Cost$`, other cells empty. Legs list in send order (thinnest first), numbered `1/5 …`.

Confirm text: `Send set: 5 legs, $482.10 live?`; `aria-label` "Send live set: buy all, 5 legs of 820 shares, cost $482.10". The 10 s revert and `Esc` rules from 8.1 apply.

### 9.2 Set lifecycle

| State | Where | Web | TUI |
|---|---|---|---|
| `pending` | pending table | as 9.1 | as 9.5 |
| `sending` | pending table, row-group not interactive | actions cell `sending leg 2/5…` + spinner; expanded legs show `filled` (`--pos`), `sending…`, `queued` (`--muted`) per leg | `sending 2/5` |
| `filled` | Recent | `filled · 5/5 legs` in `--pos` | green `filled 5/5` |
| `unwinding` | pending table, not interactive | `unwinding · leg 3 failed` + spinner in `--warn`; legs show `unwinding…` / `unwound` | yellow `unwinding` |
| `unwound` | Recent | `unwound · leg 3 <error>` in `--warn` (nothing held) | yellow `unwound` |
| `failed` | Recent | `failed · leg 1 <error>` in `--neg` (first leg failed, nothing held) | red `failed` |
| `flagged` | `FlaggedSetBar` + Recent | see below | see 9.5 |

`flagged` is the loudest state and stays until acknowledged; it is the only state that means money is held in a shape the engine did not intend. It shows in three places:
- Header: `SET ✗ 1` chip in `--neg` (text), before `RECON ✗`/`ApprovalsBadge`, linking to `/autonomy#flagged`.
- `FlaggedSetBar`: an `ErrorBar` variant pinned at the top of `/autonomy` (above `ModeSelector`), one per flagged set, `role="alert"`. Title line: `Set needs manual action · buy-all · <event title> · flagged 14:36`. Body: a small table of legs still held: `Market`, `Token`, `Shares held`, `Avg fill`, `Bid now`, and the server's `Suggested action` text (e.g. `SELL 820 YES on Polymarket, bid 0.190`). One line under it: `The engine will not retry. Positions stay in Book › Live until closed.` Button `Acknowledge` (plain, no confirm) fires `POST /api/sets/:id/ack`, removes the bar and the header chip, and logs to `autonomy_events`. It does not close anything.
- Recent: `flagged · 2 legs held` in `--neg`; after ack `flagged · acknowledged` in `--muted`.

Leg orders appear in Book › Live like any order, each with the `SET` chip next to `LIVE`.

### 9.3 Auto-sent orders and L3 fallback

`Recent` lists every resolved proposal and every auto-sent order (auto sends never pass through the pending table). It gains an `Approval` column after `ts`:
- `user`: plain `--muted` text.
- `AUTO L3` chip in `--mode-3`, `AUTO L4` chip in `--mode-4` (border and text, same shape as `LIVE`).

The same chip appears on the live order and fill rows in Book › Live, so every live row says who sent it.

At L3, a proposal that fails `limits.l3` falls back to the pending table. Its `Market` cell gets a second line in `--muted` `--fs-xs`: `L3 fallback: <reason>`, where the reason maps from the server code:

| Code | Text |
|---|---|
| `PER_TRADE` | `over L3 per-trade $100 (this $366.54)` |
| `DAILY_AUTO_NOTIONAL` | `daily auto notional $480 / $500 used` |
| `CATEGORY_NOT_ALLOWED` | `category sports not in L3 allowlist` |
| `STRUCTURAL_AUTO_OFF` | `sets need structural auto (Settings)` |

At L4 nothing falls back; a global risk-limit rejection is logged in the `EventLog` and shows no row.

### 9.4 Exit proposals

`kind: exit`, raised when a thesis is `killed` or `flipped` on re-research. Row differences from an entry:
- `Market` cell starts with an `EXIT` chip in `--warn` (border and text), then `· killed` or `· flipped` in `--muted`.
- `Side` reads `SELL YES` / `SELL NO` in `--text` (not pos/neg: an exit is neither a bullish nor a bearish bet).
- `Limit` is the floor price `≥ 0.410`; `Cost$` becomes proceeds `+$336.20`; `Edge¢` shows `—`; `E[P]$` shows the estimated realized P&L of the exit vs entry, signed.
- Confirm text `Sell 820 YES @ ≥ 0.410 live?`.
In Recent the side keeps the `EXIT` chip. At L3/L4 auto-sent exits get the `AUTO` chip as in 9.3.

### 9.5 TUI (Autonomy `[5]`)

Set rows in the approvals block, indented legs always shown under a selected set and collapsed otherwise:
```
 ▸ SET buy-all 5 legs  Election winner…   820  Σ$482.10  lock 3.8¢  +$18.40  12:04
 ▾ SET sell-all 3 legs Fed decision…       400  Σ$371.20  lock 2.1¢  +$8.40   ⚠ 1:42
     1/3 NO  25 bps cut?         cap 0.312  400
     2/3 NO  No change?          cap 0.402  400
     3/3 NO  50 bps cut?         cap 0.214  400
 EXIT killed  SELL YES  Will X…   820  ≥0.410  +$336.20  P&L -$12.30   09:12
     L3 fallback: over L3 per-trade $100
```
- `j`/`k` move between proposal rows; leg rows are not selectable. `a`/`x` act on the whole set. Approve prompt: `SEND LIVE SET: buy-all 5 legs × 820 = $482.10 ? y = confirm, any other key aborts` (yellow bold). The set row then shows `sending 2/5`, `unwinding`, etc. per 9.2.
- Exit rows start with `EXIT killed`/`EXIT flipped` in yellow.
- Fallback reason on a gray line under the row, same texts as 9.3.
- `recent` line entries gain the approval: `14:31 sent user`, `14:33 sent auto L3` (orange), `14:40 filled 5/5 auto L4` (red).
- Flagged: header `SET ✗ 1` in red. A red block above `Mode`: `FLAGGED set · buy-all · Election winner… · holds YES 820 "Candidate A" avg 0.212 bid 0.190 · suggested: SELL 820 YES`, one line per held leg. `A` (capital, free in this view) acknowledges the selected flagged set; footer flashes `acknowledged`. The block persists until acknowledged.

### 9.6 Mode selector and keys

Covered by the amended 8.5 and 8.6: L2, L3 and L4 are enabled when the exchange is configured, with nothing else required for L3 (its limits already have defaults in Settings). Selecting L3 or L4 is one click / one key like L2. When the exchange is not configured the line under the row reads `L2–L4 need a configured exchange (PM_PRIVATE_KEY on the server).`

### 9.7 GatePanel

The `L2→L3` and `L3→L4` rows now show real numbers, same layout as `L1→L2`:

| Row | Text | Met when |
|---|---|---|
| `L2→L3` | `12/30 approved trades · avg slip +0.6¢ vs ≤ 1.0¢` | trades ≥ 30 and abs(avg slip) ≤ 1.0¢ |
| `L3→L4` | `12/100 live trades · realized edge 30d +1.4¢` | trades ≥ 100 and edge > 0 |

`MeterBar` tracks the trade count. Each criterion is colored separately (`--muted` unmet, `--pos` met); the row gets `✓` only when all are met. With no data: `0/30 approved trades · avg slip —`. Values are server-computed (`gates.l2l3 {approvedTrades, avgSlippageC}`, `gates.l3l4 {liveTrades, realizedEdge30dC}`); the TUI uses the same text with `advisory` right-aligned (see the amended mock in 6).

### 9.8 SSE and data

Existing events keep their meaning. `proposal.created`/`proposal.updated` cover sets and exits too (payload adds `kind`). Leg orders emit the usual `order.updated`/`order.filled`. One new event:
- `set.updated` — id, state (`sending|filled|unwinding|unwound|failed|flagged|acknowledged`), legsFilled, legsTotal, failedLeg, error. Drives the 9.2 progress text, the header `SET ✗` count and `FlaggedSetBar`.

`gates` values refresh on `recon.done` and `order.filled`; no gate-specific event.

Data added to the autonomy payload: `flaggedSets` (count, for the header), per proposal `kind`, `fallbackReason`, `exitReason` (`killed|flipped`), and for sets `setKind (buy-all|sell-all)`, `lockedC`, `legs [{conditionId, question, token, capPrice, shares, costUsd, state}]`; per resolved row and live order `approval (user|auto_l3|auto_l4)`; per flagged set `held [{question, token, shares, avgFill, bidNow}]` and `suggestedAction` (server text).

### 9.9 Accessibility

- The set toggle is a `<button aria-expanded>` labelled "Show 5 legs"; leg rows are plain rows, not in tab order.
- `FlaggedSetBar` is `role="alert"` once on arrival, then static; `Acknowledge` is a real button.
- `SET`, `EXIT`, `AUTO L3/L4`, `SET ✗` are words, never color-only marks.

## Public visitor mode (Rev 6)

Scope: the anonymous `/trade` surface from SPEC "Public visitor mode (Rev 6)". Same tokens, type scale, density and states as sections 1–9; no new tokens. The visitor surface reuses the identity colors with the same meaning: `--mode-2` amber is real money (the visitor's own), `--mode-3`/`--mode-4` mark what the visitor's own loop sent without a click. Operator components that read operator state (`Shell`, `ModeBadge`, `ApprovalsBadge`, `KillSwitchButton`, `SseIndicator`, `ActionBar`, `AgentEstimates`, `ApprovalsPane`, `GatePanel`) are not used here. Everything visitor-specific lives under `apps/web/components/public/`; reused components keep their names and paths.

## 10. Public visitor surface (/trade)

> Superseded for `/trade` and `/trade/[id]` by §11 (trading terminal). Still in force: §10.1 shell header/footer copy, `RegionStatus` and `ConnectButton` wording, §10.4 gate copy and button labels, §10.6 visitor autonomy (`/trade/autonomy`), §10.7 a11y rules.

### 10.1 Shell `(public)`

Route group `app/(public)/` with its own `layout.tsx` and `PublicShell`. It does not import `Shell`, does not fetch `/api/autonomy`, and opens no EventSource.

```
┌ header 40px ──────────────────────────────────────────────────────────────────────────┐
│ PM-EDGE · research   Watchlist  Autonomy      ● region ok   [0x3fa1…9c2e · Polygon]   Sign in │
├────────────────────────────────────────────────────────────────────────────────────────┤
│ RUNNING · L3 bounded auto · runs only while this tab is open          [STOP]  (10.6)   │
├────────────────────────────────────────────────────────────────────────────────────────┤
│ view content, padding 12px                                                             │
├ footer ────────────────────────────────────────────────────────────────────────────────┤
│ Research output, not financial advice. Trading can lose all funds sent. Polymarket is  │
│ not available in some jurisdictions; you are responsible for complying with yours.    │
└────────────────────────────────────────────────────────────────────────────────────────┘
```

- Left: wordmark `PM-EDGE` (mono 600) plus `· research` in `--muted`, then two nav links in the §2 style: `Watchlist` (`/trade`) and `Autonomy` (`/trade/autonomy`). No operator nav.
- Right, in order: `RegionStatus`, `ConnectButton`, then `Sign in` (plain `--muted` link, `--fs-sm`, to `/login`; it is for the operator and stays small).
- `ConnectButton`: disconnected it reads `Connect wallet` (border `--accent`). With no injected wallet: disabled, visible text `No wallet found`, title `Install a browser wallet such as MetaMask or Rabby`. While the wallet prompt is open: `Connecting…` with the 12px spinner. Connected it becomes `AddressChip`: mono `0x3fa1…9c2e · Polygon`; on another chain `0x3fa1…9c2e · wrong network` in `--warn`. Clicking the chip opens a small `Drawer`-styled menu: full address (copy button), `Switch to Polygon` (when wrong), `Disconnect`. Disconnect forgets the session CLOB credentials; it does not touch the trading key (10.6).
- `RegionStatus` (text plus dot, never a dot alone): `● checking region` (`--muted`, spinner), `● region ok` (`--pos`), `● trading blocked in your region` (`--neg`), `● region check failed` (`--warn`, title has the error and `Retry` in the menu). Hidden until a wallet is connected or the visitor opens a ticket, because the check is only needed to trade.
- `PublicFooter`: one `--muted` `--fs-xs` paragraph, the three sentences above, always visible, not dismissible. Same text in both views.
- No kill switch in the header unless the visitor loop is active; then the `LoopBanner` (10.6) carries `STOP`.
- Global keys: `g w` watchlist, `g a` autonomy, `/` filter, `?` sheet, `t` theme. The operator `g f/c/p/s` are not registered.

### 10.2 Watchlist `/trade`

Data: `GET /api/public/watchlist`, polled every 60 s (`usePoll(url, 60_000)`; pauses while the tab is hidden, refetches on focus). No SSE.

Top bar: `FilterInput` (`filter question / category`), category `<select>` (`All` + categories present), `side` `<select>` (`Any`/`YES`/`NO`), right side `swept 14:32 · refresh in 42s` in `--muted` and the `StaleBanner` slot. No tabs: the public list is the thesis list only (structural sets need the operator book).

`PublicWatchlistTable` (a `DataTable` instance), columns in order:

| # | Header | Field | Fmt |
|---|---|---|---|
| 1 | `Market` | question (truncate 56ch, title full) + category tag | text |
| 2 | `Side` | side | `YES`/`NO` pos/neg |
| 3 | `Price` | mid | `0.000` |
| 4 | `Fair p` | p_post | `0.000` |
| 5 | `Edge¢` | edge_c | `EdgeBadge` |
| 6 | `Conf` | confidence | `0.00`, `--warn` with `*` when capped |
| 7 | `Ends` | end date / days left | `Nov 05 · 18d` |
| 8 | `Thesis` | thesis age | `3h`, `2d`; `--muted` with title `thesis 80h old` over 72h |

No rank, size, E[P] or r_ann (they come from operator sizing). Default sort `Edge¢` desc; every column sortable, client-side, `aria-sort` as §7. Row click or `Enter` → `/trade/[id]`; `j`/`k` move. `p`, `m`, `r` are not bound.

States:
- Loading: `Skeleton` 8 rows.
- Empty, research on: `No theses yet. Markets are scanned daily; the first research run is in progress.`
- Empty, research disabled (server status `research_disabled`): `Research is paused on this instance. Market data still updates.` No retry button.
- Error: `ErrorBar` `Could not load the watchlist. Retrying in 60 s.` with `Retry`; last good rows stay.
- Stale (last sweep > 6 h, or the poll response carries `stale: true`): `StaleBanner` `Data may be out of date · last sweep 09:12 (6 h)`. A refresh started by this read (SPEC: read starts the chain after 30 min) shows `refreshing data…` with the spinner next to the sweep time; the table stays usable.

Mobile (< 720px): the table becomes `WatchlistCardList`, one 2-line row per market (no shadows, 1px `--border` separators): line 1 question (2-line clamp); line 2 mono `YES · 0.412 → 0.470 · +5.8¢ · c 0.62 · 18d`. Filter and selects stack above. Tap opens the detail. Same sort control as a `<select>` (`Sort: Edge`).

### 10.3 Market detail `/trade/[id]`

Data: `GET /api/public/markets/[id]`, polled every 60 s. Layout is §3.3: two columns 60/40, one column under 1100px; on one column the `TradeTicket` moves to directly under `MarketHeader`, so the action is above the fold on a phone.

Left: `← Watchlist` link, `MarketHeader` (with `Open on Polymarket ↗`), `KeyStats`, `PriceHistoryChart`, `DepthChart`, `EvidenceTable` (the sources), `RulesPane`.
Right: `TradeTicket` (10.4), `ThesisPane` in public form, `KillCriteriaList`, `CatalystList`.

- `ThesisPane` public form: header `Thesis · 14:02 · 3h ago` (no model, no judge label). Numbers grid: `Fair p` (p_post), `Price at thesis`, `Edge¢`, `Conf`, `f*`. No `Size$`, `E[P]$`, `r_ann` (operator sizing). Thesis prose, cap/stale/expired lines as §3.3.
- `EstimatesStrip` replaces `AgentEstimates`: one line `base rate 0.41 · news 0.52 · source 0.49 · red team 0.38 → fair 0.47`, roles only, no models, costs or durations.
- `RulesPane`: the market's resolution rules text (ui font, `--fs-sm`, collapsed to 6 lines with `Show full rules`), resolution source link.
- `ActionBar` is not rendered. Not found: `EmptyState` `This market is not on the public list.` with a link back.

### 10.4 TradeTicket

One pane, title `Trade · your wallet`. Owns the ticket state machine; reads wallet and region state from `useWallet()` and `useRegion()`.

Fields (labels left, mono inputs right, unit suffix in `--muted`):
- `Side`: two-option segmented control `BUY YES` / `BUY NO`, prefilled with the thesis side.
- `Limit price`: number, step 0.001, prefilled from `livelimitPrice`; under it `mid 0.412 · best ask 0.420` in `--muted`.
- `Amount`: USD number, prefilled from `sizeTrade` with the visitor's limits (10.6) or empty when no bankroll is set; under it `Balance $214.40`.
- Read-only lines: `Est. shares 520`, `Fee $0.31`, `Max loss $214.40` (amount plus fee; for a buy, the most you can lose), `Payout if right $520.00`.
- Primary button, label by state (below). Above it one line explaining signatures: `Your wallet will ask you to sign this order. Signing sends it to Polymarket; it does not move funds until the order fills.`

States (`ticket.status`; the pane title line shows a short state word as text):

| State | Button | Copy and behavior |
|---|---|---|
| `disconnected` | `Connect wallet` (opens connect) | `Connect a wallet on Polygon to trade. Research above stays free to read.` Fields editable for preview. |
| `wrong_network` | `Switch to Polygon` | `Your wallet is on another network. Polymarket runs on Polygon.` |
| `geo_checking` | disabled `Checking region…` + spinner | `Checking whether Polymarket accepts orders from your location.` |
| `geo_blocked` | disabled `Trading unavailable` | `Polymarket does not accept orders from your region. Research stays available. We do not offer a way around this.` `--neg` left border on the pane. |
| `geo_failed` | disabled `Trading unavailable` + `Retry check` link | `Could not confirm your region, so trading stays off. Retry, or try again later.` `--warn` left border. Fail closed. |
| `creds_needed` | `Enable trading (1 signature)` | `Polymarket needs a one-time signature to create your API key for this session. It is not a transaction and costs nothing.` |
| `allowance_needed` | `Approve USDC (1 transaction)` | `Polymarket's exchange needs permission to spend your USDC. This is an on-chain transaction and costs a little POL for gas. One time per wallet.` |
| `ready` | `Sign and place order` (border `--mode-2`) | fields live; validation errors under fields in `--neg` (`Amount exceeds your balance`, `Price must be between 0.001 and 0.999`, `Above your per-trade max $50`). |
| `signing` | disabled `Confirm in your wallet…` + spinner | `Check your wallet window. Rejecting there cancels nothing; no order was sent.` |
| `submitted` | `Cancel order` | `Order open · ord 0x3fa1… · 0/520 filled`. Polls status every 5 s. |
| `partial` | `Cancel rest` | `Partially filled · 120/520 at 0.418`. |
| `filled` | `New order` | `Filled · 520 shares at 0.419 · fee $0.31` in `--pos`. |
| `error` | `Try again` | `Order failed: <exchange message>` in `--neg`, truncated 80ch, title full. Wallet rejection shows `You rejected the signature. Nothing was sent.` in `--muted`, returns to `ready`. |

Transitions: wallet and region states are checked in this order and the first unmet one wins (`disconnected` → `wrong_network` → `geo_*` → `creds_needed` → `allowance_needed` → `ready`). Changing account or chain in the wallet drops back to the right state and discards session credentials. Placing an order: `ready` → `signing` → `submitted` → `partial`/`filled`, or `error` from `signing`/`submitted`. Cancel from `submitted`/`partial` shows `cancelling…` on the button, then `cancelled · 120/520 filled` in `--muted` and `New order`.

The submit button carries the full-sentence `aria-label` "Sign and place order: buy YES 520 shares at 0.420, up to $218.40". There is no extra confirm step: the wallet prompt is the confirm.

### 10.5 Account panel

`AccountPanel` on `/trade/autonomy` (top) and collapsed under the ticket on detail pages (`Your positions in this market`, filtered). Hidden behind `Connect wallet to see positions` when disconnected.

- `BalanceStrip`: `USDC $214.40 · in orders $50.00 · positions value $88.12` (mono), with the source wallet named: `wallet 0x3fa1…` or `trading key 0x9b7e…` (tabs `Wallet` / `Trading key` when both exist).
- `OpenOrdersTable` (`DataTable`): `ts`, `Market`, `Side`, `Shares`, `Limit`, `Filled` (`120/520`), `Status` (text), `Sent by` (`you` in `--muted`, `AUTO L3`/`AUTO L4` chip), actions `Cancel`. Cancel has no confirm (no money moves); the cell shows `cancelling…` then the row leaves. Header action `Cancel all (3)` asks for a confirm in place, 5 s, like §8.3. Empty: `No open orders.`
- `PositionsTable` reused with columns `Market`, `Side`, `Shares`, `Avg`, `Mid now`, `Unreal $`. No paper chip, no thesis-capture columns. Positions close by placing a sell order on Polymarket; a `Sell on Polymarket ↗` link per row (selling from the ticket is out of scope).
- Data comes from the CLOB client in the browser every 30 s while connected. Error: `ErrorBar` `Could not reach Polymarket. Orders and balances may be out of date.`

### 10.6 Visitor autonomy `/trade/autonomy`

Single column, panes in this order. All state lives in this browser (localStorage, validated by the core zod schema); one line under the title says so: `Settings and the trading key are stored only in this browser. Clearing site data deletes them.`

1. `LoopBanner` (shell-level, shown on every `/trade` page while the loop is not Manual and active): full-width strip under the header, `--mode-N` left border 3px, text `RUNNING · L3 bounded auto · runs only while this tab is open · last check 14:32 · next 14:33`, `STOP` button (`--kill`) at the right. When paused by an error: `PAUSED · <reason>` in `--warn`. `aria-live="polite"` on the state word only.
2. `VisitorModeSelector`: segmented control of four options with `--mode-N` borders, selected filled: `Manual` (`--mode-0`), `L2 Approve each` (`--mode-2`), `L3 Bounded auto` (`--mode-3`), `L4 Full auto` (`--mode-4`). Under the row, the selected mode's plain-language line:
   - Manual: `Nothing runs on its own. You place every order from a market page with your wallet.`
   - L2: `The loop finds trades that fit your limits and queues them below. Nothing is sent until you approve each one.`
   - L3: `The loop sends trades by itself while they stay inside your L3 caps. Anything larger waits for your approval.`
   - L4: `The loop sends any trade inside your risk limits without asking. Use only with an amount you can afford to lose.`
   L2–L4 are disabled until a funded trading key exists and the region check is ok; the reason is visible text under the row (`Create and fund a trading key first.` / `Trading is unavailable in your region.`). Switching to L3 or L4 needs one confirm in place: the option shows `Confirm L4 full auto` for 5 s. Manual is always one click and also stops the loop.
3. `TradingKeyPanel`, states:
   - none: `Create trading key` button. Copy: `A separate key generated in this browser places orders for the loop, so your main wallet is never exposed. Send it only what you are willing to let the loop trade.`
   - created, unfunded: address (mono, copy button), and `Fund it: send USDC on Polygon to this address, plus about 1 POL for the one-time approval transaction. Do not send from an exchange that does not support Polygon.` Balance line `USDC $0.00 · POL 0.00` refreshes every 30 s.
   - funded: `USDC $250.00 · POL 0.98 · ready`.
   - `Export key`: first click shows a warning line `Anyone with this key can spend its funds. Never share it.` and a `Reveal key` button; reveal shows the hex in a mono box with `Copy` and auto-hides after 60 s or on `Hide`.
   - `Forget key` (2-step): button `Forget key` → panel turns `--neg` bordered: `This deletes the key from this browser. Funds still on it are lost unless you exported the key or withdrew first.` with a checkbox `I have exported the key or withdrawn the funds` and `Forget permanently` (enabled only when checked). Disabled with visible reason while the loop runs or orders are open.
   - Withdraw is out of scope; copy points to export.
4. `VisitorLimitsForm` (`FormGroup` + `Field`, §3.8 style, one `Save limits`): `Bankroll $`, `Kelly fraction` (0.25), `Per-trade max $`, `Daily max $`, `L3 per-trade cap $`, `L3 daily auto $`, `Category allowlist` (checkbox list, empty = none allowed for L3). zod errors under fields. Changes apply on the loop's next tick; a dirty form shows `•` and the loop keeps the saved values.
5. `VisitorKillSwitch`: full-width `--kill` button `STOP · cancel open orders`, one line below `Stops the loop and cancels this key's open orders. Your positions stay open.` With 0 open orders: one click. With open orders: `CONFIRM · STOP + CANCEL 3 ORDERS` for 5 s, second click fires, `Esc` aborts (§8.3 pattern). Result on the button 3 s: `STOPPED · 3 cancelled` or `STOPPED · 2 cancelled · 1 FAILED` plus an `ErrorBar` naming the order. Mode returns to Manual. The `LoopBanner` `STOP` is the same action.
6. `VisitorApprovalQueue` (shown at L2, and at L3 for fallbacks; hidden in Manual with the line `Approvals appear in L2 Approve each.`): the §8.1 table and row states (`Approve` → `Send $48.20 live?` `Confirm`/`Cancel`, 10 s revert, `Reject` no confirm, `sending…`), columns `Market`, `Side`, `Shares`, `Limit`, `Cost$`, `Edge¢`, `Drift¢`, `Expires`. L3 fallback reason line as §9.3. Approving signs with the trading key, so there is no wallet prompt; copy above the table: `Approved orders are signed by your trading key in this tab.` Proposals expire after 10 min or a 2¢ move, client-side.
7. `VisitorActivityLog`: newest first, max 200 rows kept in localStorage: `ts`, `event` (`mode → L3`, `proposed`, `sent`, `filled`, `rejected by limits: DAILY_MAX`, `stopped`, `paused: region check failed`), `market`, `detail`. `Clear log` button, no confirm.

Loop behavior visible in the UI: closing or reloading the tab stops the loop; on return the page shows the last mode with `Stopped (tab was closed) · Resume L3` button instead of resuming silently. A failed region recheck, a lost connection to Polymarket for > 2 min, or stale public data (10.2) pauses the loop with the reason in `LoopBanner`.

### 10.7 States, copy, accessibility

- Every async control has four visible states: idle, working (`…` label plus spinner, control disabled), success (text in `--pos` for 3 s or until next action), error (inline `--neg` text, never only a toast).
- Copy rules: English, neutral, short, sentence case, no exclamation marks, no promises of profit. Errors say what happened and what still works (`Research stays available.`). Wallet prompts are always announced before they open (`Your wallet will ask you to…`).
- Loading strings: `Loading watchlist…`, `Loading market…`, `Checking region…`, `Connecting…`, `Confirm in your wallet…`, `Loading positions…`.
- Focus: §1 ring everywhere. After connect, focus returns to the control that opened it. When the ticket changes state, focus stays on the primary button (its label changes in place). Confirm-in-place buttons take focus and `Esc` cancels them.
- `aria-live`: one polite region per `TradeTicket` (state line: `Order open`, `Partially filled 120 of 520`, `Filled`, `Order failed: …`), the `LoopBanner` state word, the approval queue count. `RegionStatus` blocked/failed is `role="status"`. Errors that stop trading (`geo_blocked`, kill failures) use `role="alert"` once.
- Segmented controls are `radiogroup` with arrow-key movement; disabled options keep their reason in visible text.
- Keyboard: ticket fields in order side → price → amount → submit; `Enter` in the amount field submits only in `ready`.
- Chips `AUTO L3`, `AUTO L4`, `RUNNING`, `PAUSED`, `wrong network` are words, never color-only.

Component inventory (new, under `apps/web/components/public/`): `PublicShell`, `PublicFooter`, `ConnectButton`, `AddressChip`, `RegionStatus`, `PublicWatchlistTable`, `WatchlistCardList`, `EstimatesStrip`, `RulesPane`, `TradeTicket`, `AccountPanel`, `BalanceStrip`, `OpenOrdersTable`, `LoopBanner`, `VisitorModeSelector`, `TradingKeyPanel`, `VisitorLimitsForm`, `VisitorKillSwitch`, `VisitorApprovalQueue`, `VisitorActivityLog`. Hooks: `useWallet()` (EIP-1193 connection, address, chainId), `useRegion()` (geoblock check, cached per session), `useClob()` (session creds, orders, balances), `useVisitorLoop()` (mode, limits, tick, proposals, log), `usePoll(url, ms)`. Reused as is: `DataTable`, `FilterInput`, `EdgeBadge`, `NumCell`, `MarketHeader`, `KeyStats`, `PriceHistoryChart`, `DepthChart`, `EvidenceTable`, `KillCriteriaList`, `CatalystList`, `StaleBanner`, `Skeleton`, `EmptyState`, `ErrorBar`, `FormGroup`, `Field`, `MeterBar`, `PositionsTable`; `ThesisPane` gains a `public` prop that hides operator fields.

## 11. Trading terminal (/trade)

Supersedes §10.2–§10.5 for `/trade` and `/trade/[id]` (SPEC "Trading terminal redesign"). Approved direction: B "Graphite Ladder" base, A's permanent key-legend bar, C's blue/orange YES/NO pair. Reference mockup and every state: `docs/design/terminal/final.html` (`final-dark.png`, `final-light.png`, `final-states-dark.png`, `final-states-light.png`; open `final.html?states` for the state board). The mockup's CSS block is the token source; copy it, do not re-derive values from the PNGs. The operator app and `/trade/autonomy` keep the §1 tokens unchanged.

### 11.1 Tokens

Scope: every token lives on the `.term` class (the terminal root element), never on `:root`, so nothing outside `/trade` changes. Dark is the `.term` default; light is `:root[data-theme="light"] .term`. Theme switching reuses the existing `data-theme` attribute and `useTheme()`. The root `THEME_SCRIPT` resolves as before (stored choice, else `prefers-color-scheme`, else dark) except on terminal paths (`/trade`, `/trade/[id]`; one shared regex, `lib/terminalPath.ts`), where no stored choice means dark (planner decision). Leaving the terminal restores the normal resolution.

Fonts: Inter (UI words) and JetBrains Mono (every number, price, size, time, address, key cap) via `next/font/google`, exposed as CSS variables and referenced only through `--t-font-ui` / `--t-font-num`. Numbers always use `font-variant-numeric: tabular-nums`.

| Token | Dark | Light | Use |
|---|---|---|---|
| `--t-bg` | `#0b0d10` | `#eceef2` | page behind panes |
| `--t-pane` | `#13161b` | `#ffffff` | pane surface |
| `--t-pane-2` | `#1a1e25` | `#f4f5f8` | price column, segmented track, skeletons, kbd |
| `--t-line` | `#232830` | `#e1e4ea` | pane borders, row rules |
| `--t-line-2` | `#2f3540` | `#cfd4dc` | input borders, kbd border |
| `--t-text` | `#e4e7ec` | `#161a20` | primary text |
| `--t-dim` | `#8b93a1` | `#5d6573` | labels, secondary |
| `--t-faint` | `#555d6b` | `#9aa1ad` | disabled values |
| `--t-yes` / `--t-yes-bg` / `--t-on-yes` | `#5b9dff` / `rgb(91 157 255/.14)` / `#0b0d10` | `#1f64d6` / `rgb(31 100 214/.10)` / `#fff` | YES identity: outcome card, YES toggle, YES tag, buy-YES button, chart line |
| `--t-no` / `--t-no-bg` / `--t-on-no` | `#ff9142` / `rgb(255 145 66/.14)` / `#0b0d10` | `#c25400` / `rgb(194 84 0/.10)` / `#fff` | NO identity, same places |
| `--t-up` / `--t-up-bg` | `#4cc38a` / `rgb(76 195 138/.13)` | `#0c8a5a` / `rgb(12 138 90/.10)` | price up, payout, live dot |
| `--t-down` / `--t-down-bg` | `#f0616d` / `rgb(240 97 109/.13)` | `#d0364a` / `rgb(208 54 74/.09)` | price down, max loss, errors, geo-blocked border |
| `--t-bid` / `--t-bid-bg` | `= --t-up` / `= --t-up-bg` | same | book bids, BUY prints |
| `--t-ask` / `--t-ask-bg` | `= --t-down` / `= --t-down-bg` | same | book asks, SELL prints |
| `--t-focus` / `--t-focus-bg` | `#9d8cff` / `rgb(157 140 255/.14)` | `#5b45e0` / `rgb(91 69 224/.09)` | keyboard focus ring, selected row, ladder cursor, "mine" sizes, own-order chart line |
| `--t-tint` | `rgb(157 140 255/.24)` | `rgb(91 69 224/.16)` | update highlight start colour (11.7) |
| `--t-warn` / `--t-warn-bg` | `#f5b544` / `rgb(245 181 68/.12)` | `#a86b00` / `rgb(168 107 0/.10)` | stale badge, geo-failed border |
| `--t-shadow` | `none` | `0 1px 2px rgb(20 24 32/.06)` | panes |

Rules: YES/NO colours mean outcome identity only; up/down/bid/ask mean direction only. Never colour a number by outcome and direction at once. Every up/down number carries a sign (`+1.8`, `−0.6`), so colour is never the only signal.

Type (`--t-fs-*` / `--t-lh-*`): `xs` 10.5/14 (kbd, disclaimer), `sm` 11.5/16 (labels, helper lines, tape), `md` 12.5/18 (body, tables; table numbers 12px), `lg` 16/22 (ticket inputs), `xl` 22/28 (YES/NO outcome cards). Pane titles 12px/600 Inter.

Spacing `--t-sp-1..6`: 2, 4, 6, 8, 12, 16 px. Pane gap and page padding = `--t-sp-3` (6px). Pane inner padding = `--t-sp-5` (12px).

Radii: `--t-r-sm` 4 (kbd, tags, badges), `--t-r-md` 6 (inputs, buttons, segmented), `--t-r-lg` 8 (panes).

Heights: `--t-top-h` 44, `--t-ph-h` 34 (pane header), `--t-row-h` 24 (tables), `--t-ladder-h` 22, `--t-tape-h` 19, `--t-input-h` 36, `--t-btn-h` 40, `--t-legend-h` 24. Motion: `--t-tint-ms` 600ms.

### 11.2 Formatting

- Prices are shown and typed in cents. Display decimals = `max(0, tickDecimals(tick) − 2)`: tick 0.01 → `41¢`, tick 0.001 → `41.2¢`. Internally the ticket keeps 0–1 prices: `price = cents / 100`, then `onTick`/`quote`/`validate` from `ticket.ts` unchanged.
- Size is typed in shares. Under the field: `= $206.00` (shares × tick-rounded price). Pass `amount = shares × onTick(price, tick)` into `quote()`; show `q.shares`, never the typed number, in the button and summary (they can differ by the 0.01 share step).
- Sizes: integers with thousands separators; USD `$1,234.56`; times `HH:MM:SS` local; tape `ts` is epoch seconds.

### 11.3 Grid and responsive rule

```
┌ TopBar 44 (logo · MarketSearch · FeedBadge · RegionStatus · ConnectButton/AddressChip · balance) ───────────────┐
├ MarketList 264 ┬ ChartPane minmax(420,1fr) ┬ BookLadder 316 ┬ TicketColumn 312 ─────────────────────────────────┤
│                │ MarketHero + KeyStats     │ (rows 2–3)     │ TerminalTicket (natural height)                 │
│  (rows 2–3)    │ PriceChart                │                │ TradeTape (fills the rest)                      │
│                ├ AccountPane 214 ──────────┤                │                                                 │
├ KeyLegend 24 (full width) ────────────────────────────────────────────────────────────────────────────────────┤
```

- Root: `display:grid; height:100dvh; padding:6px; gap:6px; grid-template-columns: 264px minmax(420px,1fr) 316px 312px; grid-template-rows: 44px 1fr 214px 24px`. The page itself never scrolls at ≥ 1360×760; panes scroll internally (list, tape, account tables).
- 1100–1359 px wide: `MarketList` leaves the grid and becomes an overlay drawer (left, 320px) opened by `/` or the search box; columns become `minmax(400px,1fr) 300px 300px`.
- < 1100 px wide or < 700 px tall: stacked fallback, one column, page scrolls, in this order: MarketHero, TerminalTicket, BookLadder (10 levels per side), PriceChart (240px), TradeTape (20 rows), AccountPane. `KeyLegend` hidden (touch); keys still work. Minimum supported terminal width is 1100; below it is the fallback, not a squeezed grid.
- The compliance disclaimer (§10.1 footer text, full, never truncated) sits at the bottom of `MarketList`; in the drawer and fallback layouts it is the last element of the page.

### 11.4 Component tree (new files under `apps/web/components/terminal/`)

```
TerminalPage({ initialId?: string })                 app/(public)/trade/page.tsx and trade/[id]/page.tsx both render this
├─ data: usePoll<PublicWatchlist>("/api/public/watchlist", 60_000)   → MarketList rows
│        usePoll<PublicMarketDetail>(`/api/public/markets/${id}`, 60_000) → hero meta, history, feeRate, token ids, vol24h
│        useMarketFeed(id) → { data: MarketFeed|null, status, lastAt }   (the ONLY source of book, last, trades, tickSize)
│        useWallet() (+ .clob), useRegion()
├─ TopBar({ feedStatus, feedAt })  → reuses RegionStatus, ConnectButton/AddressChip; FeedBadge({ status, at })
├─ MarketList({ rows, selectedId, onSelect, cursorId, onCursor })  rows: PublicWatchRow; shows question, category, midNow ¢, daysLeft
├─ ChartPane
│   ├─ MarketHero({ market, feed })      question, category, end date, tick, Polymarket link; YES/NO outcome cards (YES = feed.mid ?? snapshot.mid, NO = 1 − YES)
│   ├─ KeyStats({ feed, snapshot })      last, best bid, best ask, spread, min order, vol24h
│   └─ PriceChart({ history, liveMid, ownOrders })   history from detail; liveMid appended as the last point; dashed line per own open order
├─ BookLadder({ feed, status, ownOrders, cursor, onPick })  15 levels per side best-first from feed; Mine columns from clob.orders on this tokenId
├─ TicketColumn
│   ├─ TerminalTicket({ detail, feed, feedStatus, pickedPrice })   see 11.6
│   └─ TradeTape({ trades, status })     feed.trades newest first, ≤ 50; side null → --t-dim
├─ AccountPane({ clob, marks })          tabs Positions / Open orders; marks = feed.mid for selected market, watchlist midNow for others
└─ KeyLegend()                           static list of 11.5 keys, always visible ≥ 1100px
```

Props boundaries: only `TerminalPage` calls data hooks; children are presentational except `TerminalTicket` (owns the order phase machine) and `AccountPane` (calls `clob.cancel`). Selecting a market swaps `id` in state and updates the URL with `router.replace("/trade/" + id, { scroll: false })`; the page component must not remount (no route transition, no full reload, no flash of empty panes: keep the previous market's panes dimmed to `--t-dim` text until the new feed's first payload).

Reuse, unchanged: `useWallet`, `useRegion`, `useClob` (positions, orders, balance, cancel), `useMarketFeed`, `usePoll`, `ticket.ts` (`onTick`, `quote`, `validate`, `tickOf`, `tickDecimals`, `ticketGate`, `placeTicketOrder`, `findPlaced`), the TradeTicket signing flow and its copy. Extract TradeTicket's phase machine (place / recheck / cancel / orderStatus, `Phase` type) into a hook (e.g. `useOrderFlow`) without changing its behaviour, so `TerminalTicket` and its tests share it. `PublicWatchlist`, `PublicMarket`, `AccountPanel` and old `TradeTicket` markup are retired from `/trade` once the terminal ships.

### 11.5 Keyboard map

Registered by `TerminalPage` on `window`. Single-letter keys are ignored while an input, select or textarea has focus (`inInput`), except where a row says "in ticket". The existing global keys stay: `t` theme, `?` sheet, `Esc` blur, `g a` autonomy, `g w` → `/trade`.

| Key | Where | Action |
|---|---|---|
| `/` | anywhere | focus market search (opens the drawer under 1360px) |
| `J` / `K` | anywhere, or search | move the market list cursor down / up (cursor ring, not selection) |
| `⏎` | market list / search | select the cursor market (swaps panes) |
| `B` / `S` | anywhere | ticket side Buy / Sell, then focus Limit |
| `Y` / `N` | anywhere | ticket outcome YES / NO (ladder, chart and hero follow the outcome: NO shows the mirrored book, `1 − p`), then focus Limit |
| `↑` / `↓` | in ticket Limit | ± 1 tick (`feed.tickSize`), clamped to [tick, 1 − tick] |
| `⇧↑` / `⇧↓` | in ticket Limit | ± 10 ticks |
| `↑` / `↓` | in ticket Shares | ± `minOrderSize ?? 1` shares; `⇧` ×10 |
| `Tab` / `⇧Tab` | in ticket | Side → Outcome → Limit → Shares → submit (native order) |
| `⏎` | in ticket field | arm: focus the submit button in its review state (`Sign: Buy 500 YES at 41.2¢`); never sends |
| `⏎` / `⌘⏎` (`Ctrl⏎`) | armed submit / any ticket field | sign and place (calls the flow's `place()`); only when gate is null, phase is idle, feed loaded and `validate` is clean |
| `L` | anywhere | focus BookLadder; `↑↓` move the price cursor one level, `⏎` copies that price to Limit and focuses Shares, `Esc` back |
| `⇧T` | anywhere | focus the ticket (Limit field). Lowercase `t` stays theme |
| `P` / `O` | anywhere | AccountPane tab Positions / Open orders |
| `X` | open-orders row focused, or ticket in phase `open` | cancel that order (ticket: "Cancel rest") |
| `Esc` | anywhere | disarm submit, close drawer/sheet, then blur (global) |
| `?` | anywhere | shortcut sheet listing this table |

Mouse equivalents exist for every key (click a ladder price = `L` + `⏎`). `KeyLegend` shows the first-row subset in the mockup order; the `?` sheet shows all.

### 11.6 Ticket states

Order of precedence for the submit button (first match wins):

1. Feed not loaded (`feed == null`, status `loading`, or `error` with no data): Limit shows `—` and is disabled, tick shows `tick —`, Shares stays typable, button `Waiting for live book…` (spinner, disabled). Helper: `Prices and tick come from the live book. You can type shares now.` No book for the token: `No live book for this market.` and the button stays disabled.
2. `ticketGate(...)` non-null: §10.4 labels and copy unchanged (where the mockup copy differs, e.g. `Research above stays free to read.`, §10.4 wins; the allowance steps say "trading allowances" because the approvals also cover outcome tokens for SELL) (`Connect wallet` outline in `--t-focus`; `geo_blocked` → pane border `--t-down`, inputs disabled, button `Trading blocked in your region`; `geo_failed` → border `--t-warn`; creds / allowance steps as today).
3. Phase machine (from TradeTicket, unchanged): `idle` → `Buy 500 YES at 41.2¢` filled with the outcome colour; armed → same label prefixed `Sign:` with a 2px `--t-focus` ring; `signing` → `Confirm in your wallet…`; `checking`; `open`/partial → `Cancel order` / `Cancel rest`; `filled`; `cancelled`; `unknown` → `Check open orders`; `error` → `Try again` with `Order failed: …` in `--t-down`.

Tick rule: once `feed` has loaded, the ticket uses `feed.tickSize` for `onTick`, `validate`, nudges and display decimals (it overrides `market.tickSize`). Before that, submit is disabled. If `feed.tickSize` changes while a price is typed, re-round with `onTick` and show `Rounded to tick 0.1¢` under the field. `minOrderSize` (when non-null) is enforced: `Minimum order is 5 shares`.

Sell: `S` enables a sell of the selected outcome's token, capped at the held shares from `clob.positions[tokenId]`. With no shares the Sell segment is disabled with visible text `No YES shares to sell`. Sell summary: `Proceeds`, `Fee (max)`; no `Max loss`/`Payout`. Sell needs a sell quote next to `quote()` in `ticket.ts` (proceeds = shares × price − taker fee); reuse `placeTicketOrder` with `side: "SELL"`.

The price prefill when a market is selected: best ask for Buy, best bid for Sell, of the chosen outcome, from the feed. Field values survive feed polls; only a market switch or `New order` resets them. Changing side (`B`/`S`) or outcome (`Y`/`N`) re-prefills Limit from the new side/outcome book (intended: the old price belongs to the other book); Shares are kept. Side and outcome are locked while the ticket is not editable, and a market switch is blocked while an order is `signing`, `checking` or `unknown` (the list shows `Finish or check the current order first`).

### 11.7 Live updates, stale, error

- `FeedBadge` in the top bar: `loading` → spinner + `connecting feed…` (`--t-dim`); `live` → dot + `live · HH:MM:SS` of `feed.at` (`--t-up`); `stale` → `stale · 14s old` on `--t-warn-bg`; `error` → `feed error · retrying` on `--t-down-bg` (keeps the last good data if any).
- Book, tape, hero and KeyStats keep the last good feed while stale or erroring; nothing is cleared or recoloured. BookLadder header repeats the stale badge. Loading (no data yet) shows 5 skeleton rows per pane.
- Update highlight: when a book level's size changes at the same price, or a new tape row arrives, only that cell gets `animation: tint var(--t-tint-ms) ease-out` from `--t-tint` to transparent. No text colour change, no arrows, no blinking, no row reordering animation. Under `prefers-reduced-motion: reduce` there is no animation at all. Diff by price key between consecutive feed payloads; the first payload after a market switch highlights nothing.
- Prices never flash red/green on change; the hero YES/NO numbers just update.

### 11.8 Accessibility

§7 and §10.7 rules apply, with these changes: the ticket submits only through the arm-then-sign path in 11.5 (replaces §10.7's "Enter in the amount field submits"); the ladder is a `grid` with `aria-label="Order book, YES, in cents"` and roving tabindex; FeedBadge is `role="status"` with the text, never a dot alone; key caps are `<kbd>` inside the visible label, and every keyboard action has a button or click target with the same name.

## 12. Rev 7 — unified terminal

Scope: SPEC "Rev 7 — Polyscout merge", "Unified terminal". One authenticated shell for Screener, Watchlist (+ alerts), Runs, Research, Journal, Book, Autonomy, Settings, with `/trade` (§11) one click away in both directions. Polyscout's views come over as behaviours; their look is re-expressed with the §1 tokens and §5 components. Nothing in §11 (terminal internals, `.term` tokens, 11.5 key map) changes except the two additions in 12.1.4. Sections 2–5 stay in force where this section is silent; where they conflict, this section wins.

### 12.1 Shell

#### 12.1.1 Token strategy: two palettes, one set of shapes

The operator shell keeps the §1 `:root` tokens; `/trade` keeps the §11.1 `.term` tokens. Neither adopts the other's colours (the terminal's purple focus and blue/orange YES/NO would collide with `--accent` and `--mode-*` meanings in the operator app; the operator's `--pos`/`--neg` for YES/NO would break 11.1's "identity ≠ direction" rule). What is shared is shape and language, implemented once in `globals.css` with no token prefix:

- Wordmark: both headers read `PM/EDGE` in the mono font, 600, with the `/` coloured `--accent` (operator) or `--t-focus` (terminal). The terminal keeps its ` terminal` suffix; the operator header has none.
- `<kbd>` caps: one `kbd` rule in `globals.css`: `font: 500 10px/14px var(--font-mono); padding: 0 4px; border: 1px solid var(--border); border-bottom-width: 2px; border-radius: var(--radius); color: var(--muted); background: var(--surface-2)`. Inside `.term` the existing 11.1 rule already matches this geometry with `--t-*` tokens; leave it.
- Status language: text plus dot, never a dot alone; the operator `SseIndicator` now reads `live · 14:02:11` (`--pos`), `reconnecting · 3s` (`--warn`, blinking dot, counts down to the next retry), `offline · retrying` (`--neg`). Same pattern as `FeedBadge` (11.7).
- Selection: 2px left bar `--accent` + `--surface-2` row (DataTable today) is the only selection style in both apps (`--t-focus` in the terminal).
- Help sheet: the operator `?` dialog adopts the terminal's two-column `<kbd>` layout, grouped by scope (`Global`, then the current view).

New `:root` tokens (dark / light), all checked ≥ 4.5:1 on `--surface`:

| Token | Dark | Light | Use |
|---|---|---|---|
| `--badge-s` | `#a58bf5` | `#6a4bd1` | structural mispricing badge `S` |
| `--badge-c` | `#d97bb0` | `#a63a78` | contrarian badge `C` |

Everything else reuses existing tokens: pinned `--accent`, has-thesis `--pos`, stale `--warn`, running `--accent`, DSL classes below. Tinted fills are `color-mix(in srgb, var(--X) 15%, transparent)`; no new fill tokens.

#### 12.1.2 Header (40px, unchanged geometry)

Nav order and labels, left to right: `Screener` `/markets` · `Watchlist` `/watchlist` · `Trade` `/trade` · `Runs` `/runs` · `Research` `/research` · `Journal` `/journal` · `Book` `/paper` · `Autonomy` `/autonomy` · `Settings` `/settings`. `Trade` is a plain `<a>` (route group change; it leaves the operator shell). `Runs` carries a superscript count of live pods (`--accent`, mono 10px) when > 0; `Watchlist` carries the unacked alert count the same way. Hovering a nav item shows its `g` chord as a `<kbd>` after the label (hidden otherwise). Right side unchanged: `find market`, `theme`, `SseIndicator`, `ModeBadge`, `ApprovalsBadge`, `KillSwitchButton`. Active item: `--text` + 2px bottom `--accent` as today.

Redirects (permanent): `/fleet` → `/runs`, `/calibration` → `/journal`. `/m/[id]` from §2 was never built; the detail stays at `/markets/[id]`, so `/markets` as the Screener makes list → detail one path.

#### 12.1.3 Keyboard (`useGlobalKeys`, `GO` map)

| Chord | Goes to | Note |
|---|---|---|
| `g m` | `/markets` Screener | new (m = markets) |
| `g w` | `/watchlist` | kept |
| `g t` | `/trade` | new; lowercase `t` alone stays theme |
| `g f` | `/runs` | kept from Fleet (muscle memory; the sheet says "runs (fleet)") |
| `g r` | `/research` | kept |
| `g j` | `/journal` | new; `g c` also goes to `/journal` but is not listed |
| `g p` | `/paper` Book | kept |
| `g a` | `/autonomy` | kept |
| `g s` | `/settings` | kept |
| `g n` | toggles the alerts drawer (12.5) | new; not a route |

`/` rule change: if the current view has an input with `data-filter` (screener query bar, watchlist `FilterInput`, research list filter), `/` focuses the first one; otherwise it opens `MarketSearch` as today. `Esc`, `?`, `t` unchanged. `j`/`k`/`Enter` stay DataTable's. View keys are listed per view below and in the `?` sheet under the view's name; `SHORTCUTS` becomes `{ scope, keys }[]`.

#### 12.1.4 Cross-links with `/trade`

- Operator → terminal: the `Trade` nav item and `g t`. Leaving does not touch theme storage; 11.1's "dark when unset" rule still applies on terminal paths.
- Terminal → operator: `TopBar` gets a link `← Operator` to `/markets` right after the logo, `--t-dim` text, `--t-text` on hover, 11.5 `locked` rule applies (blocked while an order is mid-send, same `onBlocked` message). It renders only when a session exists: `TerminalPage` calls `GET /api/session` once on mount (`{ operator: boolean }`, 200 for everyone, no caching headers) and keeps the answer in state. Anonymous visitors never see the link. The terminal's `g` map gains `g o` → `/markets` under the same condition; `KeyLegend` is unchanged (the `?` sheet lists `g o`).

#### 12.1.5 Status bar (new, `StatusBar.tsx`)

Fixed bottom, full width, 24px, `--surface`, 1px top border `--border`, mono `--fs-xs`, `--muted` by default. `main` padding-bottom becomes `36px`. Segments separated by `│` in `--faint` with `8px` padding each side, left to right:

1. `SseIndicator` (moves here from the header; the header keeps `ModeBadge`, `ApprovalsBadge`, `KillSwitchButton`). While not `live`, a 2px `--warn` line runs along the top edge of the bar.
2. `runs 2 active` (`--text`) or `runs idle` (`--muted`). Click → `/runs`. `title` lists `podId8 · stage · market` per live pod.
3. `spend $4.12 / $25.00` + `MeterBar` 80px. Fill `--accent` < 80 %, `--warn` ≥ 80 %, `--neg` ≥ 100 % where the label reads `cap reached $25.40 / $25.00`. Click → `/settings#budget`.
4. `snapshot 7m · sweep 2h` ingest ages from the latest `snapshots.ts` and the latest sweep. Each age is `--text` under 2× its cadence, `--warn` to 6×, `--neg` beyond (cadences: snapshot 15 min, sweep 24 h; `STALE_MS` stays the banner rule).
5. `alerts 3` in `--warn` when unacked > 0 (`alerts 0` muted). Click or `g n` opens the alerts drawer (12.5). `aria-label="3 unacknowledged alerts"`.
6. `14:02:11 UTC`, right-aligned (margin-left auto), ticks each second with tabular nums; a pending `g` chord shows `g…` in `--accent` just before the clock for 800 ms.

Data: one `GET /api/status` (`{ activeRuns: {id, stage, question}[], spendTodayUsd, dailyCapUsd, lastSnapshotAt, lastSweepAt, unackedAlerts }`) fetched on mount, on `pod.*`, `snapshot.done`, `sweep.done`, `alert.created` (new SSE event) and every 30 s while SSE is not live. Under 1100px the ingest and clock segments hide; the bar never wraps.

### 12.2 Screener `/markets`

Layout: a 32px bar row (`ViewMenu` 200px · `QueryBar` flex · `312 mkts` + `[c] cols` 120px), then a row with `FilterPanel` 240px left rail (toggle `f`, open by default, collapsed state in `localStorage pm.screener.panel`) and the table filling the rest. The table scroll container is `calc(100dvh − 40 − 24 − 32 − 36px)`; the page itself does not scroll. URL is the truth: `/markets?q=<query>&view=<id>`; `q` is written with `router.replace` 250 ms after the last valid parse.

**QueryBar**: single-line `<input data-filter>` 32px, mono `--fs-md`, `--surface-2` bg, 1px `--border`, focus ring per §1. The text is transparent with `caret-color: var(--text)`; a `DslHighlighter` mirror sits under it (`pointer-events: none`, scroll-synced by `translateX(−scrollLeft)`). Token classes, one CSS class each in `screener.module.css`: `.key` `--accent` (known key), `.op` `--muted` (`:` `..` `,` `>` `<`), `.val` `--text`, `.neg` `--neg` (a leading `-` on a key or value), `.word` `--muted` (bare text search), `.err` `text-decoration: underline wavy var(--neg)` on the whole token that `parseQuery` reported at that `col` (unknown key, bad range, bad enum). Parsing runs on every keystroke with `parseQuery` from `@pm/core`; a valid parse fetches `GET /api/markets?q=` after 250 ms; an invalid parse fetches nothing and dims the table to 60 % opacity (last good rows stay).

**Error line** (under the bar, 16px, mono `--fs-xs`): `⚠ col 41: unknown key "sprd"` in `--neg`, followed by a suggestion chip when `error.suggestion` exists: a `<button>` styled as a `kbd` cap reading `spread` with `title="replace (Tab)"`; clicking it or pressing `Tab` while the caret is inside the bad token and no hint list is open replaces that token's key and re-parses. More than one error: ` · +2 more` in `--muted`; only the first is shown.

**Hints** (`DslHints`): a `role=listbox` popover under the bar, 420px, `--surface`, 1px `--border`, `box-shadow: 0 8px 24px var(--backdrop)`, rows 26px. It opens while typing the key part of a token and lists `DSL_KEYS` entries whose `key` or alias starts with the typed prefix: `key` in `--accent` (mono), `example` in `--text`, `description` in `--muted` (ui font, truncated). After `tag:`, `cat:`, `src:`, `struct:`, `is:`, `has:` it lists known values (tags/categories from the loaded rows, enums from core). `↓`/`↑` move, `Tab`/`Enter` accept (inserts `key:` and keeps the caret), `Esc` closes the list, a second `Esc` blurs. Keys (SPEC "DSL fields"): `liq vol24h depth spread price days stale top1 holders tag cat src struct prio opp edge sort is has limit offset`.

**FilterPanel**: `Filter` is the single source of truth (`useScreenerFilter`): bar text → `parseQuery` → `Filter` → panel; a panel edit → `formatQuery(filter)` replaces the bar text verbatim. Sections (collapsible `<details>` with the §5 pane title style): Liquidity & volume (`liq`, `vol24h`), Book (`depth`, `spread`, `price`), Time (`days`, `stale`), Crowd (`top1`, `holders`), Resolution (`src` checkboxes), Structural (`struct` checkboxes), Scores (`prio`, `opp`, `edge`), Flags (`is:watch`, `is:pinned`, `is:muted`, `has:thesis` as tri-state `any / yes / no`), Tags & category (`TagInput` chips; exclude chips show `−tag` in `--neg`). Each range is two 64px mono inputs `[min]..[max]` accepting `2k`, `1.5M`, `0.06`, `6¢`, committing on blur or `Enter`. While the bar has an error the panel is disabled and shows `query has errors` in `--warn` at its top.

**ViewMenu**: a 200px button `Default ▾` (name, `•` in `--accent` when `formatQuery(filter)` differs from the view's canonical query). Menu (`role=menu`, same popover style): `Default` (built from Settings → Filters: `days:{min}..{max} depth:>{minDepth} sort:-prio`, read-only), the rows of `GET /api/views`, a divider, `Save as…` (`Ctrl+S`; 360px dialog with one name field, `POST /api/views {name, query, columns}`), `Rename`, `Delete` (saved views only; delete asks `Delete view "Asymmetry"?`), `Revert`. Picking a view sets `q` and `view`, and applies the view's `columns`.

**Table**: `DataTable` gains `virtual?: { rowHeight: 26; overscan: 20 }`. When set: `table-layout: fixed`, every column has a `width`, and only the visible window renders between two spacer `<tr>`s whose heights are the hidden rows × 26. Infinite pages: when the selection or scroll is within 50 rows of the end, fetch the next page by appending `offset:` to the query (`limit` 200). Sorting a header writes `sort:-prio,days` back into the query (shift-click adds a secondary); the bar stays the truth.

Default columns, in order (`market_latest` unless noted): `flags` 64 · `Market` flex ≥ 280 (`MarketCell`) · `Mid` 56 (`p` fmt) · `Sprd` 48 (cents, 1 dp) · `Liq` 64 (`usd`) · `Vol24` 60 (`usd`, markets) · `D±2¢` 60 (`usd`) · `Days` 44 (`int`) · `Stale` 48 (`18h` / `4d` since `last_trade_ts`) · `Top1` 48 (`pct`) · `Src` 40 (`off sch med sub unk`, title = full name) · `Prio` 44 (`0.00`, cell bg `color-mix(--accent, priority×20%)`) · `Opp` 52 (`opportunity.o`, 3 s.f., `—` when null) · `Edge¢` 56 (`EdgeBadge` from `opportunity.edge`). Default sort `sort:-prio`. Extra columns in the picker: `bid ask d1c d5c exit cap holders hhi top5 flow24 (signed usd) ticket (median) lasttrade end (YYYY-MM-DD) cat`.

Badges (`Badge`, 14×14, 1px border + 10px mono 600 letter in the badge colour, 15 % tint fill; `title` gives the reason) in fixed order `● S C T Z`: `●` pinned (`--accent` dot, not boxed, as the Watchlist), `S` structural (`--badge-s`, title lists `structural[]` kinds), `C` contrarian (`--badge-c`, `opportunity.contrarian`), `T` has-thesis (`--pos`), `Z` stale (`--warn`, `last_trade_ts` older than 48 h, title `no trade for 3d`).

**Column picker**: popover from `[c] cols` (`c`), 256px: `Columns` title + `Reset`, then every column as a checkbox row (26px, mono label), visible ones first with `↑`/`↓` buttons (no drag). Persists in `localStorage pm.cols.<viewId>` and into `views.columns` on save.

**States**: loading `Skeleton` 20 rows; empty `No markets match. Loosen a range or drop a tag.` with `Clear query`; error `ErrorBar` above the table, last rows kept; stale (snapshot > `STALE_MS`) uses `DataTable muted`. Count cell shows the §4 spinner while refetching (`312 mkts`).

**Keys** (view scope, ignored in inputs): `/` focus bar · `j`/`k` select · `Enter` open `/markets/[id]` · `p` pin/unpin · `m` mute/unmute · `r` research (same endpoints as Watchlist, optimistic, `ErrorBar` on failure) · `f` filter panel · `c` columns · `v` view menu · `Ctrl+S` save view · `Esc` close popover, then blur. A row selected for 300 ms prefetches its detail (`router.prefetch`).

### 12.3 Runs `/runs` and `/runs/[podId]`

Route decision: `/runs/[podId]` (not `/fleet/...`); `/fleet` redirects. APIs: `/api/fleet` unchanged for the list, new `GET /api/pods/[id]` (pod, agents with `tool_calls`, evidence, thesis/result, budget) and `POST /api/pods/[id]/cancel`.

**List**: `BudgetStrip` unchanged, then `PodTable` with two column changes: `Stage` after `Status` (text `rules · agents · judge · sizing · done`, `--accent` while live, `--muted` otherwise) and `Cost` after `Tokens` (`$1.42`). Row click / `Enter` navigates to `/runs/[podId]` (the expand-in-place from 3.4 is retired). Live pods stay pinned on top; the one allowed flash stays. Empty: `No runs yet. Press r on a market.`

**Detail** (one column, panes in this order):

1. `RunHeader` pane: `← Runs` link; line 1: `StatusDot` + status, question (link to `/markets/[id]`, truncated 72ch), `pod 7f3a2c1d`, `started 09:12:04`, `elapsed 06:41` (ticks each second while live), right: `Cancel` button (`--neg` border/text, transparent bg, label `[x] Cancel`), shown only while status is `queued`/`running`/`judging`. Line 2: `StageStepper` left, `CostMeter` right.
2. `StageStepper`: `rules ─ agents ─ judge ─ sizing ─ done` in mono `--fs-sm`; completed stages `--pos` joined by `━`, the current stage `--accent` 600, pending `--faint` joined by `─`. On `failed`/`cancelled` the last node is replaced by `✕ failed` (`--neg`) or `⊘ cancelled` (`--muted`); the stepper stops at `pods.stage`.
3. `CostMeter`: `$1.42 / $3.00` + `MeterBar` 120px (same thresholds as the status bar) + `Σ 31 tools` in `--muted`. Per-pod budget = `settings.budget.perPodUsd` when present, else `dailyCapUsd / maxPodsPerDay`; the `title` says which.
4. `ResultCard` (only when `done`; on `failed` an `ErrorBar` with the error and the stage reached stands here): headline row in mono `--fs-lg` 600 with `--muted` labels: `p̂ 0.470` · `p_post 0.455` · `p_pre 0.440` · `mid 0.425` · `Edge¢ +3.2` (`EdgeBadge`) · `c 0.62`. Second row mono `--fs-md`: `BUY YES ≤ $180 · E[P] +$18.4 · r_ann 143% · payoff 1.35× · 23d`, side coloured `--pos`/`--neg` as the Watchlist; when the thesis has no positive edge the row reads `NO TRADE · best side YES edge −0.4¢` in `--muted`. Third row: `contrarian C` badge when flagged, `Open thesis →` link to the market. Thesis prose is not repeated here.
5. `AgentTable` (`AgentRunTable` extended; `DataTable`, `keys` on): `Role` (R S B N J order) · `Model` · `Status` (`StatusDot`; `running` = `--accent`) · `Started` · `Dur` (live tick) · `Tokens in/out` · `Cost` · `Tools` (count) · `p` (`—` for rules) · `retry` tag. Rows with status `running` carry a 1px `--accent` left border in addition to the selection bar. `Enter`/click expands the row in place (`renderExpanded`) with `ToolCallLog`; `view output` link opens the existing `Drawer` with the JSON.
6. `ToolCallLog`: `agent_runs.tool_calls` chronological, mono `--fs-sm`, one line per call: `09:14:02` (`--muted`) `web_search` (`--accent`) then `input` truncated to the cell (full in `title`); `ok:false` appends `→ error` in `--neg`. Max height 320px, scrolls; autoscroll only while already at the bottom, otherwise a `↓ 4 new` chip (kbd style) at the bottom right. Empty: `No tool calls recorded.`
7. `EvidenceStream` pane: all evidence rows for this pod newest first, `EvidenceTable` columns plus a leading `Role` column; title `Evidence (14)`. Empty `No evidence yet`.

**Cancel**: `x` or the button opens a native `<dialog>` (`.sheet` style, 360px): `Cancel run? Agents that finished are kept; no thesis will be written.` with `Keep (Esc)` and `Cancel run (Enter)` (the latter `--neg` filled). Confirm → `POST .../cancel`, button reads `cancelling…` disabled until `pod.done`/`pod.failed`/`pod.cancelled` arrives or the poll shows `cancelled`.

**Live**: refetch on SSE `pod.started|agent|done|failed|cancelled` for this pod; while the pod is live also poll `GET /api/pods/[id]` every 5 s (SPEC: runs must be live across instances). The elapsed and duration cells tick locally.

### 12.4 Journal `/journal` (replaces Calibration)

Controls row (`panels.module.css .controls`): `category`, `model`, `window` selects as today, plus `group by` (`category · model · liquidity band · R bucket`) and `min n` (number, default 5). All in the URL.

Panes, top to bottom:

1. `KpiStrip` (`.strip`, 6 cells, each: `--muted` ui label over a mono `--fs-xl` 600 value — the one place `--fs-xl` appears outside the header): `Resolved 41` · `Brier model · mkt · Δ` `0.184 · 0.201 · −0.017` (Δ via `Delta`, `--pos` when ours < market) · `Log loss 0.55` · `Pre → final 0.192 → 0.184` · `Drift 24h · 7d` `+0.6¢ +1.4¢` (`EdgeBadge` semantics; positive = moved toward p̂) · `Paper P&L +$412` (signed, `--pos`/`--neg`). Under 30 resolved a 7th muted cell reads `12/30 resolved · refit unlocks at 30`.
2. Two-up (`.half`): left `Reliability` (existing `ReliabilityChart` + its Brier line, unchanged); right `Paper P&L` (`PnlCurve`, SVG 100% × 220): cumulative `journal.paper_pnl` ordered by `resolved_at`, step line `--text` 1.5px, area between the line and zero filled `color-mix(--pos 15%)` above and `color-mix(--neg 15%)` below, zero axis `--muted`, y labels `$`, x first/last date. Hover tooltip `MM-DD · +$412 · n 23` (§5 chart rules).
3. Two-up: left `Brier · model vs market vs pre-reveal` (`BrierCompareChart`, SVG 100% × 200): rolling-20 Brier over resolution order, three lines: model `--text` solid, market `--muted` dashed `4 3`, pre-reveal `--accent` dotted `1 3`; fill between model and market `color-mix(--pos 15%)` where model is lower, `--neg` where higher. Legend as text in the pane title line: `— model  ╌ market  ⋯ pre-reveal`. Needs ≥ 20 rows; otherwise `EmptyState` `Rolling Brier needs 20 resolved theses (n=12).` Right `Drift toward p̂` (`DriftHistogram`, SVG 100% × 200): 1¢ bins from −10 to +10 (clamped), two bar series side by side, 24h `--text`, 7d `--muted`, mean markers as dashed verticals in the series colour with labels `μ24 +0.6¢`, `μ7 +1.4¢`. x labels every 5¢ with signs.
4. `BreakdownTable` (replaces `BrierTable`; `DataTable`): `Group` · `n` · `Brier` · `Mkt Brier` · `Δ` (`Delta`) · `Pre Brier` · `Log loss` · `Drift 7d` (`EdgeBadge`) · `P&L` (signed usd) · `Hit %` · `c` · `gate` (`12/30`, as 3.5). Groups with `n < min n` render `--muted` and sort last. Liquidity bands: `<$5k`, `$5–25k`, `$25–100k`, `>$100k`; R buckets: `<0.3`, `0.3–0.6`, `>0.6`.
5. When `settings.suggested` is non-null, a one-line `.bar .barWarn`: `Refit suggested from n=34: extremize 1.00 → 1.12 · apply in Settings →` (link to `/settings#calibration`). Apply never happens here.

Empty (0 resolved): `No resolved theses yet. Edge is measured forward; rows appear as markets resolve.` Charts still render with an `n=12 · low confidence` watermark in `--faint` (`--fs-xs`, top-right) below 30.

**Refit card (Settings)**: a new `FormGroup` `Calibration` (`id="calibration"`) with the `extremize` field (number, 2 dp, unit `×`, range 0.5–2) and, only when `suggested` exists, a `SuggestedRefit` block above the field: title `Suggested from journal (n=34, computed 2026-10-19)`, a 3-column mono table `component · current · suggested · Δ` (one row: `extremize 1.00 1.12 +0.12`), buttons `Dismiss` (clears `suggested`, `POST /api/settings`) and `Apply suggested` (`--accent` filled; confirm dialog repeats the row: `Apply extremize 1.12? Future p̂ blends use it; past journal rows are not rewritten.`). Apply writes `extremize` and clears `suggested` on its own, independent of the group's Save; it is disabled with the hint `Save or discard edits first` while the group is dirty.

### 12.5 Alerts

**Drawer**: the existing `Drawer` (`<dialog>`), restyled as a right rail: `position: fixed; inset: 40px 0 24px auto; width: 360px; height: auto; margin: 0; border-left: 1px solid var(--border)`; backdrop `--backdrop`. Title `Alerts · 3 unacked`; head right: `ack all (A)` button when unacked > 0 and a `show acked` checkbox (default off; on, the last 50 acked rows render muted below a `.divider acked`). Opens from the status bar segment, `g n`, or the `Watchlist` alerts tab's `open drawer` link. `Esc` closes (native). Data: `GET /api/alerts?acked=0|1&limit=`, refetched on SSE `alert.created`/`alert.acked` and every 30 s otherwise.

**Watchlist tab**: `Tabs` gains `Alerts` (count = unacked) after `Structural`. The tab body is the same `AlertsList` component as the drawer at full width (max 720px), with the `show acked` checkbox in the watchlist bar.

**Item anatomy** (`AlertItem`, `<li role=option>`, min height 44px, 1px bottom `--border`, selected = 2px left `--accent` + `--surface-2`): column 1 `●` `--accent` unacked / `○` `--faint` acked (`aria-label`). Column 2, line 1 mono `--fs-sm`: `09:31` (`--muted`) · kind glyph · kind label; line 2 ui `--fs-md`: `message` truncated (full in `title`); line 3 (when `condition_id`) `MarketCell` style question in `--muted`. Column 3: `[ack]` kbd-style button on unacked rows. Unacked rows: `--text` 600 on lines 1–2; acked: `--muted` 400. Glyphs by kind: `mid_move` `↕` (`--text`; `data.deltaC` appended to the kind, signed `EdgeBadge`), `catalyst_passed` `⏱` (`--warn`), `new_candidate` `▲` (`--pos`), `structural` `◆` (`--badge-s`), `run_failed` `✕` (`--neg`). Click/`Enter` acks and opens: `run_failed` → `/runs/[podId]` from `data.podId`, others → `/markets/[condition_id]`.

**Ack**: `a` acks the selected row, `A` acks all (`POST /api/alerts/[id]/ack`, `POST /api/alerts/ack-all`); optimistic (row flips to acked at once; status bar count decrements), rollback + `ErrorBar` `Ack failed: …` on error. Keys `j`/`k`/`Enter`/`a`/`A` are scoped to the list while the drawer is open or the tab is active. Empty: `No alerts.` (unacked) / `Nothing acked yet.` Dedupe (6 h per kind + market) is server-side; the UI shows no grouping.

### 12.6 Market detail additions (`/markets/[id]`)

1. `MarketHeader` meta line gains the structural badges after `status`: the same `Badge` as 12.2 (`S` once per `structural[]` kind with its reason in `title`, e.g. `overround +4.1¢ net of fees`, `ladder: P(≥3.1) > P(≥3.0)`, `sibling sum 1.06`), then `C` and `Z` under the same rules. `KeyStats` is unchanged.
2. `Price history` pane title gets a right-aligned segmented control `1D 1W 1M ALL` (`role=radiogroup`, mono `--fs-xs` buttons 22px high, selected `--text` 600 on `--surface-2` with 1px `--border`, others `--muted`; keys `[`/`]` step it while the detail view has focus). Default `1M`, kept in the URL `?range=`. The pane fetches `GET /api/markets/[id]/history?range=` (server downsamples to ≤ 600 points); `PriceHistoryChart` is unchanged apart from receiving the slice and its thesis markers filtered to the range. Empty per range: `No points in the last day`.
3. New pane `Slippage` under `Book` (`SlippageCurve`, SVG 100% × 140, same chart rules as §5): x = order size in USD on a log scale with ticks `$10 $100 $1k $10k`, y = average fill price (`p`, 3 dp, range from best ask to best ask + 10¢). Line `--text` 1.5px; dashed `--muted` horizontal at the best ask labelled `ask 0.420`; dotted `--faint` verticals at `capacity(ε)` for ε = 0.5¢, 1¢, 2¢ labelled `0.5¢ $620` etc. in `--muted` `--fs-xs`. A `YES NO` segmented control in the pane title picks the side (default = thesis side, else YES; NO uses the complement book). Hover: `$1,200 → avg 0.431 · slip +1.1¢`. `aria-label` `Slippage curve, YES, capacity at 1¢ $1,840`. Under 2 levels: `Not enough depth for a curve.`
4. New pane `Metrics` under `Slippage` (`MetricsGrid`, `<dl>` in 4 columns, `--fs-sm`, label `--muted` ui left, value mono right, 24px rows): `mid · bid · ask · spread (¢) · fee · liq · vol24h · OI · d±1¢ · d±2¢ · d±5¢ · exit depth · capacity (@1¢) · holders · HHI (2 dp) · top1 · top5 · flow 24h (signed usd, `--pos`/`--neg`) · median ticket · large trade 24h (`yes`/`—`) · last trade (ago) · stale (h) · priority (2 dp) · src`. Null → `—` in `--muted`. All values come from `market_latest` plus the market row; nothing is computed client-side.
5. Right column unchanged. The detail's `← Watchlist` link becomes `← Back` and returns to the referring list (`/markets` or `/watchlist`, read from `document.referrer` path, default `/markets`).

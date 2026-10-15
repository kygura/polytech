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

1. `ModeSelector`: five `ModeOption` radio-like buttons in a row. Each shows `L0 Observe`, `L1 Paper`, `L2 Approve each`, `L3 Bounded auto`, `L4 Full auto`, colored border by `--mode-N`, selected one filled. L2–L4 are rendered `disabled` (`--faint` text, cursor not-allowed) with a line under the row: `L2–L4 disabled: Execution ships in phase 6`. Clicking an enabled option fires `POST /api/autonomy/mode` immediately (no confirm; SPEC one action). The server reply updates `ModeBadge` in the header via SSE. If the server refuses (`EXECUTION_DISABLED`) show the reason inline in `--neg`.
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
- Risk limits: the full list from SPEC (per-trade USD and %B, per-market, per-event, per-category, total open, daily notional, daily loss, L3 auto ceiling, daily auto notional, category allowlist, structural auto yes/no). L3 fields are editable but labeled `(applies from phase 6)`.
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

`1`–`6` or `Tab`/`Shift-Tab` switch views (order as nav), `j`/`k` or arrows move, `Enter` open, `Esc`/`Backspace` back, `/` filter (type, `Enter` apply, `Esc` clear), `s` cycle sort column, `S` flip direction, `r` re-research, `p` pin, `m` mute, `K` kill switch (capital, immediate, no prompt; footer shows `KILLED → L0` for 3s), `R` force refresh, `?` help overlay, `q` quit. Mode change: in Autonomy view `0`/`1` set L0/L1; `2`–`4` show `disabled: Execution ships in phase 6` in the footer.

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
 Mode   [L0 Observe]  [L1 PAPER]  L2 Approve  L3 Bounded  L4 Full      ← L2–L4 disabled: Execution ships in phase 6
 Overrides   politics: inherit   crypto: L0   sports: L0            (o to edit, only lowering allowed)
 Limits      per-trade $250 (5%)  used 0 ▏          daily loss $500  used $0 ▏
 Gates       L1→L2  12/50 resolved · Brier 0.182 vs mkt 0.201 ✓        advisory
             L2→L3  0/30 approved trades                               phase 6
             L3→L4  0/100 live trades                                  phase 6
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

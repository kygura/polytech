# Research Profiles — UI Design

Scope: operator web app only (`(app)` group). Obeys root `DESIGN.md`: dense, calm, no cards/shadows, existing tokens only (`--surface`, `--surface-2`, `--border`, `--muted`, `--accent`, `--pos/--neg/--warn`, `--sp-*`, `--radius`, `--fs-*`, `--font-mono` for numbers/ids). No new colors, fonts, radii. All new CSS goes in one `research.module.css`; reuse `pane`, `ui.module.css` (`grid2`, `unit`, `err`, `drawer`), `DataTable`, `FormGroup`, `Field`, `EmptyState`, `ErrorBar`, `Skeleton`, `StatusDot`, `MeterBar`.

Decision record: where the spec is silent I picked the cheaper option and noted it ("pick:").

## 1. `/research` page layout

Pick: **list/detail split**, not a drawer. Why: the editor has ~20 fields plus a preview result table; the existing `Drawer` is 640px max and modal (it holds a `<pre>` in Fleet). A drawer would hide the list you are editing against and cannot sit next to a result table. The market-page steered run is a *small* override form, so the drawer fits there (section 3). The Settings page proves the one-column FormGroup stack works; we reuse its grammar inside the detail pane.

Nav: add `["/research", "Research"]` to `NAV` in `Shell.tsx` between Fleet and Calibration. `g r` added to the `GO` map.

```
Research                                              [+ New profile  n]
┌ Profiles ──────────────────┬ Editor: "small-cap politics" ─────────────────────────┐
│ DataTable (selectable)     │ header: name input · [x] enabled · Run now · Save ·  Delete │
│ ● name  sched last  match  │ ┌ Filter ┐ FormGroup (grid2)                          │
│ ○ ...                      │ ├ Steering ┤ FormGroup                                │
│ (list ~340px fixed)        │ ├ Schedule ┤ FormGroup                                │
│                            │ ├ Preview  ┤ pane: [Preview matches p?] + result table  │
└────────────────────────────┴───────────────────────────────────────────────────────┘
```

- CSS grid `340px 1fr`; under 1100px (same breakpoint as market detail) stacks, list above editor, list capped to 8 rows with scroll.
- Hierarchy: page title row (`h2`, `--fs-lg`) with the primary list action; left pane = scan (a table), right pane = work. The editor's top toolbar is sticky inside the pane so Save/Run stay reachable on the long form.
- Density: list uses `DataTable` at row height 26px. Columns: `Name` (l, truncate 28ch), `On` (toggle glyph; see below), `Every` (r, `6h`/`—`), `Last run` (r, `hm` or `—`), `Match` (r, mono int, `--muted` until previewed this session; shows `—` when unknown). Selected row uses the standard 2px accent bar. `j/k` move, `Enter` focuses the name input.
- Selection is URL state: `/research?p=<id>` (new unsaved = `?p=new`) so refresh and back work. `router.refresh()` on SSE like other views; the editor's local draft is never overwritten while dirty (the container keys the draft by `id` + `updatedAt` and ignores server refresh while dirty, showing a `--warn` line "Changed elsewhere — reload" if `updatedAt` moved).
- "Match" counts come from the list payload only if the API returns them; pick: the list GET returns no counts (spec's list columns say "match count" — compute lazily). The client calls the preview endpoint once per visible profile on page load, sequentially, with `limit` forced to 1 server-side is NOT possible, so: **show match count only for the selected profile after Preview**; other rows show `—`. Cheaper, avoids N filter evaluations per refresh. Ask the API owner for an optional `matchCount` field if the operator wants it in the list.

Enabled toggle placement: two places, same state. List `On` column is a small `<button role="switch" aria-checked>` rendering `●`/`○` (`--pos` / `--muted`, plus the word via `title` and sr text) that PUTs `{enabled}` immediately (it is a single-field operational switch, like Pin/Mute — optimistic, rollback + `ErrorBar` on failure). The editor header repeats it as a labeled checkbox bound to the draft (saved with Save). To avoid two mismatched truths: the list switch is disabled while the selected profile has a dirty draft, with title "Save or discard changes first".

## 2. Profile editor

Container holds one draft object `ProfileDraft` = `{name, enabled, filter, steering, everyMin}` and the last-saved copy. Dirty = JSON compare (same method as `SettingsView`).

Header toolbar (sticky, `--surface`, bottom border): `name` text input (mono, 28ch) · `enabled` checkbox · spacer · `Preview matches` · `Run now` · `Save` · `Delete`.
- `Save` primary (accent border), disabled unless dirty. Dirty marker: the existing `•` in `--warn` after the name plus `unsaved` text `--muted`.
- `Run now`: enabled only when profile is saved AND not dirty (spec: runs the saved profile). If dirty: disabled, title "Save first — Run now uses the saved profile". Click → `POST .../run`; result handled via a status line (section 5).
- `Delete`: plain button with `--neg` text. Click turns the button into an inline two-step: `Delete?` `Confirm` `Cancel` in the same slot (no modal, matches the "no confirm for kill" ethos only where the action is reversible; delete is not, so one inline confirm). Confirm text names the profile: "Delete 'small-cap politics'? Past pods keep their steering snapshot." Esc cancels.
- Navigating away (row click, `g`-nav, browser back) with a dirty draft: row click asks via the same inline pattern in a `--warn` bar above the form: `Discard unsaved changes? [Discard] [Keep editing]`. Browser/tab close uses `beforeunload` only while dirty. Pick: no router-level interception for `g`-nav; `beforeunload` is not fired for client nav, so the keys hook is left alone and `g`-nav while dirty simply shows the bar via `useEffect` cleanup — **simplest honest version: global `g`-nav is suppressed while dirty** (the container sets a `data-dirty` flag the keys hook does not read; instead the editor's own capture-phase keydown swallows `g` when dirty and shows the bar). Acceptable ceiling: Next link clicks in the header are not intercepted.

### 2.1 Filter section (`FormGroup title="Filter"`, grid2 label/input)

All optional. A blank input means "unset" (emit `undefined`, never `0`). Number inputs: `type=number`, right-aligned, mono, unit suffix in `Field`'s `unit`.

| Spec field | Control | Notes |
|---|---|---|
| `categories` | `<select multiple>` (Settings `multi()` pattern), options = categories from the markets page loader (same `categories` prop Settings already receives) | size 2–6 |
| `tagsAny` | text input, comma list → string[] | placeholder `election, fed`; chips not worth the code |
| `textQuery` | text input | unit hint "case-insensitive, on question" as `--muted` suffix |
| `minVol24h` | number | `USD` |
| `minDepthUsd` | number | `USD`, label `min depth 5¢` |
| `maxSpread` | number | `¢` (UI scale x100 like Settings `minEdge`; stored as price units) |
| `endsWithinDays.min/max` | two number inputs on one `Field` row, `min` – `max` | `d` |
| `minAbsEdge` | number | `¢` (x100) ; helper line `--muted`: "markets with no thesis are excluded when set" |
| `skipIfResearchedWithinHours` | number, placeholder `24` | `h` |
| `sort` | `<select>`: `priority, vol24h, edge, endDate` | default shown selected `priority` |
| `limit` | number 1–50, placeholder `10` | |
| `includeConditionIds` / `excludeConditionIds` | `<textarea rows=2>` mono, one id per line or comma; parsed to list | placeholder shows format. Hint under: "paste condition ids" |

Order inside the section: text/categories/tags first (what you want), then numeric thresholds, then time, then sort/limit, then include/exclude last (rarest). Two visual rows of density: group the numeric thresholds in a `grid2` as normal — no extra columns, consistent with Settings.

### 2.2 Steering section

- **question**: `<textarea rows=3>` (ui font, full width via grid span), live counter bottom-right `412/2000` mono `--muted`, turns `--warn` at 90%, `--neg` over limit (blocks Save). Label `operator question`.
- **roles (built-ins)**: one `Field` "roles" containing five checkboxes in a wrapped row — `rules source base_rate news red_team` — each a `<label>` with mono text (checkbox + label, same control as Settings `structural auto`). Judge is not listed (always runs; show `judge` as a fixed `--muted` tag after the row: "judge always runs"). At least one role total enforced (see validation).
- **customRoles**: sub-list under the roles Field, max 5. Each item is a bordered row (1px `--border`, `--surface-2`): `key` input (mono, 14ch, pattern hint `a-z0-9_`), `prompt` `<textarea rows=3>`, `×` remove. Footer button `+ Add role` disabled at 5 or when total roles would exceed 10, with `--muted` text `3/5 custom · 8/10 roles`. Pick: no drag-reorder; order is insertion order.
- **models** (per role): a compact table in the section, not a Field per role. Rows = every selected role (built-in + custom) + `judge`. Columns: `Role` (mono), `Model` (`<select>`). The select's first option is `default` (value empty = omit from `models`; label shows the resolved default in `--muted` e.g. `default (sonnet-5-5)` when the API provides it, else `default`). Options come from `GET /api/research/models` (do not hardcode like Settings does — spec says the list is exported). Rows appear/disappear with the role checkboxes. Role rows deselected keep their model in the draft but are dropped on Save (no hidden state surprise: shown count of dropped entries not needed).
- **maxCostUsd**: number, `USD`, `step 0.01`, helper `--muted`: "queued roles are skipped once reached; judge still runs". Unset = no cap.
- **exaCallCap** / **maxTurns**: two numbers under a `<details>` "Advanced" (collapsed by default). Helper shows the Settings limit as `max N` (`--muted`) — the model endpoint response should carry these bounds; if absent, skip the helper.

### 2.3 Schedule section

One field: `every` number + unit select (`min`/`h`/`d`), stored as `every_min`. Blank = manual only; label text beside it `--muted`: "blank = manual only (Run now still works)". Read-only line: `last run 14:02` (or `never`). If `enabled` and `everyMin` blank, `--warn` note: "Enabled but no schedule — will not run automatically". A min bound of the cron tick is the API's call; show its 400 message under the field.

### 2.4 Preview matches

A `pane` at the bottom of the editor: header `Preview` with button `Preview matches` and result meta `18 of 50 limit · evaluated 14:05`. Uses the **draft** filter (not the saved one) so you can iterate before saving — the point of the button. Table = `DataTable` (own instance, `keys={false}` so `j/k` stays on the profile list) with columns matching spec payload exactly:

`Market` (question, `MarketCell`, 56ch, row `Enter`/click → `/m/[id]` in the same tab via `onOpen`, with draft kept in `sessionStorage` per profile id only if dirty — pick: skip draft persistence, open in a new tab (`target=_blank` anchor in the cell) to sidestep it) · `Vol 24h` (r, `NumCell usd`) · `Spread` (r, `¢`, 1 dp) · `Ends` (r, `MM-DD`, + `Nd` days muted) · `Edge¢` (r, `EdgeBadge`, `—` if no thesis).

Result is sorted in the server's order (the profile's sort + limit are applied). The meta line states the limit when truncation happened. Preview does not mark the draft dirty and never changes the saved match count except for the selected row.

## 3. Market page steered run

Trigger: existing `Re-research` button in `ActionBar` and its `r` key. Behavior change (the one friction decision): **plain click / `r` keeps one-click old behavior** (back-compat, TUI parity, no extra step for the common case). A second small button, `Steer…` (`R` is taken by nothing but is shift-collision-prone, so key `s`), opens the drawer. Rationale: forcing a drawer on every re-research slows the existing flow; the spec's "Re-research opens a drawer" is satisfied by making the drawer reachable from the same toolbar, and the cheaper reading preserves muscle memory. If the operator wants every `r` to open the drawer, flip one boolean in `ActionBar`; flagged as a known fork.

`SteerDrawer` (reuses `Drawer`, title `Research · <market question truncated 48ch>`):

```
Profile  [ default ▾ ]     (options: Default, then profiles by name)
─ overrides (all optional, prefilled from profile) ─────────
operator question  [textarea 3 rows]            412/2000
roles     [x]rules [x]source [x]base_rate [x]news [x]red_team
          custom roles from profile shown read-only as mono tags: key1 key2
model: judge  [default ▾]       (per-role models: collapsed row "models (n set) ▸")
max cost  [   ] USD
─────────────────────────────────────────────────────────────
[Start research]  [Cancel]            status line
```

- Compactness: reuse `Field`/grid2 but drop `FormGroup`s (one flat grid). Per-role models collapsed behind `<details>` — an ad-hoc run mostly changes question/roles/cost. Custom roles are **not editable here**, only inherited/deselectable as tags (pick: editing prompts per ad-hoc run is rare; use the profile editor). Advanced (`exaCallCap`, `maxTurns`) omitted; add if requested.
- Prefill: choosing a profile in the select replaces all override fields with that profile's steering. If the user already edited fields, switching profile asks nothing (the drawer is cheap) but shows `--muted` "fields reset to <profile>". Body sent: `{profileId, steering}` where `steering` contains only fields that differ from the chosen profile (diff computed in the presenter helper `steeringDiff`) — keeps audit snapshot meaningful; empty diff + default profile sends `{}` (identical to old behavior).
- States (single status line under buttons, `role=status`):
  - idle: nothing.
  - launching: `Start research` disabled, label `Starting…`, `Drawer` stays open (inputs `disabled`).
  - started (202): line `Started — pod queued` `--pos`; drawer auto-closes after 800ms, `router.refresh()`; `ActionBar` then shows `ResearchRunning` as today.
  - budget refused: the route returns a refusal (409/429-style per `canStartPod`; exact status is the API's). Show in `--warn` (not `--neg`: it is expected, not a fault): `Daily budget reached (12/12 pods or $50 cap). Try again after reset.` Drawer stays open, button re-enabled (editable → maybe lower cost caps does not help, so show text only; no retry spam).
  - already running: same warn style, `A pod is already running for this market.`
  - 400 field errors: map `issues[].path` to the owning `Field` `error` (same `{path,message}` shape Settings uses). Unknown paths go to the status line in `--neg`.
  - `RESEARCH_DISABLED`: see section 5.
  - network/5xx: status line `--neg` + `Retry` (calls submit again).
- Esc closes (native dialog). Closing with edits does not warn (low-cost throwaway form). Focus: select profile first, `autofocus` on question textarea if profile prefilled.

## 4. Fleet additions

Goal: two facts per pod without new columns crowding a 9-column table. Pick: **one new narrow column `Source` between `Market` and `Trigger`**, plus the question inside the expanded row.

- `Source` cell (`l`, mono-less ui font, truncate 18ch, `title` = full name): profile name, or `ad-hoc`, or `screener` rendered in `--muted` (the two non-profile labels muted so profile runs stand out; text, not color alone). Derivation: `profile_id` set → name (API joins; if the profile was deleted, show `deleted profile` `--muted`); `profile_id` null AND `steering` non-null → `ad-hoc`; both null → `screener`. If steering carries a question, append a `?` glyph in `--accent` after the label with `title` = first 120 chars of the question. That glyph is the only inline hint; keeps the row at 26px.
- Expanded row (`renderExpanded`, above the existing `AgentRunTable`): one `--muted` header line `steering` showing: `question` (ui font, full text, wrapped, max 3 lines then `show more`), then a mono line `roles rules,source,news,+2 custom · judge sonnet-5-5 · cap $1.50`. Only fields that deviate from defaults are printed. For legacy pods (no steering): nothing extra rendered.
- `ROLES` constant in `PodTable.tsx` (hardcoded six) must not hide custom roles: the 5 role dots become `roles` dots derived from the pod's actual agent rows (spec's TUI note applies to web too); custom roles dot titles show the key. Flag to implementer; no visual spec beyond "one dot per agent, built-in order first".
- Fleet `BudgetStrip`: unchanged.

## 5. States

| Context | Rendering |
|---|---|
| Loading (page) | `Skeleton rows=8` in list pane; editor pane shows 6 skeleton bars. `loading.tsx` for the route. No spinners for tables (root DESIGN §4). |
| Empty — no profiles | Left pane `EmptyState text="No research profiles yet." action=<button>Create profile</button>`; right pane shows a two-line `--muted` explanation: "Profiles pick which markets to research and how. The screener shortlist keeps running either way." and the New button. Editor does not render until a profile exists or `?p=new`. |
| New unsaved profile | Editor with defaults (default steering, `limit 10`, `priority`, 24h skip), name empty, `Save` enabled when name non-empty. List shows a transient top row `(new)` in `--muted`. |
| Preview — loading | Button label `Previewing…`, disabled; result table shows 5 skeleton rows. |
| Preview — zero matches | `EmptyState`: `No active markets match this filter.` plus a `--muted` hint listing the two most selective set fields (e.g. `minDepthUsd and minAbsEdge are set`). No table. Not an error; not `--warn`. |
| Preview — error | `ErrorBar` above the table with `Retry`; previous results stay beneath if any. |
| API 400 (save/run/preview) | Zod issues `{path,message}` → `errors` map keyed by dotted path (`filter.limit`, `steering.customRoles.0.key`, `steering.maxCostUsd`). Each `Field` shows `error` in `--neg` (existing `.err`). Cross-field issues (roles count, total roles > 10, name taken — the `name unique` 409) go to a `role=alert` line under the toolbar. Section header gets `--neg` `•` when it contains an error; first erroring field is focused and scrolled into view. Dirty state stays. |
| Save success | `•` clears, brief `--pos` `saved 14:06` text in the toolbar, fades by replacement (no animation). |
| Save/network failure | `ErrorBar` (existing) with `Retry`. |
| Run now — started | Toolbar status `--pos`: `Queued 7 markets` (from the 202 `queued` ids); includes a link `View in Fleet` → `/fleet`. `last run` and list row update via refresh. |
| Run now — nothing to run | 202 with zero queued: `--muted` `0 markets matched — nothing queued`. |
| Run now — budget exhausted | `--warn` line: `Daily budget reached — nothing started. The scheduler will retry next tick.` (matches the cron semantics in SPEC). Partial start: `Started 3 of 7 — budget reached` `--warn`. |
| Run now — locked/running | `--warn`: `Profile already running.` |
| `RESEARCH_DISABLED` | Server flag. Page renders normally (read/edit allowed; it is configuration) but a persistent `--warn` banner using the `StaleBanner` visual (`bar barWarn`) at the top: `Research is disabled on this server. Profiles can be edited but nothing will run.` `Run now` and `Start research` (drawer) are `disabled` with the same title text; on the market page the existing Re-research button gets that disabled state too. Source of truth: the first 4xx/`code:"RESEARCH_DISABLED"` response sets a page-local flag; if the models/list GET exposes it up front, show on load. If the API can't tell up front, banner appears after first refused action (acceptable ceiling). |
| Stale snapshot | Shell's existing `StaleBanner` applies unchanged (Research is a data view; do not add it to the exclusion regex). |
| Delete success | Selection moves to the next row or empty state; `--muted` toast line `Deleted` in the toolbar area is skipped; the row simply disappears. |

## 6. Keyboard

Existing: global `g w/f/c/p/a/s`, `/`, `?`, `t`, `Esc`; `DataTable` `j/k/Enter` (window listener); `ActionBar` `r/p/m` (window listener); all ignore keys while an input is focused (`inInput`).

Additions (all ignored while typing in inputs, textareas, selects, same guard):

| Key | Where | Action |
|---|---|---|
| `g r` | global (add `r: "/research"` to `GO`) | go to Research |
| `n` | `/research` | new profile |
| `j` / `k` / `Enter` | `/research` list | move/focus editor (preview table passes `keys={false}`, so no clash) |
| `p` | `/research`, editor not in input | Preview matches. Collision check: `p` is Pin only on the market page (`ActionBar`), and `g p` is a two-key chord; no overlap on this route. Document in the sheet. |
| `x` | `/research` | Run now (disabled rules apply). Chosen over `r` to stay clear of "re-research" semantics |
| `s` | market page | open Steer drawer (market page has `r/p/m`; `s` is unused; `g s` is a chord, not a collision) |
| `Mod+Enter` | inside any editor input/textarea | Save (editor) / Start research (drawer). Works while an input has focus since it requires Ctrl/Meta; the global hook ignores Ctrl/Meta, so no conflict, handled on the form's own `onKeyDown`. Inline hint on the button `Ctrl+Enter` in `--muted`. |
| `Esc` | editor | cancel inline delete/discard confirms (existing Esc blurs); drawer closes natively |

`SHORTCUTS` in `useGlobalKeys.ts` gains: `["g r", "research"]` appended to the g-list string, `["n / p / x", "research: new / preview / run now"]`, `["s", "steer & research (market page)"]`. Delete has no key (destructive; mouse only).

## 7. Components and file paths (all under `apps/web`)

Convention: server `page.tsx` loads data via `lib/jobs` `read.*`, passes it to one client container; presentational components are prop-only with no fetch.

```
app/(app)/research/
  page.tsx            server: read.researchProfiles(), categories, models → <ResearchView/>
  loading.tsx         Skeleton
  ResearchView.tsx    CONTAINER (client): selection (?p=), draft state, save/run/delete/preview calls,
                      errors map, dirty/confirm state, RESEARCH_DISABLED flag. Mirrors SettingsView.
  research.module.css split grid, sticky toolbar, custom-role row, counter
components/research/
  ProfileTable.tsx        presentational: DataTable of profiles + On switch (props: profiles, selected, onSelect, onToggle, matchCounts)
  ProfileToolbar.tsx      presentational: name, enabled, Preview/Run/Save/Delete, inline confirm, status line
  FilterForm.tsx          presentational: Filter FormGroup (props: value, onChange, errors, categories)
  SteeringForm.tsx        presentational: question, role checkboxes, custom roles, models table, cost, advanced
                          (SHARED: used by editor and SteerDrawer; prop `compact` hides custom-role editing and collapses models)
  ScheduleForm.tsx        presentational
  PreviewPane.tsx         presentational: button + meta + DataTable of matches + empty/loading/error
  steering.ts             pure helpers: defaultSteering, steeringDiff, parse/format of comma/id lists, ProfileDraft type,
                          mapIssues(path→errors). Unit-testable, no React.
components/SteerDrawer.tsx   CONTAINER (client): profile select, override state, submit state machine
                             (idle|launching|started|refused|error), uses Drawer + SteeringForm compact
components/ActionBar.tsx     EDIT: add `Steer…` button + `s` key; receives `profiles` + `researchDisabled`
components/PodTable.tsx      EDIT: Source column, dots from actual agents
components/Shell.tsx         EDIT: NAV entry
hooks/useGlobalKeys.ts       EDIT: GO map + SHORTCUTS
```

`FormGroup` change: the editor wants no per-group Save (one Save in the toolbar). Pick: do not edit `FormGroup`; render the sections as `<FormGroup title=... dirty={sectionDirty}>` **without `onSave`** — it already omits the button when `onSave` is undefined (Appearance group does the same). Zero changes to shared components.

New minimal controls: none beyond the above. Custom-role row and counter are CSS in `research.module.css`; everything else is native inputs/selects/checkboxes already used in Settings.

Types come from `@pm/agents` / `@pm/core` zod schemas (`ProfileFilter`, `Steering`), imported by the container and `steering.ts`; no UI-side duplicate schema. The server stays the validator; the client only does cheap pre-checks (name non-empty, question length, role count) to disable Save.

Open forks for the human: (1) `r` one-click vs always-drawer (section 3, default one-click + `Steer…`); (2) match counts in the list (default: selected-profile only after Preview); (3) deleted-profile label in Fleet.

# TASKS — Rev 7 polyscout merge

The original phase 1–5 task log moved to `docs/TASKS-phase1-5.md`.

Harness: Claude Code (cloud). Planner: claude-opus-5-5 @ high.
Roster (single provider, Anthropic): fable 5.1, opus 5.5, sonnet 5.5, haiku 5.5. All unverified on independent leaderboards; tiers from vendor positioning.
Roles: heavy = fable · discussion = fable · designer = fable (visual lane degraded: no visual evidence) · worker = sonnet · ui-impl = sonnet @ high · grunt = haiku · reviewer = opus fresh context (fable when the implementer was opus) · drift-check = sonnet @ low.

Destination: SPEC.md Rev 7 done list passes.

## Decisions so far
- Scope: web-only unified terminal, polytech stack kept, all four polyscout feature groups plus Polymarket client hardening (user, 2026-10-20).

- Polymarket layer keeps polytech's per-instance buckets and HttpError string contract; Data API moved to v2 (v1 retires 2026-10-24); fee taken from Gamma feeSchedule, not legacy /fee-rate.
- Structural detector replaced with polyscout's; `negRiskArb`/`ladderViolations` removed, `detectStructural` output shape unchanged.
- sizeTrade: fee charged per book level, exit-depth factor on rank, contrarian flag, extremize; side selection unchanged (already both sides).
- Routes: Screener `/markets`, Runs `/runs` + `/runs/[podId]`, Journal `/journal`; `/fleet` and `/calibration` redirect. Pod API is `/api/pods/[id]`.
- Agent fetch without Exa goes through an SSRF-guarded `fetch_url` tool; WebFetch disallowed; polymarket.com blocked for blind roles.
- Prior-weight refit skipped (priority is multiplicative); only the extremize refit ships.

## Tasks
| # | Task | Deps | Role / model | State |
|---|---|---|---|---|
| T1 | pm client hardening + docs/polymarket-api.md | — | heavy / fable | done |
| T2 | migration 0009 (Rev 7 data model) | — | worker / sonnet | done |
| T3a | core DSL parser/formatter | — | worker / sonnet | done |
| T3b | core book metrics, structural, crowd, sizing refinements | — | heavy / fable | done |
| T3c | core journal maths (drift, paper P&L, summarize, fitExtremize) | — | worker / sonnet | done |
| T7 | DESIGN.md Rev 7 brief (shell, screener, runs, journal, alerts) | — | designer / fable | done |
| T11 | CI workflow, clock-test fix, login lockout | — | grunt / haiku | done |
| T4 | jobs: incremental sweep, market_latest, crowd sync, structural, monitor/alerts, journal fill, refit | T1 T2 T3* | worker / sonnet | frontier |
| T5 | runs: agent status rows, tool-call capture, cancel, SSRF guard | T2 | worker / sonnet | done |
| T6 | API routes: markets?q, views, alerts, journal, structural, history, status | T2 T3a | worker / sonnet | done |
| T8 | UI: shell/nav/status bar + Screener | T6 T7 | ui-impl / sonnet | done |
| T9 | UI: Runs, Journal, Alerts, market detail additions, /trade WS feed | T5 T6 T7 | ui-impl / sonnet | Runs, Journal, alerts done; market detail + /trade WS frontier |
| T12 | verification gate | all | reviewer / opus | blocked |

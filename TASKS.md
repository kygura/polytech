# TASKS — Rev 7 polyscout merge

The original phase 1–5 task log moved to `docs/TASKS-phase1-5.md`.

Harness: Claude Code (cloud). Planner: claude-opus-5-5 @ high.
Roster (single provider, Anthropic): fable 5.1, opus 5.5, sonnet 5.5, haiku 5.5. All unverified on independent leaderboards; tiers from vendor positioning.
Roles: heavy = fable · discussion = fable · designer = fable (visual lane degraded: no visual evidence) · worker = sonnet · ui-impl = sonnet @ high · grunt = haiku · reviewer = opus fresh context (fable when the implementer was opus) · drift-check = sonnet @ low.

Destination: SPEC.md Rev 7 done list passes.

## Decisions so far
- Scope: web-only unified terminal, polytech stack kept, all four polyscout feature groups plus Polymarket client hardening (user, 2026-10-20).

## Tasks
| # | Task | Deps | Role / model | State |
|---|---|---|---|---|
| T1 | pm client hardening + docs/polymarket-api.md | — | heavy / fable | frontier |
| T2 | migration 0009 (Rev 7 data model) | — | worker / sonnet | frontier |
| T3a | core DSL parser/formatter | — | worker / sonnet | frontier |
| T3b | core book metrics, structural, crowd, sizing refinements | — | heavy / fable | frontier |
| T3c | core journal maths (drift, paper P&L, summarize, fitExtremize) | — | worker / sonnet | frontier |
| T7 | DESIGN.md Rev 7 brief (shell, screener, runs, journal, alerts) | — | designer / fable | frontier |
| T11 | CI workflow, clock-test fix, login lockout | — | grunt / haiku | frontier |
| T4 | jobs: incremental sweep, market_latest, crowd sync, structural, monitor/alerts, journal fill, refit | T1 T2 T3* | worker / sonnet | blocked |
| T5 | runs: agent status rows, tool-call capture, cancel, SSRF guard | T2 | worker / sonnet | blocked |
| T6 | API routes: markets?q, views, alerts, journal, structural, history, status | T2 T3a | worker / sonnet | blocked |
| T8 | UI: shell/nav/status bar + Screener | T6 T7 | ui-impl / sonnet | blocked |
| T9 | UI: Runs, Journal, Alerts, market detail additions, /trade WS feed | T5 T6 T7 | ui-impl / sonnet | blocked |
| T12 | verification gate | all | reviewer / opus | blocked |

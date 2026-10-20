# TASKS — Rev 8: one app, one design system

Rev 7 task log moved to `docs/TASKS-rev7.md`; phase 1–5 log is `docs/TASKS-phase1-5.md`.

Harness: Claude Code (cloud). Planner: claude-opus-5-5 @ high.
Roster (single provider, Anthropic): fable 5.1, opus 5.5, sonnet 5.5, haiku 5.5. No independent-leaderboard evidence in this harness; tiers from vendor positioning, so diversity is limited to model family + fresh context.
Roles: designer = fable (visual lane degraded: no visual evidence) · heavy = fable · discussion = fable · worker = sonnet · ui-impl = sonnet @ high · grunt = haiku · reviewer = fable for sonnet work, opus fresh context for fable work · drift-check = sonnet @ low.

Destination: SPEC.md "Rev 8" done list passes.

## Decisions so far
- No login anywhere, no visitor mode, one shell (owner, 2026-10-20).
- Design direction left to planner: merge both looks into one system on the terminal palette, Inter + JetBrains Mono, dark default with light toggle.
- `/trade/[id]` is the single market page; `/markets/[id]` redirects there; operator research content becomes a tab set on it.

## Tasks
| # | Task | Deps | Role / model | State |
|---|---|---|---|---|
| A1 | Bug audit of every route + API (docs/rev8-audit.md) | — | worker / sonnet | running |
| A2 | DESIGN.md §13 brief | — | designer / fable | running |
| A3 | Remove login/auth (web + TUI) | — | worker / sonnet | running |
| B1 | Unified tokens + fonts + single AppShell, fold /trade into it, delete visitor surface | A2 A3 | ui-impl / sonnet | frontier |
| C1 | YES/NO chart + merged market page (/trade/[id], research tabs, list search, wrapped titles) | B1 | ui-impl / sonnet | blocked |
| C2 | Markets explorer (/markets) redesign | B1 | ui-impl / sonnet | blocked |
| C3 | Restyle remaining pages to primitives | B1 | ui-impl / sonnet | blocked |
| C4 | Logic bug fixes from audit (non-UI) | A1 | worker / sonnet | blocked |
| V | Verification gate: typecheck, test, build, Playwright sweep, review, drift check | all | reviewer / fable | blocked |

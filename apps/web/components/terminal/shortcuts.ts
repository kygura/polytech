/** DESIGN 11.5, for the `?` sheet. */
export const TERMINAL_SHORTCUTS: [string, string][] = [
  ["/", "focus market search"], ["j / k", "move the market list cursor"], ["Enter (list / search)", "select the cursor market"],
  ["b / s", "ticket Buy / Sell, then Limit"], ["y / n", "ticket outcome YES / NO, then Limit"],
  ["↑ / ↓ (Limit)", "± 1 tick · Shift ± 10 ticks"], ["↑ / ↓ (Shares)", "± min order size · Shift × 10"],
  ["Tab / Shift+Tab", "Side → Outcome → Limit → Shares → submit"], ["Enter (ticket field)", "review: focus the submit button"],
  ["Enter (review) / ⌘Enter / Ctrl+Enter", "sign and place"], ["l", "order book: ↑↓ move, Enter copies the price, Esc back"],
  ["Shift+T", "focus the ticket"], ["p / o", "Positions / Open orders"], ["x", "cancel the focused open order, or the ticket's order"],
  ["Esc", "disarm, close, then blur"], ["g w / g a", "terminal / autonomy"], ["t", "toggle theme"], ["?", "this sheet"],
];
/** `g o` (back to the operator app) only exists for an operator session (DESIGN 12.1.4). */
export const terminalShortcuts = (operator: boolean): [string, string][] => (operator ? [...TERMINAL_SHORTCUTS, ["g o", "operator app"]] : TERMINAL_SHORTCUTS);

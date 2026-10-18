// The /trade terminal paths (DESIGN 11): /trade and /trade/[id], not /trade/autonomy. One regex for the root theme script and PublicShell.
export const TERMINAL_PATH = /^\/trade(?:\/(?!autonomy(?:\/|$))[^/]+)?\/?$/;
export const isTerminal = (path: string) => TERMINAL_PATH.test(path);
/** Set by the terminal while an order is mid-send (signing / checking / unknown): the shell's g-keys must not navigate away. */
export const terminalNav = { locked: false, onBlocked: () => {} };

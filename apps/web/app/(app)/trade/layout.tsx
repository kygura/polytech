import type { ReactNode } from "react";
import { TerminalPage } from "../../../components/terminal/TerminalPage";

// /trade and /trade/[id] share this layout, so selecting a market (router.replace) swaps panes without remounting the terminal.
// It renders inside the one app Shell (a workspace page: fixed height between header and status bar).
export default function TerminalLayout({ children }: { children: ReactNode }) {
  return <><TerminalPage />{children}</>;
}

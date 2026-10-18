import { Inter, JetBrains_Mono } from "next/font/google";
import type { ReactNode } from "react";
import { TerminalPage } from "../../../../components/terminal/TerminalPage";

const inter = Inter({ subsets: ["latin"], weight: ["400", "500", "600"], variable: "--font-inter" });
const mono = JetBrains_Mono({ subsets: ["latin"], weight: ["400", "500", "600"], variable: "--font-jbm" });

// /trade and /trade/[id] share this layout, so selecting a market (router.replace) swaps panes without remounting the terminal.
export default function TerminalLayout({ children }: { children: ReactNode }) {
  return <><TerminalPage fontClass={`${inter.variable} ${mono.variable}`} />{children}</>;
}

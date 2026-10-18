import type { Metadata } from "next";
import type { ReactNode } from "react";
import { TERMINAL_PATH } from "../lib/terminalPath";
import "./globals.css";

export const metadata: Metadata = { title: "PM-EDGE" };

// Applied before paint: stored theme wins, else prefers-color-scheme, else dark (CSS default). The /trade terminal stays dark unless chosen.
const THEME_SCRIPT = `(function(){try{var t=localStorage.theme,term=${TERMINAL_PATH}.test(location.pathname);if(t==="light"||t==="dark"){document.documentElement.dataset.theme=t}else if(!(term&&t!=="system")&&matchMedia("(prefers-color-scheme: light)").matches){document.documentElement.dataset.theme="light"}}catch(e){}})()`;

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head><script dangerouslySetInnerHTML={{ __html: THEME_SCRIPT }} /></head>
      <body>{children}</body>
    </html>
  );
}

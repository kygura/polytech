import type { Metadata } from "next";
import type { ReactNode } from "react";
import "./globals.css";

export const metadata: Metadata = { title: "PM-EDGE" };

// Applied before paint: stored theme wins, else prefers-color-scheme, else dark (CSS default).
const THEME_SCRIPT = `(function(){try{var t=localStorage.theme;if(t==="light"||t==="dark"){document.documentElement.dataset.theme=t}else if(matchMedia("(prefers-color-scheme: light)").matches){document.documentElement.dataset.theme="light"}}catch(e){}})()`;

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head><script dangerouslySetInnerHTML={{ __html: THEME_SCRIPT }} /></head>
      <body>{children}</body>
    </html>
  );
}

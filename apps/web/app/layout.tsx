import type { Metadata } from "next";
import { Inter, JetBrains_Mono } from "next/font/google";
import type { ReactNode } from "react";
import "./globals.css";

export const metadata: Metadata = { title: "PM-EDGE" };

const inter = Inter({ subsets: ["latin"], weight: ["400", "500", "600"], variable: "--font-inter" });
const mono = JetBrains_Mono({ subsets: ["latin"], weight: ["400", "500", "600"], variable: "--font-jbm" });

// Applied before paint: the stored choice wins, else dark (the CSS default).
const THEME_SCRIPT = `(function(){try{var t=localStorage.theme;if(t==="light"||t==="dark"){document.documentElement.dataset.theme=t}}catch(e){}})()`;

// The font variables sit on <html> (not <body>) so the :root tokens --font-ui / --font-mono can resolve them.
export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className={`${inter.variable} ${mono.variable}`} suppressHydrationWarning>
      <head><script dangerouslySetInnerHTML={{ __html: THEME_SCRIPT }} /></head>
      <body>{children}</body>
    </html>
  );
}

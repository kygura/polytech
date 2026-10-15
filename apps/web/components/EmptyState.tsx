import type { ReactNode } from "react";
import css from "./ui.module.css";

export function EmptyState({ text, action }: { text: string; action?: ReactNode }) {
  return <div className={css.empty}><span>{text}</span>{action}</div>;
}

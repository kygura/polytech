import type { ButtonHTMLAttributes, ReactNode } from "react";
import css from "./ui.module.css";

/** Cents text: whole cents, one decimal when the price needs it (DESIGN 11.2). */
export const cents = (p: number | null | undefined) => (p == null ? "—" : `${(p * 100).toFixed(Math.abs(p * 100 - Math.round(p * 100)) < 1e-6 ? 0 : 1)}¢`);

/** Inline price chip for lists and tables. Outcome identity only; never coloured by direction. */
export function PricePill({ outcome, price }: { outcome: "YES" | "NO"; price: number | null | undefined }) {
  return <span className={`${css.pill} ${outcome === "YES" ? css.pillYes : css.pillNo}`}>{cents(price)}</span>;
}

/** YES / NO button with the live price (market page; `Y` / `N` keys). `pressed` marks the ticket's outcome. */
export function OutcomeCard({ outcome, price, pressed, kbd, ...rest }: Omit<ButtonHTMLAttributes<HTMLButtonElement>, "children"> & { outcome: "YES" | "NO"; price: number | null | undefined; pressed?: boolean; kbd?: ReactNode }) {
  return (
    <button type="button" className={`${css.outcome} ${outcome === "YES" ? css.yesO : css.noO}`} aria-pressed={pressed} {...rest}>
      <span className={css.outcomeL}>{outcome}{kbd != null && <kbd aria-hidden>{kbd}</kbd>}</span>
      <span className={css.outcomeP}>{cents(price)}</span>
    </button>
  );
}

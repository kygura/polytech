import type { ButtonHTMLAttributes } from "react";
import css from "./ui.module.css";

export type ButtonVariant = "secondary" | "primary" | "ghost" | "danger" | "yes" | "no" | "kill";

/** DESIGN 13.2. Default variant is secondary; `kbd` content goes in children. */
export function Button({ variant = "secondary", size, className, type = "button", ...rest }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: ButtonVariant; size?: "sm" | "lg" }) {
  const cls = [css.btn, variant !== "secondary" && css[variant], size && css[size], className].filter(Boolean).join(" ");
  return <button type={type} className={cls} {...rest} />;
}

import type { ReactNode } from "react";
import cx from "../../app/(app)/research/research.module.css";

/** One-line field explanation under a Field, in the FormGroup grid's input column. */
export const Hint = ({ children }: { children: ReactNode }) => <span className={`${cx.fhint} muted ui`}>{children}</span>;

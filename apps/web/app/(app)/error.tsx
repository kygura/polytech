"use client";
import RouteError from "../../components/RouteError";
import pg from "../../components/page.module.css";

export default function Error(props: { error: Error; reset: () => void }) {
  return (
    <div className={pg.stack}>
      <div className="page-h"><h1>Something went wrong</h1></div>
      <RouteError {...props} />
    </div>
  );
}

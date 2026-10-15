"use client";
import { useState, type FormEvent } from "react";
import css from "./login.module.css";

export function LoginForm({ next }: { next: string }) {
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true); setError("");
    const r = await fetch("/api/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ password }) }).catch(() => null);
    setBusy(false);
    if (r?.ok) { window.location.assign(next); return; }
    setError(r?.status === 429 ? "Too many attempts, wait 15 min" : "Wrong password");
  };

  return (
    <form className={css.box} onSubmit={submit}>
      <h1 className={css.title}>PM-EDGE</h1>
      <input type="password" name="password" autoFocus autoComplete="current-password" aria-label="password" value={password} onChange={(e) => setPassword(e.target.value)} aria-invalid={!!error} />
      <p className={css.error} role="alert">{error}</p>
      <button type="submit" disabled={busy || !password}>Sign in</button>
    </form>
  );
}

import { safeNext } from "../../lib/auth";
import { LoginForm } from "./LoginForm";
import css from "./login.module.css";

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ next?: string }> }) {
  const { next } = await searchParams;
  return (
    <div className={css.wrap}>
      <LoginForm next={safeNext(next)} />
    </div>
  );
}

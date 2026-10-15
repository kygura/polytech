// Usage: printf '%s' 'my password' | pnpm --filter web hash-password
import { hash } from "@node-rs/argon2";

async function main() {
  let input = "";
  for await (const chunk of process.stdin) input += chunk;
  const password = input.replace(/\r?\n$/, "");
  if (!password) throw new Error("empty password on stdin");
  const h = await hash(password); // library default: argon2id, m=19456 KiB, t=2, p=1
  if (!h.startsWith("$argon2id$")) throw new Error("unexpected hash algorithm");
  console.log(h);
}

main().catch((e: Error) => {
  console.error(e.message);
  process.exit(1);
});

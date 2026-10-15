#!/usr/bin/env -S tsx
import { Text, render } from "ink";
import { createInterface } from "node:readline";
import { Writable } from "node:stream";
import { login } from "./auth";

if (process.argv[2] === "login") {
  process.stdout.write("Password: ");
  const muted = new Writable({ write: (_c, _e, cb) => cb() }); // no echo
  const rl = createInterface({ input: process.stdin, output: muted, terminal: true });
  const password = await new Promise<string>((r) => rl.question("", r));
  rl.close();
  process.stdout.write("\n");
  try {
    await login(process.env.PM_API_BASE ?? "http://localhost:3000", password);
    console.log("Logged in.");
  } catch (e) {
    console.error((e as Error).message);
    process.exitCode = 1;
  }
} else {
  render(<Text>pm-edge</Text>);
}

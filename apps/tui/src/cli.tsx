#!/usr/bin/env -S tsx
import { render } from "ink";
import { App } from "./app";

const app = render(<App />, { alternateScreen: true, exitOnCtrlC: true });
try {
  await app.waitUntilExit();
} catch (e) {
  console.error((e as Error).message);
  process.exitCode = 1;
}

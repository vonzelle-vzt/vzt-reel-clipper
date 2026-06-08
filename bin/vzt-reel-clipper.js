#!/usr/bin/env node
import { run } from "../src/cli.js";
run(process.argv).catch((err) => {
  console.error("\x1b[31m" + (err?.stack || err?.message || String(err)) + "\x1b[0m");
  process.exit(1);
});

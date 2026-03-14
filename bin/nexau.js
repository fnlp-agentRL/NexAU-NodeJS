#!/usr/bin/env node

import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";

const currentDir = dirname(fileURLToPath(import.meta.url));
const distCliPath = resolve(currentDir, "../dist/cli/main.js");

if (!existsSync(distCliPath)) {
  console.error(
    "[nexau] CLI entry dist/cli/main.js not found. Please run `pnpm build` in nexau-nodejs first.",
  );
  process.exit(1);
}

await import(pathToFileURL(distCliPath).href);

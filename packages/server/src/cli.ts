#!/usr/bin/env node
import { createProgram } from "./cli/program.js";

createProgram()
  .parseAsync(process.argv)
  .catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });

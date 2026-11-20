#!/usr/bin/env node
import { findControlRoot } from "../hulane/scripts/lib/state-store.mjs";
import { recoverStateWriteLock } from "../hulane/scripts/lib/state-lock-recovery.mjs";

let directory = process.cwd();
let apply = false;
for (let i = 0; i < process.argv.slice(2).length; i++) {
  const arg = process.argv.slice(2)[i];
  if (arg === "--project") {
    directory = process.argv.slice(2)[++i];
    if (!directory) throw new Error("--project requires a path");
  } else if (arg === "--apply") {
    apply = true;
  } else if (arg === "--dry-run") {
    apply = false;
  } else {
    throw new Error("Unknown option " + arg + "; use --project <git-repo> [--dry-run|--apply]");
  }
}
const root = findControlRoot(directory);
const result = recoverStateWriteLock(root, { apply });
console.log(JSON.stringify({ repository: root, mode: apply ? "apply" : "dry-run", ...result }, null, 2));

#!/usr/bin/env node

import fs from "node:fs";
import process from "node:process";
import { findControlRoot, readStore, storePath } from "../scripts/lib/state-store.mjs";

let raw = "";
process.stdin.setEncoding("utf8");
for await (const chunk of process.stdin) raw += chunk;
const input = JSON.parse(raw || "{}");

let context = "hulane V2 is enabled. Use the hulane-control MCP tools for state and authority; GitHub is canonical. Preserve Gates A/B/C and never let plugin subagents spawn subagents.";
try {
  const root = findControlRoot(input.cwd ?? process.cwd());
  if (fs.existsSync(storePath(root))) {
    const items = Object.values(readStore(root, { allowMissing: false }).items)
      .filter((item) => item.status !== "done")
      .map((item) => `${item.id}:${item.status}@r${item.revision}`)
      .slice(0, 20);
    context += items.length ? ` Active Work Items: ${items.join(", ")}. Hydrate GitHub before resuming one.` : " There are no active local Work Items.";
  } else {
    context += " This repository is not initialized; run hulane_preflight before hulane_initialize.";
  }
} catch {
  context += " The current directory is not a Git worktree.";
}

process.stdout.write(JSON.stringify({
  hookSpecificOutput: {
    hookEventName: input.hook_event_name ?? "SessionStart",
    additionalContext: context,
  },
}));

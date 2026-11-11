#!/usr/bin/env node

import fs from "node:fs";
import process from "node:process";
import { findControlRoot, readStore, storePath } from "../scripts/lib/state-store.mjs";

let raw = "";
process.stdin.setEncoding("utf8");
for await (const chunk of process.stdin) raw += chunk;
const input = JSON.parse(raw || "{}");
const message = String(input.last_assistant_message ?? "");
const ids = [...new Set(message.match(/(?:REQ|BUG)-[1-9][0-9]*/g) ?? [])];
const claimsCompletion = /\b(?:done|completed|closed|shipped)\b|(?:已完成|完成交付|已关闭)/i.test(message);

if (ids.length && claimsCompletion) {
  try {
    const root = findControlRoot(input.cwd ?? process.cwd());
    if (fs.existsSync(storePath(root))) {
      const items = readStore(root, { allowMissing: false }).items;
      const incomplete = ids.filter((id) => items[id] && items[id].status !== "done");
      if (incomplete.length) {
        process.stdout.write(JSON.stringify({
          decision: "block",
          reason: `Do not claim completion: ${incomplete.map((id) => `${id} is ${items[id].status}`).join(", ")}. Reconcile GitHub and report the actual gate.`,
        }));
      }
    }
  } catch {
    // A missing/unreadable cache cannot prove completion, but it also must not trap unrelated sessions.
  }
}

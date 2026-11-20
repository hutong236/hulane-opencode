#!/usr/bin/env node

// Edit/Write PreToolUse 薄入口:检测逻辑全部在
// hulane/scripts/lib/discipline.mjs(核心检测面移植自 affaan-m/ECC,MIT,
// 轻量重写,版权与许可声明见该文件头)。

import process from "node:process";
import { pathToFileURL } from "node:url";
import { evaluateDisciplineEdit } from "../scripts/lib/discipline.mjs";

function hookResult(decision, reason) {
  return {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: decision,
      permissionDecisionReason: reason,
    },
  };
}

async function main() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  const input = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
  const filePath = input.tool_input?.file_path ?? input.tool_input?.file ?? "";
  const result = evaluateDisciplineEdit({ filePath });
  process.stdout.write(`${JSON.stringify(hookResult(result.allowed ? "allow" : "deny", result.reason))}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stdout.write(`${JSON.stringify(hookResult("deny", `Hulane discipline guard fail-closed: ${error.message}`))}\n`);
  });
}

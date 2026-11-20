#!/usr/bin/env node

import process from "node:process";
import fs from "node:fs";
import { applyEvent, createWorkItem, nextLocalWorkItemNumber, validateWorkItem } from "./lib/state-machine.mjs";
import { findControlRoot, getItem, initializeRepositoryState, putItem, readStore } from "./lib/state-store.mjs";
import { hydrateItemFromGitHub, resolveRepository, syncItemToGitHub } from "./lib/github-state.mjs";
import { createWorktree } from "./lib/worktree.mjs";
import { validateDeliveryEvidence } from "./lib/delivery.mjs";

function parseFlags(args) {
  const positional = [];
  const flags = {};
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index];
    if (!value.startsWith("--")) {
      positional.push(value);
      continue;
    }
    const key = value.slice(2).replaceAll("-", "_");
    const next = args[index + 1];
    if (!next || next.startsWith("--")) flags[key] = true;
    else {
      flags[key] = next;
      index += 1;
    }
  }
  return { positional, flags };
}

function required(flags, key) {
  if (flags[key] === undefined) throw new Error(`Missing --${key.replaceAll("_", "-")}`);
  return flags[key];
}

function output(value, json = true) {
  process.stdout.write(json ? `${JSON.stringify(value, null, 2)}\n` : `${String(value)}\n`);
}

function help() {
  output(`hulane-state commands:
  init [--repository owner/repo]
  new [--id REQ-123] [--issue 123] --title ... --risk low [--size small] --delivery-required true [--skip-allowed false] [--delivery-reason ...] [--spec-sync-required false]
    (omit --issue for local-first creation: local numbering, issue_pending=true, GitHub Issue deferred to hulane_flush)
  transition REQ-123 <event> --actor <identity> --evidence <text> [--patch JSON] [--to state]
  status [REQ-123]
  validate [REQ-123]
  sync REQ-123 [--repository owner/repo]
  hydrate --issue 123 [--repository owner/repo]
  worktree REQ-123 --actor orchestrator --evidence ... [--branch hulane/req-123] [--base origin/main]
  verify-delivery REQ-123 --workflow-metadata file --release-metadata file --registry-digest sha256:... --sbom-digest sha256:... --provenance-digest sha256:... --release-url https://... --actor orchestrator --evidence ...`);
}

async function main() {
  const [command = "help", ...rest] = process.argv.slice(2);
  const { positional, flags } = parseFlags(rest);
  if (["help", "--help", "-h"].includes(command)) return help();
  const mutating = new Set(["init", "new", "transition", "sync", "hydrate", "worktree", "verify-delivery"]);
  if (mutating.has(command) && process.env.HULANE_ENABLE_LEGACY_CLI !== "1") {
    throw new Error("V2 mutations require the hulane-control MCP server; legacy CLI mutation is disabled");
  }
  const root = findControlRoot();

  if (command === "init") {
    const repository = flags.repository ?? null;
    return output(initializeRepositoryState(root, repository));
  }

  if (command === "new") {
    initializeRepositoryState(root, flags.repository ?? null);
    // 本地优先开单:省略 --issue 时编号取 store 内全部工单(REQ/BUG 合并)
    // 最大值+1,issue_pending=true,GitHub Issue 展期到 hulane_flush 在线窗口
    const input = {
      title: required(flags, "title"),
      type: flags.type,
      risk_level: required(flags, "risk"),
      size: flags.size,
      delivery_required: flags.delivery_required ?? true,
      delivery_reason: flags.delivery_reason,
      skip_allowed: flags.skip_allowed ?? false,
      spec_sync_required: flags.spec_sync_required,
      github_issue_url: flags.github_issue_url,
      actor: flags.actor ?? "orchestrator",
      evidence: flags.evidence,
    };
    if (flags.issue === undefined) {
      const number = nextLocalWorkItemNumber(readStore(root));
      const derivedId = `${flags.type === "bug" ? "BUG" : "REQ"}-${number}`;
      if (flags.id !== undefined && flags.id !== derivedId) {
        throw new Error(`--id ${flags.id} conflicts with the locally derived id ${derivedId}; omit --id or pass --issue`);
      }
      const item = createWorkItem({ ...input, id: derivedId, issue_pending: true });
      putItem(root, item);
      return output(item);
    }
    const item = createWorkItem({ ...input, id: required(flags, "id"), issue_number: Number(flags.issue) });
    putItem(root, item);
    return output(item);
  }

  if (command === "transition") {
    const [id, event] = positional;
    if (!id || !event) throw new Error("transition requires <ID> <event>");
    const item = getItem(root, id);
    const patch = flags.patch ? JSON.parse(flags.patch) : {};
    const next = applyEvent(item, event, {
      actor: required(flags, "actor"),
      evidence: required(flags, "evidence"),
      patch,
      to: flags.to,
    });
    putItem(root, next);
    return output(next);
  }

  if (command === "worktree") {
    const [id] = positional;
    if (!id) throw new Error("worktree requires <ID>");
    const item = getItem(root, id);
    if (item.status !== "ready") throw new Error("worktree creation requires ready state");
    const result = createWorktree(root, {
      id,
      branch: flags.branch,
      base: flags.base,
    });
    const next = applyEvent(item, "start_planning", {
      actor: required(flags, "actor"),
      evidence: required(flags, "evidence"),
      patch: { branch: result.branch, worktree_path: result.path },
    });
    putItem(root, next);
    return output({ worktree: result, state: next });
  }

  if (command === "verify-delivery") {
    const [id] = positional;
    if (!id) throw new Error("verify-delivery requires <ID>");
    const item = getItem(root, id);
    if (item.status !== "building") throw new Error("verify-delivery requires building state");
    const workflowMetadata = JSON.parse(fs.readFileSync(required(flags, "workflow_metadata"), "utf8"));
    const releaseMetadata = JSON.parse(fs.readFileSync(required(flags, "release_metadata"), "utf8"));
    const patch = validateDeliveryEvidence({
      item,
      workflowMetadata,
      releaseMetadata,
      registryDigest: required(flags, "registry_digest"),
      releaseUrl: required(flags, "release_url"),
      sbomDigest: required(flags, "sbom_digest"),
      provenanceDigest: required(flags, "provenance_digest"),
    });
    const next = applyEvent(item, "image_verified", {
      actor: required(flags, "actor"),
      evidence: required(flags, "evidence"),
      patch,
    });
    putItem(root, next);
    return output(next);
  }

  if (command === "status") {
    const [id] = positional;
    return output(id ? getItem(root, id) : readStore(root, { allowMissing: false }));
  }

  if (command === "validate") {
    const [id] = positional;
    if (id) validateWorkItem(getItem(root, id));
    else for (const item of Object.values(readStore(root, { allowMissing: false }).items)) validateWorkItem(item);
    return output({ valid: true, id: id ?? null });
  }

  if (command === "sync") {
    const [id] = positional;
    if (!id) throw new Error("sync requires <ID>");
    const item = getItem(root, id);
    // pending 工单 sync 降级:远端尚无此单,跳过而非报错,联网后用 flush 补建
    if (item.issue_pending === true) {
      return output({
        skipped: "issue_pending",
        hint: `Issue 未建（issue_pending=true），本次 sync 已跳过；联网后调用 hulane_flush 补建并一次同步最终状态`,
      });
    }
    const repository = flags.repository ?? resolveRepository(root);
    return output(syncItemToGitHub(item, { repository, cwd: root }));
  }

  if (command === "hydrate") {
    const issueNumber = Number(required(flags, "issue"));
    const repository = flags.repository ?? resolveRepository(root);
    try {
      const item = hydrateItemFromGitHub({ repository, issueNumber, cwd: root });
      putItem(root, item);
      return output(item);
    } catch (error) {
      // 降级文案:该 Issue 可能是 flush 中途断线留下的「已建未回填」半成品——
      // 本地 pending 工单尚无状态注释可取,重跑 hulane_flush 幂等补建即可恢复
      if (/no hulane state comment/.test(String(error.message))) {
        const pending = Object.values(readStore(root).items).find((entry) => entry.issue_pending === true);
        if (pending) {
          throw new Error(`${error.message};本地存在待补建工单 ${pending.id}（issue_pending=true）:请在线重跑 hulane_flush（幂等预查会复用既有 Issue，不重复建）`);
        }
      }
      throw error;
    }
  }

  throw new Error(`Unknown command: ${command}`);
}

main().catch((error) => {
  process.stderr.write(`hulane-state: ${error.message}\n`);
  process.exitCode = 1;
});

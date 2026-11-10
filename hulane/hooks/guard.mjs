#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";
import { consumeAuthorization, consumeReleaseAuthorization, verifyStateAuthorization } from "../scripts/lib/authorization.mjs";
import { findControlRoot, resolveControlDir, storePath } from "../scripts/lib/state-store.mjs";
import { evaluateDisciplineBash } from "../scripts/lib/discipline.mjs";

// shellSegments 与 stripMessageBodies 同时被执行纪律守卫
// (scripts/lib/discipline.mjs)复用,故导出;函数体保持不变
export function shellSegments(command) {
  return String(command ?? "").split(/(?:\r?\n|&&|\|\||;)/).map((value) => value.trim()).filter(Boolean);
}

// git 命令的 -m/-am/--message 消息体是数据不是命令：提交信息里的 "push"/"tag" 字样
// 会与同段的 git 误判成受控操作，分段扫描前先剥离。含命令替换（$(、反引号）的消息体
// 保留扫描（fail closed），仅整体为 $(cat <<EOF ...) 纯数据形式时剥离。
export function stripMessageBodies(command) {
  return String(command ?? "").replace(
    /(^|\s)(?:-am|-m|--message)(?:\s*=|\s+)(?:"((?:[^"\\]|\\.)*)"|'((?:[^']|'')*)'|(\S+))/g,
    (match, prefix, doubleQuoted, singleQuoted, token) => {
      if (token && /^-/.test(token)) return match;
      const body = doubleQuoted ?? singleQuoted ?? token ?? "";
      if (/[$`]/.test(body) && !/^\$\(\s*cat\s+<<-?'?\w+'?[\s\S]*\)\s*$/.test(body)) return match;
      return prefix;
    },
  );
}

function containsGitSubcommand(segment, subcommand) {
  return new RegExp(`\\bgit\\b[^\\n;&|]*\\b${subcommand}\\b`).test(segment);
}

function isReadOnlyGitTag(segment) {
  const normalized = segment.replace(/^\s*HULANE_AUTH_TOKEN=[^\s]+\s+/, "").trim();
  if (!containsGitSubcommand(normalized, "tag")) return true;
  const after = normalized.replace(/^.*?\bgit\b[^\n;&|]*?\btag\b/, "").trim();
  if (!after) return true;
  return /^(?:-l|--list|--contains|--points-at|--merged|--no-merged|--sort(?:=|\s))\b/.test(after);
}

// git push 命令的位置参数（过滤选项与环境变量赋值）；裸 `git push` 返回空
function pushPositionalArgs(segment) {
  const match = segment.match(/\bgit\b[^\n;&|]*?\bpush\b\s+(.+)$/);
  if (!match) return [];
  return match[1]
    .trim()
    .split(/\s+/)
    .filter((arg) => !arg.startsWith("-") && !/^[A-Za-z_][A-Za-z0-9_]*=/.test(arg));
}

// git push 命令中显式给出的远端参数（第一个位置参数）；裸 `git push` 返回空
function pushRemoteTargets(segment) {
  const args = pushPositionalArgs(segment);
  return args.length > 0 ? [args[0]] : [];
}

// 统一远端写法便于比对：剥协议、user@ 与 .git 后缀（github.com/owner/repo）
function normalizeRemoteTarget(target) {
  return target
    .replace(/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//, "")
    .replace(/^[^@/]+@/, "")
    .replace(/\.git$/i, "")
    .toLowerCase();
}

// release 令牌只放行显式 refspec 形式的 tag 推送:第一个位置参数是远端,
// refspec 部分必须恰好一条且为 `<40位SHA>:refs/tags/<vX.Y.Z>`——SHA 语义为
// annotated tag 对象(Gate A 裁决 #2),形态识别只看 40 位十六进制,对象真伪
// 与钉死值绑定由消费层三重验证链(annotated + 本地钉死 tag 对象 + 解引用)
// 完成。裸 `vX.Y.Z` 简单 refspec、裸 push、分支推送、tag+分支混合、
// 多条 tag refspec(夹带任意额外 tag)或重复同条 refspec 都不进入
// release 通道,回到原工单令牌路径(fail-closed)
const RELEASE_TAG_REFSPEC_PATTERN = /^[0-9a-f]{40}:refs\/tags\/v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(-[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?$/;

function isReleaseTagPush(command) {
  const segments = shellSegments(stripMessageBodies(command)).filter((segment) => containsGitSubcommand(segment, "push"));
  if (segments.length === 0) return false;
  for (const segment of segments) {
    const args = pushPositionalArgs(segment);
    // 裸 `git push`(推 origin)、简单 tag 名 refspec、分支推送都不属于 release 通道;
    // refspec 恰好一条——多条(夹带)或重复同条都回落拒绝
    const refspecs = args.slice(1);
    if (refspecs.length !== 1 || !RELEASE_TAG_REFSPEC_PATTERN.test(refspecs[0])) return false;
  }
  return true;
}

// 白名单来自控制根 .hulane/guard-allowlist.json（字符串数组，子串匹配归一化远端）
function readPushAllowlist(root) {
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(resolveControlDir(root), "guard-allowlist.json"), "utf8"));
    return Array.isArray(parsed) ? parsed.filter((entry) => typeof entry === "string") : [];
  } catch {
    return [];
  }
}

function pushTargetsExempt(root, command) {
  const allowlist = readPushAllowlist(root);
  if (allowlist.length === 0) return { exempt: false };
  const segments = shellSegments(stripMessageBodies(command)).filter((segment) => containsGitSubcommand(segment, "push"));
  if (segments.length === 0) return { exempt: false };
  const targets = [];
  for (const segment of segments) {
    const remotes = pushRemoteTargets(segment);
    // 裸 `git push`（推 origin）不受白名单保护，必须走令牌
    if (remotes.length === 0) return { exempt: false };
    targets.push(...remotes);
  }
  const unmatched = targets.filter((target) => {
    const normalized = normalizeRemoteTarget(target);
    return !allowlist.some((entry) => normalized.includes(entry.toLowerCase()));
  });
  return unmatched.length === 0 ? { exempt: true, targets } : { exempt: false };
}

export function analyzeCommand(command) {
  const actions = [];
  for (const segment of shellSegments(stripMessageBodies(command))) {
    if (/\bgh\s+pr\s+merge\b/.test(segment)) actions.push("pr-merge");
    if (/\bgh\s+issue\s+close\b/.test(segment)) actions.push("issue-close");
    if (containsGitSubcommand(segment, "push")) actions.push("git-push");
    if (containsGitSubcommand(segment, "tag") && !isReadOnlyGitTag(segment)) actions.push("git-tag");
  }
  return [...new Set(actions)];
}

function hookResult(decision, reason) {
  return {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: decision,
      permissionDecisionReason: reason,
    },
  };
}

export function evaluateCommand({ cwd, command, token, releaseTagToken, releasePushToken }) {
  const actions = analyzeCommand(command);
  if (actions.length === 0) return { allowed: true, reason: "No protected operation" };

  let root;
  try {
    root = findControlRoot(cwd);
  } catch {
    return { allowed: true, reason: "Outside a Git worktree" };
  }
  if (!fs.existsSync(storePath(root))) return { allowed: true, reason: "Repository is not managed by hulane" };
  if (actions.length > 1) return { allowed: false, reason: "Run exactly one protected operation per Bash call" };
  if (actions[0] === "git-push") {
    // 白名单内的显式远端（如插件市场仓库）不受令牌门禁；必须在 cd/-C 检查前判断，
    // 跨仓推送天然需要切换工作目录
    const exemption = pushTargetsExempt(root, command);
    if (exemption.exempt) {
      return { allowed: true, reason: `Allowed push to exempt remote: ${exemption.targets.join(", ")}` };
    }
  }
  if (/(?:^|[;&|]\s*)cd\s+|\bgit\s+(?:--git-dir|--work-tree|-C)\b/.test(stripMessageBodies(command))) {
    return { allowed: false, reason: "Set the Bash tool working directory directly; protected calls may not change or override repository paths" };
  }
  if (!token) {
    // 仓库级 release 令牌通道(仅当无工单令牌时):tag 创建腿认
    // HULANE_RELEASE_TAG_TOKEN,tag 推送腿只认 `<tag对象SHA>:refs/tags/<vX.Y.Z>`
    // 显式 refspec 推送 + HULANE_RELEASE_PUSH_TOKEN(对象真伪由消费层验证);
    // 普通分支推送、简单 tag 名 refspec 推送都不进入该通道
    if (actions[0] === "git-tag" && releaseTagToken) {
      try {
        const authorization = consumeReleaseAuthorization(root, { token: releaseTagToken, action: "release-tag", cwd, command });
        return { allowed: true, reason: `Authorized release-tag ${authorization.target.version} at ${authorization.target.sha}` };
      } catch (error) {
        return { allowed: false, reason: error.message };
      }
    }
    if (actions[0] === "git-push" && releasePushToken && isReleaseTagPush(command)) {
      try {
        const authorization = consumeReleaseAuthorization(root, { token: releasePushToken, action: "release-push", cwd, command });
        return { allowed: true, reason: `Authorized release-push ${authorization.target.version} at ${authorization.target.sha}` };
      } catch (error) {
        return { allowed: false, reason: error.message };
      }
    }
    // issue-close / pr-merge 允许无令牌状态自证:waiting_close / merging 状态
    // 本身就是已完成证据校验的授权,校验逻辑与令牌消费共用同一套
    if (actions[0] === "issue-close" || actions[0] === "pr-merge") {
      try {
        const item = verifyStateAuthorization(root, { action: actions[0], cwd, command });
        return { allowed: true, reason: `State-verified ${actions[0]} for ${item.id}` };
      } catch (error) {
        return { allowed: false, reason: error.message };
      }
    }
    return { allowed: false, reason: `${actions[0]} requires a single-use Hulane authorization token` };
  }

  try {
    const authorization = consumeAuthorization(root, { token, action: actions[0], cwd, command });
    return { allowed: true, reason: `Authorized ${actions[0]} for ${authorization.work_item}` };
  } catch (error) {
    return { allowed: false, reason: error.message };
  }
}

async function main() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  const input = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
  const command = input.tool_input?.command ?? input.tool_input?.cmd ?? "";
  // 执行纪律守卫前置(REQ-9):纪律 deny 优先于一切特权守卫逻辑(含白名单
  // 远端与令牌授权);纪律放行/不适用则原 evaluateCommand 流程逐行不变
  const discipline = evaluateDisciplineBash({ cwd: input.cwd ?? process.cwd(), command });
  if (!discipline.allowed) {
    process.stdout.write(`${JSON.stringify(hookResult("deny", discipline.reason))}\n`);
    return;
  }
  const token = String(command).match(/(?:^|\s)HULANE_AUTH_TOKEN=([0-9a-f]{64})(?:\s|$)/)?.[1];
  const releaseTagToken = String(command).match(/(?:^|\s)HULANE_RELEASE_TAG_TOKEN=([0-9a-f]{64})(?:\s|$)/)?.[1];
  const releasePushToken = String(command).match(/(?:^|\s)HULANE_RELEASE_PUSH_TOKEN=([0-9a-f]{64})(?:\s|$)/)?.[1];
  const result = evaluateCommand({ cwd: input.cwd ?? process.cwd(), command, token, releaseTagToken, releasePushToken });
  process.stdout.write(`${JSON.stringify(hookResult(result.allowed ? "allow" : "deny", result.reason))}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stdout.write(`${JSON.stringify(hookResult("deny", `Hulane guard failed closed: ${error.message}`))}\n`);
  });
}

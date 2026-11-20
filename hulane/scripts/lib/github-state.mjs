import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { normalizeWorkItem, validateWorkItem } from "./state-machine.mjs";
import { resolveControlDir } from "./state-store.mjs";

export const STATE_MARKER = "<!-- cmdb-dev-state:v2 -->";
const STATE_BLOCK = /```cmdb-state\s*\n([\s\S]*?)\n```/;

export function stateLabel(status) {
  return `hulane:${String(status).replaceAll("_", "-")}`;
}

export function serializeGitHubState(item) {
  validateWorkItem(item);
  return `${STATE_MARKER}\n\n\`\`\`cmdb-state\n${JSON.stringify(item, null, 2)}\n\`\`\`\n\n> Managed by hulane. Do not edit this state block manually.`;
}

export function parseGitHubState(body) {
  if (!String(body).includes(STATE_MARKER)) return null;
  const match = String(body).match(STATE_BLOCK);
  if (!match) throw new Error("Hulane state marker exists without a valid state block");
  const item = normalizeWorkItem(JSON.parse(match[1]));
  validateWorkItem(item);
  return item;
}

export function runGh(args, { cwd = process.cwd(), input } = {}) {
  const result = spawnSync("gh", args, { cwd, input, encoding: "utf8", maxBuffer: 10 * 1024 * 1024 });
  if (result.error?.code === "ENOENT") throw new Error("GitHub CLI (gh) is not installed");
  if (result.status !== 0) throw new Error(`gh ${args.join(" ")} failed: ${result.stderr.trim() || result.stdout.trim()}`);
  return result.stdout.trim();
}

export function resolveRepository(cwd = process.cwd()) {
  return runGh(["repo", "view", "--json", "nameWithOwner", "--jq", ".nameWithOwner"], { cwd });
}

// Managed-comment id and last-synced label cache, keyed by Work Item id. This is
// a non-canonical accelerator: losing it only forces the next sync down the
// conservative full path. Canonical state stays in the GitHub state comment.
function metaPath(root) {
  return path.join(resolveControlDir(root), "github-meta.json");
}

export function readGithubMeta(root) {
  try {
    const parsed = JSON.parse(fs.readFileSync(metaPath(root), "utf8"));
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function writeGithubMeta(root, meta) {
  const file = metaPath(root);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = path.join(path.dirname(file), `.github-meta-${randomUUID()}.tmp`);
  fs.writeFileSync(temporary, `${JSON.stringify(meta, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temporary, file);
}

function rememberGithubMeta(root, itemId, entry) {
  const meta = readGithubMeta(root);
  meta[itemId] = entry;
  writeGithubMeta(root, meta);
}

function issueComments(repository, issueNumber, cwd, { paginate = true, run = runGh } = {}) {
  const args = ["api"];
  if (paginate) args.push("--paginate", "--slurp");
  args.push(`repos/${repository}/issues/${issueNumber}/comments?per_page=100`);
  const raw = run(args, { cwd });
  if (!raw) return [];
  const parsed = JSON.parse(raw);
  return Array.isArray(parsed[0]) ? parsed.flat() : parsed;
}

function latestManagedComment(comments) {
  return comments
    .filter((comment) => String(comment.body).includes(STATE_MARKER))
    .sort((a, b) => String(a.updated_at).localeCompare(String(b.updated_at)))
    .at(-1) ?? null;
}

export function assertRevisionCanSync(local, remote) {
  if (!remote) return true;
  if (remote.id !== local.id) throw new Error(`GitHub state belongs to ${remote.id}, not ${local.id}`);
  if (remote.revision > local.revision) {
    throw new Error(`GitHub has newer state revision ${remote.revision}; hydrate before sync`);
  }
  if (remote.revision === local.revision && JSON.stringify(remote) !== JSON.stringify(local)) {
    throw new Error(`GitHub state revision ${remote.revision} conflicts with the local payload`);
  }
  return true;
}

export function hydrateItemFromGitHub({ repository, issueNumber, cwd = process.cwd(), run = runGh }) {
  const latest = latestManagedComment(issueComments(repository, issueNumber, cwd, { paginate: true, run }));
  if (!latest) throw new Error(`Issue #${issueNumber} has no hulane state comment`);
  const item = parseGitHubState(latest.body);
  const issue = JSON.parse(run(["issue", "view", String(issueNumber), "--repo", repository, "--json", "number,state,url,title"], { cwd }));
  item.issue_state = String(issue.state).toLowerCase();
  item.github_issue_url = issue.url;
  rememberGithubMeta(cwd, item.id, { comment_id: latest.id, state_label: stateLabel(item.status) });
  return item;
}

const ensuredLabels = new Set();

function ensureLabelExists(label, repository, cwd, run) {
  const memoKey = `${repository}#${label}`;
  if (ensuredLabels.has(memoKey)) return;
  const status = label.replace(/^hulane:/, "").replaceAll("-", "_");
  run(["label", "create", label, "--repo", repository, "--color", "1f6feb", "--description", `hulane state: ${status}`, "--force"], { cwd });
  ensuredLabels.add(memoKey);
}

function isNotFound(error) {
  return /\b404\b|not found/i.test(String(error?.message ?? ""));
}

// Steady-state path: at most one label edit plus one comment PATCH, no comment
// listing. Single-writer orchestration keeps the local revision authoritative;
// a stale comment id falls back to the conservative full path.
function syncFastPath(item, { repository, cwd, meta, run }) {
  const label = stateLabel(item.status);
  ensureLabelExists(label, repository, cwd, run);
  const previousLabel = meta.state_label ?? null;
  if (previousLabel !== label) {
    const editArgs = ["issue", "edit", String(item.issue_number), "--repo", repository, "--add-label", label];
    if (previousLabel) editArgs.push("--remove-label", previousLabel);
    run(editArgs, { cwd });
  }
  const body = serializeGitHubState(item);
  run(["api", "--method", "PATCH", `repos/${repository}/issues/comments/${meta.comment_id}`, "-f", `body=${body}`], { cwd });
  rememberGithubMeta(cwd, item.id, { comment_id: meta.comment_id, state_label: label });
  return { issue_number: item.issue_number, label, revision: item.revision };
}

// Conservative path used on first sync, meta loss, or stale comment id: lists
// managed comments, asserts the remote revision, and cleans stray state labels.
function syncFullPath(item, { repository, cwd, run }) {
  const label = stateLabel(item.status);
  ensureLabelExists(label, repository, cwd, run);
  let existing = latestManagedComment(issueComments(repository, item.issue_number, cwd, { paginate: false, run }));
  if (!existing) existing = latestManagedComment(issueComments(repository, item.issue_number, cwd, { paginate: true, run }));
  assertRevisionCanSync(item, existing ? parseGitHubState(existing.body) : null);

  const issue = JSON.parse(run(["issue", "view", String(item.issue_number), "--repo", repository, "--json", "labels"], { cwd }));
  const oldStateLabels = issue.labels.map((entry) => entry.name).filter((name) => name.startsWith("hulane:") && name !== label);
  const editArgs = ["issue", "edit", String(item.issue_number), "--repo", repository, "--add-label", label];
  for (const old of oldStateLabels) editArgs.push("--remove-label", old);
  run(editArgs, { cwd });

  const body = serializeGitHubState(item);
  if (existing) {
    run(["api", "--method", "PATCH", `repos/${repository}/issues/comments/${existing.id}`, "-f", `body=${body}`], { cwd });
    rememberGithubMeta(cwd, item.id, { comment_id: existing.id, state_label: label });
  } else {
    const commentId = Number(run(["api", "--method", "POST", `repos/${repository}/issues/${item.issue_number}/comments`, "-f", `body=${body}`, "--jq", ".id"], { cwd }));
    if (Number.isInteger(commentId) && commentId > 0) {
      rememberGithubMeta(cwd, item.id, { comment_id: commentId, state_label: label });
    }
  }
  return { issue_number: item.issue_number, label, revision: item.revision };
}

export function syncItemToGitHub(item, { repository, cwd = process.cwd(), run = runGh } = {}) {
  validateWorkItem(item);
  // sync 降级:pending 工单的 GitHub Issue 尚未创建,返回 skipped 而非抛错,
  // 让全部控制面调用方(persist/hulane_sync/CLI)在网络不可达时照常离线流转
  if (item.issue_pending === true) {
    return { skipped: "issue_pending", id: item.id, issue_number: null, label: null, revision: item.revision };
  }
  const meta = readGithubMeta(cwd)[item.id] ?? null;
  if (meta?.comment_id) {
    try {
      return syncFastPath(item, { repository, cwd, meta, run });
    } catch (error) {
      if (!isNotFound(error)) throw error;
    }
  }
  return syncFullPath(item, { repository, cwd, run });
}

// flush 幂等预查:按 `<ID> ` 前缀标题搜既有 Issue(含已关闭),命中即复用,
// 不重复补建——覆盖「flush 中途断线,Issue 已建但本地回填未落」的恢复路径
export function findIssueByTitlePrefix({ repository, workItemId, cwd = process.cwd(), run = runGh }) {
  const raw = run([
    "issue", "list", "--repo", repository, "--search", `${workItemId} in:title`,
    "--state", "all", "--limit", "20", "--json", "number,title,url",
  ], { cwd });
  const issues = JSON.parse(raw || "[]");
  const hit = (Array.isArray(issues) ? issues : []).find((issue) => {
    const title = String(issue.title ?? "");
    return title === workItemId || title.startsWith(`${workItemId} `);
  });
  return hit ? { number: Number(hit.number), url: String(hit.url ?? ""), title: String(hit.title ?? "") } : null;
}

// flush 补建:gh issue create 并从返回 URL 解析正整数 Issue 编号
export function createIssue({ repository, title, body, cwd = process.cwd(), run = runGh }) {
  const url = run(["issue", "create", "--repo", repository, "--title", title, "--body", body], { cwd });
  const number = Number(String(url).match(/\/issues\/(\d+)(?:\?.*)?$/)?.[1]);
  if (!Number.isInteger(number) || number <= 0) throw new Error(`Could not parse Issue number from: ${url}`);
  return { number, url: String(url).trim() };
}

// flush 标题落位:把(复用路径的)既有 Issue 标题改为 `<ID> <title>` 规范形
export function renameIssueTitle({ repository, issueNumber, title, cwd = process.cwd(), run = runGh }) {
  run(["issue", "edit", String(issueNumber), "--repo", repository, "--title", title], { cwd });
}

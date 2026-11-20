import fs from "node:fs";
import path from "node:path";
import { randomBytes, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { findControlRoot, findRepositoryRoot, getItem, readStore, resolveControlDir } from "./state-store.mjs";
import { mergeGuardSatisfied } from "./state-machine.mjs";

export const AUTHORIZATION_ACTIONS = Object.freeze([
  "git-push",
  "git-tag",
  "pr-merge",
  "issue-close",
]);

// 仓库级 release 令牌(不挂工单):tag 创建与 tag 推送各一枚,单次使用,
// scope 钉死 {version, sha}。轻量批量发版(/hulane_release)专用
export const RELEASE_ACTIONS = Object.freeze(["release-tag", "release-push"]);

// 与状态机 SEMVER_TAG_PATTERN 同一严格度:可带 v 前缀或裸 SemVer,规范形为 vX.Y.Z
const SEMVER_CORE_PATTERN = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(-[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?$/;

const REQUIRED_STATE = Object.freeze({
  "git-push": ["pr_open", "building"],
  "git-tag": ["building"],
  "pr-merge": ["merging"],
  "issue-close": ["waiting_close"],
});

function authorizationDirectory(root) {
  return path.join(resolveControlDir(root), "authorizations");
}

function authorizationPath(root, token) {
  if (!/^[0-9a-f]{64}$/.test(token ?? "")) throw new Error("Invalid authorization token");
  return path.join(authorizationDirectory(root), `${token}.json`);
}

function atomicWrite(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = path.join(path.dirname(file), `.authorization-${randomUUID()}.tmp`);
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temporary, file);
}

function assertActionState(item, action) {
  if (!AUTHORIZATION_ACTIONS.includes(action)) throw new Error(`Unsupported authorization action: ${action}`);
  if (!REQUIRED_STATE[action].includes(item.status)) {
    throw new Error(`${action} is forbidden while ${item.id} is ${item.status}`);
  }
  // 离线韧性:pending 工单(Issue 未补建)不允许关单/合并——目标对象尚不存在,
  // 必须先经 hulane_flush 在线窗口补建回填(token 路径与状态自证路径共用本断言)
  if (action === "issue-close" && item.issue_pending === true) {
    throw new Error("issue close requires the GitHub Issue to exist; run hulane_flush first");
  }
  if (action === "pr-merge" && item.issue_pending === true) {
    throw new Error("PR merge requires the GitHub Issue to exist; run hulane_flush first");
  }
  if (action === "pr-merge" && (item.pr_checks !== "passed" || !mergeGuardSatisfied(item))) {
    throw new Error("PR merge requires passed checks and a verified merge guard");
  }
  if (action === "pr-merge" && !Number.isInteger(item.pr_number)) throw new Error("PR merge requires a recorded pr_number");
  // 规格层前置(双层强制的授权层侧):token 路径与状态自证路径共用本断言,
  // spec_sync_required 且未记录 specs_synced 的工单不允许关闭 Issue
  if (action === "issue-close" && item.spec_sync_required && item.specs_synced !== true) {
    throw new Error("issue close requires recorded specs_synced evidence while spec_sync_required; call hulane_record_specs_synced first");
  }
  if (action === "git-tag" && item.tag_confirmation !== "approved") throw new Error("git tag requires Gate C approval");
  if (action === "git-tag" && !/^[0-9a-f]{40}$/i.test(String(item.merged_sha ?? ""))) throw new Error("git tag requires merged_sha");
  if (action === "git-push" && item.status === "building" && item.tag_confirmation !== "approved") {
    throw new Error("tag push requires Gate C approval");
  }
  if (action === "git-push" && item.status === "pr_open" && (!item.branch || !item.worktree_path)) {
    throw new Error("Branch push requires recorded branch and worktree_path");
  }
  if (["git-tag", "git-push"].includes(action) && item.status === "building" && !item.image_tag) {
    throw new Error("Tag operation requires the confirmed image_tag");
  }
}

function commandHasNumber(command, number) {
  return new RegExp(`(?:^|\\s)${number}(?:\\s|$)`).test(command);
}

// 远端加固:签发与消费都以远端事实为准,不信本地引用(可能陈旧)。
// 默认分支名不一定是 main(如 master 主分支仓库),用 --symref 解析 origin 真实默认分支 HEAD
function remoteMainHead(root) {
  const symref = spawnSync("git", ["ls-remote", "--symref", "origin", "HEAD"], { cwd: root, encoding: "utf8" });
  if (symref.status !== 0) {
    throw new Error(`Release authorization requires a reachable origin remote: ${(symref.stderr || symref.stdout).trim()}`);
  }
  const headLine = symref.stdout.trim().split(/\r?\n/).filter(Boolean).find((line) => !line.startsWith("ref:"));
  if (headLine) return headLine.split(/\s+/)[0];
  // 老版本 git 不支持 --symref 时按 main → master 顺序探测
  for (const branch of ["refs/heads/main", "refs/heads/master"]) {
    const result = spawnSync("git", ["ls-remote", "origin", branch], { cwd: root, encoding: "utf8" });
    if (result.status !== 0) {
      throw new Error(`Release authorization requires a reachable origin remote: ${(result.stderr || result.stdout).trim()}`);
    }
    const line = result.stdout.trim().split(/\r?\n/).filter(Boolean)[0];
    if (line) return line.split(/\s+/)[0];
  }
  return null;
}

function remoteTagExists(root, tag) {
  const result = spawnSync("git", ["ls-remote", "--tags", "origin", tag], { cwd: root, encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`Release authorization requires a reachable origin remote: ${(result.stderr || result.stdout).trim()}`);
  }
  return result.stdout.split(/\r?\n/).some((line) => line.trim().endsWith(`refs/tags/${tag}`));
}

// git 输出真实路径,而状态里记录的可能是含软链的原始路径(如 macOS 的 /var),比较前必须统一
function canonicalPath(target) {
  if (!target) return target;
  const resolved = path.resolve(target);
  return fs.existsSync(resolved) ? fs.realpathSync(resolved) : resolved;
}

function assertExecutionScope(root, item, action, cwd, command) {
  if (!cwd || !command) throw new Error("Authorization consumption requires command context");
  if (canonicalPath(findControlRoot(cwd)) !== canonicalPath(root)) throw new Error("Protected command targets a different repository");
  if (action === "git-push" && item.status === "pr_open") {
    if (canonicalPath(findRepositoryRoot(cwd)) !== canonicalPath(item.worktree_path ?? "")) {
      throw new Error(`Branch push must run in ${item.worktree_path}`);
    }
    const branch = spawnSync("git", ["branch", "--show-current"], { cwd, encoding: "utf8" }).stdout.trim();
    if (branch !== item.branch) throw new Error(`Branch push requires ${item.branch}, found ${branch || "detached HEAD"}`);
  }
  if (["git-tag", "git-push"].includes(action) && item.status === "building" && !String(command).includes(item.image_tag)) {
    throw new Error(`Tag operation must name ${item.image_tag}`);
  }
  if (action === "git-tag" && !String(command).includes(item.merged_sha)) {
    throw new Error("Annotated tag command must name the verified merged SHA");
  }
  if (action === "pr-merge" && !commandHasNumber(String(command), item.pr_number)) {
    throw new Error(`PR merge command must name PR ${item.pr_number}`);
  }
  if (action === "pr-merge" && !new RegExp(`--match-head-commit(?:=|\\s+)${item.pr_head_sha}(?:\\s|$)`).test(String(command))) {
    throw new Error(`PR merge command must pin verified head SHA ${item.pr_head_sha}`);
  }
  if (action === "issue-close" && !commandHasNumber(String(command), item.issue_number)) {
    throw new Error(`Issue close command must name Issue ${item.issue_number}`);
  }
}

export function issueAuthorization(root, { id, action, actor, ttlSeconds = 120 }, now = () => new Date()) {
  if (actor !== "orchestrator") throw new Error("Only the Primary Agent orchestrator may issue execution authorization");
  if (!Number.isInteger(ttlSeconds) || ttlSeconds < 10 || ttlSeconds > 600) {
    throw new Error("Authorization TTL must be an integer from 10 to 600 seconds");
  }
  const item = getItem(root, id);
  assertActionState(item, action);
  const issuedAt = now();
  const token = randomBytes(32).toString("hex");
  const authorization = {
    schema_version: 1,
    token,
    work_item: id,
    action,
    actor,
    state_revision: item.revision,
    target: {
      branch: item.branch,
      worktree_path: item.worktree_path,
      pr_number: item.pr_number,
      pr_head_sha: item.pr_head_sha,
      issue_number: item.issue_number,
      image_tag: item.image_tag,
      merged_sha: item.merged_sha,
    },
    issued_at: issuedAt.toISOString(),
    expires_at: new Date(issuedAt.getTime() + ttlSeconds * 1000).toISOString(),
    used_at: null,
  };
  atomicWrite(authorizationPath(root, token), authorization);
  return authorization;
}

export function consumeAuthorization(root, { token, action, cwd, command }, now = () => new Date()) {
  const file = authorizationPath(root, token);
  if (!fs.existsSync(file)) throw new Error("Authorization token was not found");
  const authorization = JSON.parse(fs.readFileSync(file, "utf8"));
  if (authorization.action !== action) throw new Error(`Authorization is for ${authorization.action}, not ${action}`);
  if (authorization.used_at) throw new Error("Authorization token has already been used");
  if (Date.parse(authorization.expires_at) <= now().getTime()) throw new Error("Authorization token has expired");

  const item = getItem(root, authorization.work_item);
  if (item.revision !== authorization.state_revision) throw new Error("Authorization state revision is stale");
  assertActionState(item, action);
  assertExecutionScope(root, item, action, cwd, command);

  authorization.used_at = now().toISOString();
  atomicWrite(file, authorization);
  return authorization;
}

// 轻量批量发版:仓库级令牌对(不挂任何工单)。签发前远端加固——
// sha 必须等于 origin/main 当前 HEAD(git ls-remote,不信本地引用),
// 目标 tag 在远端必须不存在;一次返回 tag 创建与 tag 推送两枚单次令牌,
// scope 钉死规范化的 vX.Y.Z + 小写 40 位 sha,TTL 与工单令牌同一区间
export function issueReleaseAuthorization(root, { version, sha, ttlSeconds = 120, actor = "orchestrator", evidence }, now = () => new Date()) {
  if (actor !== "orchestrator") throw new Error("Only the Primary Agent orchestrator may issue execution authorization");
  if (!Number.isInteger(ttlSeconds) || ttlSeconds < 10 || ttlSeconds > 600) {
    throw new Error("Authorization TTL must be an integer from 10 to 600 seconds");
  }
  if (!String(evidence ?? "").trim()) throw new Error("Release authorization requires evidence citing the user's release request");
  const core = String(version ?? "").replace(/^v/, "");
  if (!SEMVER_CORE_PATTERN.test(core)) throw new Error("Release version must be strict SemVer (vX.Y.Z)");
  const tag = `v${core}`;
  const normalizedSha = String(sha ?? "").toLowerCase();
  if (!/^[0-9a-f]{40}$/.test(normalizedSha)) throw new Error("Release sha must be a 40-character commit SHA");
  const mainHead = remoteMainHead(root);
  if (mainHead !== normalizedSha) throw new Error("Release sha must equal the current origin default-branch HEAD");
  if (remoteTagExists(root, tag)) throw new Error(`Release tag ${tag} already exists on the remote; refusing to re-issue a release authorization`);

  const issuedAt = now();
  const expiresAt = new Date(issuedAt.getTime() + ttlSeconds * 1000).toISOString();
  const mint = (action) => {
    const authorization = {
      schema_version: 1,
      token: randomBytes(32).toString("hex"),
      release: true,
      work_item: null,
      action,
      actor,
      evidence: String(evidence).trim(),
      target: { version: tag, sha: normalizedSha },
      issued_at: issuedAt.toISOString(),
      expires_at: expiresAt,
      used_at: null,
    };
    atomicWrite(authorizationPath(root, authorization.token), authorization);
    return authorization;
  };
  const tagAuthorization = mint("release-tag");
  const pushAuthorization = mint("release-push");
  return {
    tag_token: tagAuthorization.token,
    push_token: pushAuthorization.token,
    version: tag,
    sha: normalizedSha,
    expires_at: expiresAt,
  };
}

// 与 guard.mjs 的 push 解析同构:按换行/&&/||/; 切段,取每个含 git push 的
// 段中 push 之后的位置参数(滤选项与环境变量赋值),首参为远端、其余为 refspec
function pushRefspecsOf(command) {
  const refspecs = [];
  for (const segment of String(command ?? "").split(/(?:\r?\n|&&|\|\||;)/)) {
    const match = segment.match(/\bgit\b[^\n;&|]*?\bpush\b\s+(.+)$/);
    if (!match) continue;
    const args = match[1]
      .trim()
      .split(/\s+/)
      .filter((arg) => !arg.startsWith("-") && !/^[A-Za-z_][A-Za-z0-9_]*=/.test(arg));
    if (args.length > 1) refspecs.push(...args.slice(1));
  }
  return refspecs;
}

function gitOutput(root, args) {
  const result = spawnSync("git", args, { cwd: root, encoding: "utf8" });
  return result.status === 0 ? result.stdout.trim() : null;
}

// release 令牌消费校验与工单令牌的 assertExecutionScope 同构:
// 同一仓库 + 命令点名钉死的目标。tag 创建腿必须同时点名 version 与钉死
// commit SHA(对应 annotated tag 命令天然同时携带二者);tag 推送腿重新解析
// push 的 refspec 位置参数,必须恰好一条且形如 `<40位>:refs/tags/<钉死version>`
// (简单形式 `vX.Y.Z` 不放行;多条 refspec 夹带任意额外 tag/分支一律拒绝)。
// Gate A 裁决 #2(保 annotated tag):推送的是 tag 对象本身,消费时三重验证链
// ①cat-file -t 为 tag(防本地 tag 被删重建为轻量蒙混);②rev-parse <钉死version>
// 等于 refspec SHA(该对象就是本地钉死版本之 tag 对象);③rev-parse <钉死version>^{}
// 解引用等于钉死 commit SHA。任一环节失败即抛错并说明缺哪环
function assertReleaseExecutionScope(root, authorization, action, cwd, command) {
  if (!cwd || !command) throw new Error("Authorization consumption requires command context");
  if (canonicalPath(findControlRoot(cwd)) !== canonicalPath(root)) throw new Error("Protected command targets a different repository");
  const { version, sha } = authorization.target;
  if (!String(command).includes(version)) {
    throw new Error(`Release ${action} command must name the pinned tag ${version}`);
  }
  if (action === "release-tag" && !String(command).includes(sha)) {
    throw new Error("Annotated tag command must name the pinned release SHA");
  }
  if (action === "release-push") {
    const refspecs = pushRefspecsOf(command);
    const malformed = () => new Error(`Release push command must use exactly one explicit refspec <annotated-tag-object-sha>:refs/tags/${version}`);
    if (refspecs.length !== 1) throw malformed();
    const separator = refspecs[0].indexOf(":");
    const tagObjectSha = separator === -1 ? "" : refspecs[0].slice(0, separator).toLowerCase();
    if (!/^[0-9a-f]{40}$/.test(tagObjectSha) || refspecs[0].slice(separator + 1) !== `refs/tags/${version}`) {
      throw malformed();
    }
    const objectType = gitOutput(root, ["cat-file", "-t", tagObjectSha]);
    if (objectType !== "tag") {
      throw new Error(`Release push refspec object ${tagObjectSha} is not an annotated tag object${objectType ? ` (git reports ${objectType})` : ""}; the push must ship the annotated tag created by the release-tag leg`);
    }
    const localTagObject = gitOutput(root, ["rev-parse", version]);
    if (localTagObject !== tagObjectSha) {
      throw new Error(`Release push refspec object ${tagObjectSha} is not the local tag ${version}${localTagObject ? ` (rev-parse reports ${localTagObject})` : ""}`);
    }
    const taggedCommit = gitOutput(root, ["rev-parse", `${version}^{}`]);
    if (taggedCommit !== sha) {
      throw new Error(`Release tag ${version} dereferences to commit ${taggedCommit ?? "<unknown>"}, not the pinned release commit ${sha}`);
    }
  }
}

export function consumeReleaseAuthorization(root, { token, action, cwd, command }, now = () => new Date()) {
  if (!RELEASE_ACTIONS.includes(action)) throw new Error(`Unsupported release authorization action: ${action}`);
  const file = authorizationPath(root, token);
  if (!fs.existsSync(file)) throw new Error("Authorization token was not found");
  const authorization = JSON.parse(fs.readFileSync(file, "utf8"));
  if (authorization.release !== true) throw new Error("Authorization token is not a release authorization");
  if (authorization.action !== action) throw new Error(`Authorization is for ${authorization.action}, not ${action}`);
  if (authorization.used_at) throw new Error("Authorization token has already been used");
  if (Date.parse(authorization.expires_at) <= now().getTime()) throw new Error("Authorization token has expired");
  assertReleaseExecutionScope(root, authorization, action, cwd, command);
  authorization.used_at = now().toISOString();
  atomicWrite(file, authorization);
  return authorization;
}

// issue-close / pr-merge 允许无令牌的状态自证:状态机到达 waiting_close / merging
// 之前已完成全部证据校验,当前状态本身就是授权。复用令牌消费的同一套
// assertActionState + assertExecutionScope;操作成功后状态离开目标态,重放即被拒。
export const STATE_VERIFIED_ACTIONS = Object.freeze(["issue-close", "pr-merge"]);

function actionTargetNumber(action, command) {
  const pattern = action === "issue-close"
    ? /\bgh\s+issue\s+close\s+(\d+)/
    : /\bgh\s+pr\s+merge\s+(\d+)/;
  const match = String(command ?? "").match(pattern);
  return match ? Number(match[1]) : null;
}

export function verifyStateAuthorization(root, { action, cwd, command }) {
  if (!STATE_VERIFIED_ACTIONS.includes(action)) {
    throw new Error(`${action} always requires a single-use Hulane authorization token`);
  }
  if (!cwd || !command) throw new Error("State verification requires command context");
  const number = actionTargetNumber(action, command);
  if (!Number.isInteger(number) || number <= 0) {
    throw new Error(`State-verified ${action} requires the target number in the command`);
  }
  const items = Object.values(readStore(root, { allowMissing: false }).items);
  const matches = items.filter((item) => (
    action === "issue-close" ? item.issue_number === number : item.pr_number === number
  ));
  if (matches.length !== 1) {
    throw new Error(`State verification requires exactly one Work Item for ${action} target ${number}`);
  }
  const item = matches[0];
  assertActionState(item, action);
  assertExecutionScope(root, item, action, cwd, command);
  return item;
}

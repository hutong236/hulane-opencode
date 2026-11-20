import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { issueAuthorization, consumeAuthorization, verifyStateAuthorization, issueReleaseAuthorization, consumeReleaseAuthorization } from "../hulane/scripts/lib/authorization.mjs";
import { createWorkItem } from "../hulane/scripts/lib/state-machine.mjs";
import { writeStore } from "../hulane/scripts/lib/state-store.mjs";
import { analyzeCommand, evaluateCommand } from "../hulane/hooks/guard.mjs";

const clock = () => new Date("2026-08-31T12:00:00Z");
const sha = "a".repeat(40);
// 已记录 specs_synced 证据的 waiting_close 条目(标准工单默认 spec_sync_required=true)
const specSynced = { specs_synced: true, specs_commit_sha: sha, spec_delta_dir: "openspec/changes/archive/REQ-25" };

function repositoryWithItem(status, overrides = {}) {
  // git 输出真实路径,macOS 的 /var 软链需先解析才能与夹具路径一致
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "hulane-auth-")));
  execFileSync("git", ["init", "-q"], { cwd: root });
  const item = { ...createWorkItem({
    id: "REQ-25",
    issue_number: 25,
    title: "Authorization test",
    risk_level: "low",
    delivery_required: true,
  }, clock), status, ...overrides };
  writeStore(root, { schema_version: 2, repository: "acme/demo", revision: 0, updated_at: clock().toISOString(), items: { [item.id]: item } });
  return { root, item };
}

// release 令牌夹具:本地 bare origin + 已推送的初始分支(默认 main,可指定 master 等),
// 使 git ls-remote 校验在离线环境可复现
function releaseRepository(initialBranch = "main") {
  const origin = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "hulane-release-origin-")));
  execFileSync("git", ["init", "-q", "--bare", "-b", initialBranch, origin]);
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "hulane-release-")));
  execFileSync("git", ["init", "-q", "-b", initialBranch, root]);
  for (const [key, value] of [["user.email", "test@example.com"], ["user.name", "Hulane Test"]]) {
    execFileSync("git", ["config", key, value], { cwd: root });
  }
  fs.writeFileSync(path.join(root, "README.md"), "release\n");
  execFileSync("git", ["add", "README.md"], { cwd: root });
  execFileSync("git", ["commit", "-qm", "initial"], { cwd: root });
  execFileSync("git", ["remote", "add", "origin", origin], { cwd: root });
  execFileSync("git", ["push", "-q", "origin", initialBranch], { cwd: root });
  const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
  return { root, origin, sha: head };
}

test("execution authorizations are state-bound and single-use", () => {
  const { root } = repositoryWithItem("waiting_close", specSynced);
  const authorization = issueAuthorization(root, {
    id: "REQ-25",
    action: "issue-close",
    actor: "orchestrator",
    ttlSeconds: 120,
  }, clock);
  const consumed = consumeAuthorization(root, {
    token: authorization.token,
    action: "issue-close",
    cwd: root,
    command: `HULANE_AUTH_TOKEN=${authorization.token} gh issue close 25`,
  }, clock);
  assert.equal(consumed.work_item, "REQ-25");
  assert.throws(() => consumeAuthorization(root, {
    token: authorization.token,
    action: "issue-close",
    cwd: root,
    command: `HULANE_AUTH_TOKEN=${authorization.token} gh issue close 25`,
  }, clock), /already been used/);
});

test("authorization rejects the wrong lifecycle state and non-orchestrators", () => {
  const { root } = repositoryWithItem("doing");
  assert.throws(() => issueAuthorization(root, {
    id: "REQ-25",
    action: "git-push",
    actor: "orchestrator",
  }, clock), /forbidden while/);
  assert.throws(() => issueAuthorization(root, {
    id: "REQ-25",
    action: "git-push",
    actor: "hulane-coder",
  }, clock), /Primary Agent/);
});

test("PR merge authorization pins the control-plane-verified head SHA", () => {
  const sha = "a".repeat(40);
  const { root } = repositoryWithItem("merging", {
    pr_number: 42,
    reviewer_result: "approved",
    pr_checks: "passed",
    pr_check_name: "Hulane PR Checks / verify",
    pr_check_run_url: "https://github.com/acme/demo/actions/runs/456",
    pr_head_sha: sha,
    merge_guard_mode: "control_plane_verified",
    required_checks_enforced: false,
  });
  const authorization = issueAuthorization(root, {
    id: "REQ-25",
    action: "pr-merge",
    actor: "orchestrator",
  }, clock);
  assert.throws(() => consumeAuthorization(root, {
    token: authorization.token,
    action: "pr-merge",
    cwd: root,
    command: "gh pr merge 42 --squash",
  }, clock), /pin verified head SHA/);
  const consumed = consumeAuthorization(root, {
    token: authorization.token,
    action: "pr-merge",
    cwd: root,
    command: `gh pr merge 42 --squash --match-head-commit ${sha}`,
  }, clock);
  assert.equal(consumed.target.pr_head_sha, sha);
});

test("guard classifies protected shell operations", () => {
  assert.deepEqual(analyzeCommand("git status && git push origin hulane/req-25"), ["git-push"]);
  assert.deepEqual(analyzeCommand("gh pr merge 42 --squash"), ["pr-merge"]);
  assert.deepEqual(analyzeCommand("git tag --list 'v*'"), []);
  assert.deepEqual(analyzeCommand("git tag -a v2.0.0 -m release"), ["git-tag"]);
  assert.deepEqual(analyzeCommand("gh issue close 25"), ["issue-close"]);
  const { root } = repositoryWithItem("waiting_close");
  assert.match(evaluateCommand({ cwd: root, command: "cd /tmp && git push origin main" }).reason, /working directory directly/);
});

test("state verification authorizes issue close and pr merge without a token", () => {
  const { root } = repositoryWithItem("waiting_close", specSynced);
  const item = verifyStateAuthorization(root, {
    action: "issue-close",
    cwd: root,
    command: 'gh issue close 25 --repo acme/demo --comment "Done"',
  });
  assert.equal(item.id, "REQ-25");
  assert.throws(() => verifyStateAuthorization(root, {
    action: "issue-close",
    cwd: root,
    command: "gh issue close 999",
  }), /exactly one Work Item/);
  assert.throws(() => verifyStateAuthorization(root, {
    action: "issue-close",
    cwd: root,
    command: "gh issue edit 25",
  }), /requires the target number/);
});

test("issue close demands specs_synced evidence on spec_sync_required items (token and state-verified paths)", () => {
  const { root } = repositoryWithItem("waiting_close");
  assert.throws(() => issueAuthorization(root, {
    id: "REQ-25",
    action: "issue-close",
    actor: "orchestrator",
  }, clock), /specs_synced/);
  assert.throws(() => verifyStateAuthorization(root, {
    action: "issue-close",
    cwd: root,
    command: 'gh issue close 25 --repo acme/demo --comment "Done"',
  }), /specs_synced/);

  const exempt = repositoryWithItem("waiting_close", { spec_sync_required: false });
  const allowed = verifyStateAuthorization(exempt.root, {
    action: "issue-close",
    cwd: exempt.root,
    command: 'gh issue close 25 --repo acme/demo --comment "Done"',
  });
  assert.equal(allowed.id, "REQ-25");
});

test("state verification never covers push or tag operations", () => {
  const { root } = repositoryWithItem("waiting_close");
  assert.throws(() => verifyStateAuthorization(root, {
    action: "git-push",
    cwd: root,
    command: "git push origin main",
  }), /always requires a single-use Hulane authorization token/);
  assert.throws(() => verifyStateAuthorization(root, {
    action: "git-tag",
    cwd: root,
    command: "git tag -a v1.0.0 -m release",
  }), /always requires a single-use Hulane authorization token/);
});

test("state-verified pr merge enforces the same pinned head SHA as tokens", () => {
  const sha = "a".repeat(40);
  const { root } = repositoryWithItem("merging", {
    pr_number: 42,
    reviewer_result: "approved",
    pr_checks: "passed",
    pr_check_name: "Hulane PR Checks / verify",
    pr_check_run_url: "https://github.com/acme/demo/actions/runs/456",
    pr_head_sha: sha,
    merge_guard_mode: "control_plane_verified",
    required_checks_enforced: false,
  });
  assert.throws(() => verifyStateAuthorization(root, {
    action: "pr-merge",
    cwd: root,
    command: "gh pr merge 42 --squash",
  }), /pin verified head SHA/);
  const item = verifyStateAuthorization(root, {
    action: "pr-merge",
    cwd: root,
    command: `gh pr merge 42 --squash --match-head-commit ${sha}`,
  });
  assert.equal(item.id, "REQ-25");
});

test("release issuance validates SemVer, 40-hex SHA, origin default-branch HEAD, remote tag absence, and orchestrator actor", () => {
  const { root, sha } = releaseRepository();
  assert.throws(
    () => issueReleaseAuthorization(root, { version: "1.2", sha, evidence: "release" }, clock),
    /strict SemVer/,
  );
  assert.throws(
    () => issueReleaseAuthorization(root, { version: "v1.2.3", sha: "nothex", evidence: "release" }, clock),
    /40-character commit SHA/,
  );
  assert.throws(
    () => issueReleaseAuthorization(root, { version: "v1.2.3", sha: "b".repeat(40), evidence: "release" }, clock),
    /origin default-branch HEAD/,
  );
  assert.throws(
    () => issueReleaseAuthorization(root, { version: "v1.2.3", sha, actor: "hulane-coder", evidence: "release" }, clock),
    /Primary Agent/,
  );
  assert.throws(
    () => issueReleaseAuthorization(root, { version: "v1.2.3", sha, evidence: "  " }, clock),
    /requires evidence/,
  );

  // 目标 tag 已在远端存在:拒绝再次签发
  execFileSync("git", ["tag", "v1.2.3", sha], { cwd: root });
  execFileSync("git", ["push", "-q", "origin", "v1.2.3"], { cwd: root });
  assert.throws(
    () => issueReleaseAuthorization(root, { version: "v1.2.3", sha, evidence: "release" }, clock),
    /already exists on the remote/,
  );

  // 合法签发:裸 SemVer 与 v 前缀都接受,规范形为 vX.Y.Z,一次返回两枚单次令牌
  const issued = issueReleaseAuthorization(root, { version: "1.2.4", sha, evidence: "user asked to ship the batch" }, clock);
  assert.equal(issued.version, "v1.2.4");
  assert.equal(issued.sha, sha);
  assert.match(issued.tag_token, /^[0-9a-f]{64}$/);
  assert.match(issued.push_token, /^[0-9a-f]{64}$/);
  assert.notEqual(issued.tag_token, issued.push_token);
  assert.equal(issued.expires_at, new Date("2026-08-31T12:02:00Z").toISOString());
  const prefixed = issueReleaseAuthorization(root, { version: "v1.2.5", sha: sha.toUpperCase(), evidence: "release" }, clock);
  assert.equal(prefixed.version, "v1.2.5");
  assert.equal(prefixed.sha, sha);
});

test("release issuance accepts repositories whose origin default branch is master (no main)", () => {
  const { root, sha } = releaseRepository("master");
  const issued = issueReleaseAuthorization(root, { version: "v1.0.0", sha, evidence: "release" }, clock);
  assert.equal(issued.version, "v1.0.0");
  assert.equal(issued.sha, sha);
});

test("release issuance follows the symref default branch and ignores a stale main ref", () => {
  const origin = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "hulane-release-origin-")));
  execFileSync("git", ["init", "-q", "--bare", "-b", "master", origin]);
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "hulane-release-")));
  execFileSync("git", ["init", "-q", "-b", "master", root]);
  for (const [key, value] of [["user.email", "test@example.com"], ["user.name", "Hulane Test"]]) {
    execFileSync("git", ["config", key, value], { cwd: root });
  }
  fs.writeFileSync(path.join(root, "README.md"), "stale\n");
  execFileSync("git", ["add", "README.md"], { cwd: root });
  execFileSync("git", ["commit", "-qm", "stale main"], { cwd: root });
  execFileSync("git", ["remote", "add", "origin", origin], { cwd: root });
  execFileSync("git", ["push", "-q", "origin", "HEAD:refs/heads/main"], { cwd: root });
  fs.writeFileSync(path.join(root, "README.md"), "default\n");
  execFileSync("git", ["add", "README.md"], { cwd: root });
  execFileSync("git", ["commit", "-qm", "master head"], { cwd: root });
  execFileSync("git", ["push", "-q", "origin", "master"], { cwd: root });
  const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();

  // 远端同时存在陈旧 main 与默认分支 master:以 symref 解析的 master HEAD 为基准
  const issued = issueReleaseAuthorization(root, { version: "v2.0.0", sha: head, evidence: "release" }, clock);
  assert.equal(issued.version, "v2.0.0");
  assert.equal(issued.sha, head);
  assert.throws(
    () => issueReleaseAuthorization(root, { version: "v2.0.1", sha: "c".repeat(40), evidence: "release" }, clock),
    /origin default-branch HEAD/,
  );
});

test("release tokens are single-use, TTL-bound, leg-specific, and pinned to version+SHA", () => {
  const { root, sha } = releaseRepository();
  const issued = issueReleaseAuthorization(root, { version: "v1.3.0", sha, ttlSeconds: 60, evidence: "release" }, clock);

  // tag 腿必须同时点名钉死的 tag 与 SHA
  assert.throws(
    () => consumeReleaseAuthorization(root, { token: issued.tag_token, action: "release-tag", cwd: root, command: `git tag -a v1.3.0 -m "Release v1.3.0"` }, clock),
    /pinned release SHA/,
  );
  assert.throws(
    () => consumeReleaseAuthorization(root, { token: issued.tag_token, action: "release-tag", cwd: root, command: `git tag -a v9.9.9 -m "x" ${sha}` }, clock),
    /must name the pinned tag v1.3.0/,
  );
  // 两枚令牌各管一腿
  assert.throws(
    () => consumeReleaseAuthorization(root, { token: issued.tag_token, action: "release-push", cwd: root, command: "git push origin v1.3.0" }, clock),
    /Authorization is for release-tag, not release-push/,
  );
  assert.throws(
    () => consumeReleaseAuthorization(root, { token: issued.push_token, action: "release-tag", cwd: root, command: `git tag -a v1.3.0 -m x ${sha}` }, clock),
    /Authorization is for release-push, not release-tag/,
  );

  // 合法消费 tag 腿,随后单次语义拒绝重放
  const consumed = consumeReleaseAuthorization(root, {
    token: issued.tag_token,
    action: "release-tag",
    cwd: root,
    command: `HULANE_RELEASE_TAG_TOKEN=${issued.tag_token} git tag -a v1.3.0 -m "Release v1.3.0" ${sha}`,
  }, clock);
  assert.equal(consumed.target.version, "v1.3.0");
  assert.equal(consumed.target.sha, sha);
  assert.equal(consumed.work_item, null);
  assert.throws(
    () => consumeReleaseAuthorization(root, { token: issued.tag_token, action: "release-tag", cwd: root, command: `git tag -a v1.3.0 -m x ${sha}` }, clock),
    /already been used/,
  );

  // push 腿推送 tag 腿创建的 annotated tag 对象;简单 tag 名 refspec 不放行
  assert.throws(
    () => consumeReleaseAuthorization(root, { token: issued.push_token, action: "release-push", cwd: root, command: "git push origin v1.3.0" }, clock),
    /exactly one explicit refspec/,
  );
  // 钉死 commit SHA 不是 annotated tag 对象:拒绝(必须先经 tag 腿建 annotated tag)
  assert.throws(
    () => consumeReleaseAuthorization(root, { token: issued.push_token, action: "release-push", cwd: root, command: `git push origin ${sha}:refs/tags/v1.3.0` }, clock),
    /not an annotated tag object/,
  );
  execFileSync("git", ["tag", "-a", "v1.3.0", "-m", "Release v1.3.0", sha], { cwd: root });
  const tagObjectSha = execFileSync("git", ["rev-parse", "v1.3.0"], { cwd: root, encoding: "utf8" }).trim();
  assert.match(tagObjectSha, /^[0-9a-f]{40}$/);
  assert.notEqual(tagObjectSha, sha);
  const pushed = consumeReleaseAuthorization(root, {
    token: issued.push_token,
    action: "release-push",
    cwd: root,
    command: `HULANE_RELEASE_PUSH_TOKEN=${issued.push_token} git push origin ${tagObjectSha}:refs/tags/v1.3.0`,
  }, clock);
  assert.equal(pushed.target.version, "v1.3.0");
  const secondPair = issueReleaseAuthorization(root, { version: "v1.3.1", sha, ttlSeconds: 60, evidence: "release" }, clock);
  // refspec 形式正确但对象在仓库中不存在:拒绝
  assert.throws(
    () => consumeReleaseAuthorization(root, { token: secondPair.push_token, action: "release-push", cwd: root, command: `git push origin ${"b".repeat(40)}:refs/tags/v1.3.1` }, clock),
    /not an annotated tag object/,
  );
  // 分支推送连 tag 都未点名:拒绝
  assert.throws(
    () => consumeReleaseAuthorization(root, { token: secondPair.push_token, action: "release-push", cwd: root, command: "git push origin main" }, clock),
    /must name the pinned tag v1\.3\.1/,
  );
});

test("release push rejects multi-refspec smuggling and duplicates (exactly one pinned refspec)", () => {
  const { root, sha } = releaseRepository();

  // 钉死 refspec + 夹带另一条同形 tag refspec:直接调用消费层复现 Reviewer 场景,必须拒绝
  const smuggled = issueReleaseAuthorization(root, { version: "v1.5.0", sha, evidence: "release" }, clock);
  assert.throws(
    () => consumeReleaseAuthorization(root, {
      token: smuggled.push_token,
      action: "release-push",
      cwd: root,
      command: `git push origin ${sha}:refs/tags/v1.5.0 ${"b".repeat(40)}:refs/tags/v9.9.9`,
    }, clock),
    /exactly one explicit refspec/,
  );

  // 同一钉死 refspec 重复两条:恰好一条才放行
  const duplicated = issueReleaseAuthorization(root, { version: "v1.5.1", sha, evidence: "release" }, clock);
  assert.throws(
    () => consumeReleaseAuthorization(root, {
      token: duplicated.push_token,
      action: "release-push",
      cwd: root,
      command: `git push origin ${sha}:refs/tags/v1.5.1 ${sha}:refs/tags/v1.5.1`,
    }, clock),
    /exactly one explicit refspec/,
  );

  // 钉死 refspec + 分支混合:拒绝
  const mixed = issueReleaseAuthorization(root, { version: "v1.5.2", sha, evidence: "release" }, clock);
  assert.throws(
    () => consumeReleaseAuthorization(root, {
      token: mixed.push_token,
      action: "release-push",
      cwd: root,
      command: `git push origin ${sha}:refs/tags/v1.5.2 main`,
    }, clock),
    /exactly one explicit refspec/,
  );

  // 单条钉死 refspec(annotated tag 对象)照常放行
  const single = issueReleaseAuthorization(root, { version: "v1.5.3", sha, evidence: "release" }, clock);
  execFileSync("git", ["tag", "-a", "v1.5.3", "-m", "Release v1.5.3", sha], { cwd: root });
  const singleTagObject = execFileSync("git", ["rev-parse", "v1.5.3"], { cwd: root, encoding: "utf8" }).trim();
  const consumed = consumeReleaseAuthorization(root, {
    token: single.push_token,
    action: "release-push",
    cwd: root,
    command: `git push origin ${singleTagObject}:refs/tags/v1.5.3`,
  }, clock);
  assert.equal(consumed.target.version, "v1.5.3");
});

test("release push ships the annotated tag object with a triple verification chain", () => {
  const { root, sha } = releaseRepository();
  const issued = issueReleaseAuthorization(root, { version: "v1.6.0", sha, evidence: "release" }, clock);
  execFileSync("git", ["tag", "-a", "v1.6.0", "-m", "Release v1.6.0", sha], { cwd: root });
  const tagObjectSha = execFileSync("git", ["rev-parse", "v1.6.0"], { cwd: root, encoding: "utf8" }).trim();
  // 合法链:对象为 annotated tag + 即本地钉死版本之 tag 对象 + 解引用为钉死 commit
  const consumed = consumeReleaseAuthorization(root, {
    token: issued.push_token,
    action: "release-push",
    cwd: root,
    command: `git push origin ${tagObjectSha}:refs/tags/v1.6.0`,
  }, clock);
  assert.equal(consumed.target.sha, sha);

  // 轻量 tag 蒙混:同版本建成轻量 tag,rev-parse 直接给出 commit,cat-file -t 为 commit:①拒
  const lightweight = issueReleaseAuthorization(root, { version: "v1.6.1", sha, evidence: "release" }, clock);
  execFileSync("git", ["tag", "v1.6.1", sha], { cwd: root });
  const lightweightObject = execFileSync("git", ["rev-parse", "v1.6.1"], { cwd: root, encoding: "utf8" }).trim();
  assert.equal(lightweightObject, sha);
  assert.throws(
    () => consumeReleaseAuthorization(root, {
      token: lightweight.push_token,
      action: "release-push",
      cwd: root,
      command: `git push origin ${lightweightObject}:refs/tags/v1.6.1`,
    }, clock),
    /not an annotated tag object/,
  );

  // refspec 指向别的 annotated 对象:①过②拒(不是本地钉死版本之 tag 对象)
  const other = issueReleaseAuthorization(root, { version: "v1.6.2", sha, evidence: "release" }, clock);
  execFileSync("git", ["tag", "-a", "v1.6.2", "-m", "Release v1.6.2", sha], { cwd: root });
  execFileSync("git", ["tag", "-a", "extra-tag", "-m", "another annotated object", sha], { cwd: root });
  const otherObject = execFileSync("git", ["rev-parse", "extra-tag"], { cwd: root, encoding: "utf8" }).trim();
  assert.throws(
    () => consumeReleaseAuthorization(root, {
      token: other.push_token,
      action: "release-push",
      cwd: root,
      command: `git push origin ${otherObject}:refs/tags/v1.6.2`,
    }, clock),
    /is not the local tag v1\.6\.2/,
  );

  // annotated 但解引用 ≠ 钉死 commit:main 前进后 tag 仍指旧 commit,③拒
  fs.writeFileSync(path.join(root, "README.md"), "release 2\n");
  execFileSync("git", ["add", "README.md"], { cwd: root });
  execFileSync("git", ["commit", "-qm", "second"], { cwd: root });
  execFileSync("git", ["push", "-q", "origin", "main"], { cwd: root });
  const secondSha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
  const stale = issueReleaseAuthorization(root, { version: "v1.6.3", sha: secondSha, evidence: "release" }, clock);
  execFileSync("git", ["tag", "-a", "v1.6.3", "-m", "Release v1.6.3", sha], { cwd: root });
  const staleObject = execFileSync("git", ["rev-parse", "v1.6.3"], { cwd: root, encoding: "utf8" }).trim();
  assert.throws(
    () => consumeReleaseAuthorization(root, {
      token: stale.push_token,
      action: "release-push",
      cwd: root,
      command: `git push origin ${staleObject}:refs/tags/v1.6.3`,
    }, clock),
    /dereferences to commit .* not the pinned release commit/,
  );
});

test("release tokens expire past their TTL and work-item tokens never pass as release tokens", () => {
  const { root, sha } = releaseRepository();
  const issued = issueReleaseAuthorization(root, { version: "v1.4.0", sha, ttlSeconds: 10, evidence: "release" }, clock);
  assert.throws(
    () => consumeReleaseAuthorization(root, {
      token: issued.tag_token,
      action: "release-tag",
      cwd: root,
      command: `git tag -a v1.4.0 -m x ${sha}`,
    }, () => new Date("2026-08-31T12:00:11Z")),
    /expired/,
  );
  assert.throws(
    () => consumeReleaseAuthorization(root, { token: issued.push_token, action: "release-push", cwd: root, command: `git push origin ${sha}:refs/tags/v1.4.0` }, () => new Date("2026-08-31T12:00:11Z")),
    /expired/,
  );

  // 工单令牌不进入 release 通道,release 令牌也不进入工单通道(同一仓库内交叉验证)
  const item = { ...createWorkItem({
    id: "REQ-25",
    issue_number: 25,
    title: "Authorization test",
    risk_level: "low",
    delivery_required: true,
  }, clock), status: "waiting_close", ...specSynced };
  writeStore(root, { schema_version: 2, repository: "acme/demo", revision: 0, updated_at: clock().toISOString(), items: { [item.id]: item } });
  const workItemToken = issueAuthorization(root, { id: "REQ-25", action: "issue-close", actor: "orchestrator" }, clock);
  assert.throws(
    () => consumeReleaseAuthorization(root, { token: workItemToken.token, action: "release-tag", cwd: root, command: `git tag -a v1.4.0 -m x ${sha}` }, clock),
    /not a release authorization/,
  );
  assert.throws(
    () => consumeReleaseAuthorization(root, { token: issued.tag_token, action: "git-tag", cwd: root, command: "git tag -a v1.4.0" }, clock),
    /Unsupported release authorization action/,
  );
  assert.throws(
    () => consumeAuthorization(root, { token: issued.tag_token, action: "issue-close", cwd: root, command: "gh issue close 25" }, clock),
    /Authorization is for release-tag/,
  );
});

// REQ-11:pending 工单(Issue 未补建)不允许关单/合并——目标对象尚不存在,
// 必须先经 hulane_flush 在线窗口补建回填;token 路径与状态自证路径共用断言
test("issue close and pr merge refuse issue_pending items until flush", () => {
  const githubGuard = {
    reviewer_result: "approved",
    pr_checks: "passed",
    pr_check_name: "Hulane PR Checks / verify",
    pr_check_run_url: "https://github.com/acme/demo/actions/runs/456",
    pr_head_sha: sha,
    merge_guard_mode: "control_plane_verified",
    required_checks_enforced: false,
    pr_number: 42,
  };
  const closeRepo = repositoryWithItem("waiting_close", {
    issue_pending: true,
    issue_number: null,
    github_issue_url: null,
    ...specSynced,
  });
  assert.throws(() => issueAuthorization(closeRepo.root, {
    id: "REQ-25",
    action: "issue-close",
    actor: "orchestrator",
  }, clock), /run hulane_flush first/);

  const mergeRepo = repositoryWithItem("merging", {
    issue_pending: true,
    issue_number: null,
    github_issue_url: null,
    ...githubGuard,
  });
  assert.throws(() => issueAuthorization(mergeRepo.root, {
    id: "REQ-25",
    action: "pr-merge",
    actor: "orchestrator",
  }, clock), /run hulane_flush first/);

  // 回填后(flush 完成)同一工单恢复可授权
  const flushed = repositoryWithItem("waiting_close", specSynced);
  const authorization = issueAuthorization(flushed.root, {
    id: "REQ-25",
    action: "issue-close",
    actor: "orchestrator",
  }, clock);
  assert.equal(authorization.work_item, "REQ-25");
});

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { runPreflight } from "../hulane/scripts/lib/preflight.mjs";

// REQ-11 最小离线容忍的契约测试:GitHub 依赖检查归入 online_required 分组,
// 只有本地硬项(git/origin/workflow 文件/镜像 workflow)才判 NOT_READY。
// 不碰业务语义,只钉分组与 verdict 行为。

// 本地硬项全绿的最小仓库:origin 远端 + PR checks workflow 两个文件、无 Dockerfile
function localReadyRepository() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "hulane-preflight-"));
  execFileSync("git", ["init", "-q"], { cwd: root });
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: root });
  execFileSync("git", ["config", "user.name", "Hulane Test"], { cwd: root });
  execFileSync("git", ["remote", "add", "origin", "https://github.com/acme/demo.git"], { cwd: root });
  fs.mkdirSync(path.join(root, ".github", "workflows"), { recursive: true });
  fs.writeFileSync(path.join(root, ".github", "workflows", "pr-checks.yml"), "name: Hulane PR Checks\n");
  fs.mkdirSync(path.join(root, ".github", "scripts"), { recursive: true });
  fs.writeFileSync(path.join(root, ".github", "scripts", "hulane-pr-checks.sh"), "#!/bin/sh\nexit 0\n");
  return root;
}

// 失败垫片:让指定命令(git/gh)每次调用必败,模拟工具缺失或网络不可达
function withFailingShims(names, fn) {
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), "hulane-preflight-bin-"));
  for (const name of names) {
    fs.writeFileSync(path.join(bin, name), "#!/bin/sh\necho \"simulated failure\" >&2\nexit 1\n", { mode: 0o755 });
  }
  const previousPath = process.env.PATH;
  process.env.PATH = `${bin}${path.delimiter}${previousPath}`;
  try {
    return fn();
  } finally {
    process.env.PATH = previousPath;
  }
}

const ONLINE_GROUP = new Set(["gh", "gh_auth", "github_repository", "required_server_check", "merge_guard"]);

test("GitHub-class failures degrade to READY_WITH_WARNINGS with offline_open_ready", () => {
  const root = localReadyRepository();
  // 真实 git 可用、gh 必败:gh/gh_auth/github_repository/required_server_check/merge_guard 全 FAIL
  const result = withFailingShims(["gh"], () => runPreflight(root));
  assert.equal(result.readiness, "READY_WITH_WARNINGS"); // 不再因 GitHub 不可达判 NOT_READY
  assert.equal(result.offline_open_ready, true); // 本地硬项全过,断网可本地开单
  assert.equal(result.online_required.ready, false);
  for (const name of ["gh_auth", "github_repository", "merge_guard"]) {
    assert.ok(result.online_required.failed.includes(name), `${name} must be reported in online_required.failed`);
  }
  // 分组标注:GitHub 依赖检查归 online_required,本地项归 local
  for (const check of result.checks) {
    assert.equal(check.group, ONLINE_GROUP.has(check.name) ? "online_required" : "local", `${check.name} group`);
  }
});

test("local hard items (git/origin) failing still yields NOT_READY", () => {
  const root = localReadyRepository();
  // git 必败:git 与 origin 双双 FAIL(本地硬项),gh 一并必败不影响判定来源
  const result = withFailingShims(["git", "gh"], () => runPreflight(root));
  assert.equal(result.readiness, "NOT_READY");
  assert.equal(result.offline_open_ready, false);
  assert.equal(result.online_required.ready, false);
  const failedLocal = result.checks.filter((check) => check.group === "local" && check.result === "FAIL").map((check) => check.name);
  assert.ok(failedLocal.includes("git"));
  assert.ok(failedLocal.includes("origin"));
});

test("tag-only image workflow rejects lightweight tags and mismatched remote tag objects", () => {
  const workflow = fs.readFileSync(
    path.resolve(path.dirname(new URL(import.meta.url).pathname), "../hulane/templates/github-actions/build-image.yml"),
    "utf8",
  );
  assert.match(workflow, /git cat-file -t/);
  assert.match(workflow, /tag_type.*!= "tag"/);
  assert.match(workflow, /git ls-remote --tags origin/);
  assert.match(workflow, /remote_tag_object.*!=.*local_tag_object/);
  assert.match(workflow, /git rev-parse.*\^\{commit\}/);
  assert.match(workflow, /git merge-base --is-ancestor/);
});

test("tag-only image release publishes signed provenance and SPDX SBOM attestations", () => {
  const workflow = fs.readFileSync(
    path.resolve(path.dirname(new URL(import.meta.url).pathname), "../hulane/templates/github-actions/build-image.yml"), "utf8");
  assert.match(workflow, /attestations: write/);
  assert.match(workflow, /id-token: write/);
  assert.match(workflow, /actions\/attest@v4/g);
  assert.match(workflow, /anchore\/sbom-action@v0/);
  assert.match(workflow, /subject-digest:.*steps\.build\.outputs\.digest/);
  assert.match(workflow, /sbom-path: delivery-sbom\.spdx\.json/);
  assert.match(workflow, /push-to-registry: true/);
});

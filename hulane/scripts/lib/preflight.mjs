import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

function run(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, encoding: "utf8", maxBuffer: 10 * 1024 * 1024 });
  return {
    ok: result.status === 0,
    output: String(result.stdout || result.stderr || result.error?.message || "").trim(),
  };
}

function contains(file, patterns) {
  if (!fs.existsSync(file)) return false;
  const content = fs.readFileSync(file, "utf8");
  return patterns.every((pattern) => pattern.test(content));
}

export function runPreflight(root) {
  const checks = [];
  const add = (name, ok, evidence, requiredAction = null) => checks.push({ name, result: ok ? "PASS" : "FAIL", evidence, required_action: ok ? null : requiredAction });

  const git = run("git", ["--version"], root);
  add("git", git.ok, git.output, "Install Git and reopen the workspace");
  const remote = run("git", ["remote", "get-url", "origin"], root);
  add("origin", remote.ok, remote.output, "Configure the origin remote");

  const gh = run("gh", ["--version"], root);
  add("gh", gh.ok, gh.output, "Install GitHub CLI");
  const auth = gh.ok ? run("gh", ["auth", "status"], root) : { ok: false, output: "gh unavailable" };
  add("gh_auth", auth.ok, auth.output, "Authenticate GitHub CLI for this repository");

  const repositoryResult = auth.ok ? run("gh", ["repo", "view", "--json", "nameWithOwner,defaultBranchRef,isPrivate"], root) : { ok: false, output: "GitHub unavailable" };
  let repository = null;
  let defaultBranch = null;
  let isPrivate = false;
  if (repositoryResult.ok) {
    const data = JSON.parse(repositoryResult.output);
    repository = data.nameWithOwner;
    defaultBranch = data.defaultBranchRef?.name ?? null;
    isPrivate = Boolean(data.isPrivate);
  }
  add("github_repository", Boolean(repository && defaultBranch), repositoryResult.output, "Grant repository read access");

  const prWorkflow = path.join(root, ".github", "workflows", "pr-checks.yml");
  const prRunner = path.join(root, ".github", "scripts", "hulane-pr-checks.sh");
  add("pr_checks_workflow", fs.existsSync(prWorkflow) && fs.existsSync(prRunner), `${prWorkflow}; ${prRunner}`, "Run hulane_initialize or install an equivalent required-check workflow");

  let protection = { ok: false, output: "GitHub repository unavailable" };
  let ruleset = { ok: false, output: "Ruleset unavailable" };
  if (repository && defaultBranch) {
    protection = run("gh", ["api", `repos/${repository}/branches/${defaultBranch}/protection`, "--jq", ".required_status_checks.contexts // []"], root);
    ruleset = run("gh", ["api", `repos/${repository}/rules/branches/${defaultBranch}`, "--jq", "[.[] | select(.type == \"required_status_checks\") | .parameters.required_status_checks[]?.context]"], root);
  }
  const requiredCheckPresent = (protection.ok && protection.output.includes("Hulane PR Checks / verify"))
    || (ruleset.ok && ruleset.output.includes("Hulane PR Checks / verify"));
  add("required_server_check", requiredCheckPresent, `branch protection: ${protection.output}; rulesets: ${ruleset.output}`, "Protect the default branch and require Hulane PR Checks / verify");
  const controlPlaneEligible = Boolean(isPrivate && auth.ok && fs.existsSync(prWorkflow) && fs.existsSync(prRunner));
  const mergeGuardReady = requiredCheckPresent || controlPlaneEligible;
  const mergeGuardMode = requiredCheckPresent ? "github_required_checks"
    : (controlPlaneEligible ? "control_plane_verified" : "unverified");
  add(
    "merge_guard",
    mergeGuardReady,
    requiredCheckPresent
      ? "GitHub enforces Hulane PR Checks / verify"
      : (controlPlaneEligible ? "Private repository: MCP verifies the exact head/check and requires human Gate B" : "No enforceable merge guard"),
    isPrivate ? "Install the PR checks workflow and authenticate gh" : "Protect the default branch and require Hulane PR Checks / verify",
  );

  const dockerfile = fs.existsSync(path.join(root, "Dockerfile"));
  const imageWorkflow = path.join(root, ".github", "workflows", "build-image.yml");
  const imageReady = !dockerfile || (contains(imageWorkflow, [
    /tags:\s*\["v\*"\]/,
    /git merge-base --is-ancestor/,
    /sbom:\s*true/,
    /provenance:\s*mode=max/,
    /delivery-metadata\.json/,
    /gh release upload/,
    /tr '\[:upper:\]' '\[:lower:\]'/,
  ]) && !fs.readFileSync(imageWorkflow, "utf8").includes("workflow_dispatch:"));
  add("image_delivery", imageReady, dockerfile ? imageWorkflow : "No Dockerfile; not applicable", "Install the V2 tag-only image workflow");

  const status = run("git", ["status", "--porcelain"], root);
  add("git_status", status.ok, status.output || "clean", "Resolve unreadable Git state");

  // 最小离线容忍(REQ-11):GitHub 依赖检查归入 online_required 分组——离线时
  // 不再判 NOT_READY,只压低整体就绪度;本地硬项(git/origin/workflow 文件/
  // 镜像 workflow)仍决定 offline_open_ready,断网也可本地开单流转
  const onlineRequired = new Set(["gh", "gh_auth", "github_repository", "required_server_check", "merge_guard"]);
  for (const check of checks) check.group = onlineRequired.has(check.name) ? "online_required" : "local";
  const localCritical = ["git", "origin", "pr_checks_workflow", "image_delivery"];
  const failedLocal = checks.filter((check) => localCritical.includes(check.name) && check.result === "FAIL");
  const failedOnline = checks.filter((check) => onlineRequired.has(check.name) && check.result === "FAIL");
  return {
    readiness: failedLocal.length ? "NOT_READY" : ((status.output || failedOnline.length) ? "READY_WITH_WARNINGS" : "READY"),
    offline_open_ready: failedLocal.length === 0,
    online_required: { ready: failedOnline.length === 0, failed: failedOnline.map((check) => check.name) },
    repository,
    default_branch: defaultBranch,
    private_repository: isPrivate,
    merge_guard_mode: mergeGuardMode,
    checks,
  };
}

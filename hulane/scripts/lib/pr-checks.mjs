import { runGh } from "./github-state.mjs";

const SHA_PATTERN = /^[0-9a-f]{40}$/i;
export const DEFAULT_PR_CHECK = "Hulane PR Checks / verify";

function upper(value) {
  return String(value ?? "").toUpperCase();
}

function checkNames(check) {
  const name = String(check.name ?? check.context ?? "").trim();
  const workflow = String(check.workflowName ?? "").trim();
  return new Set([name, workflow && name ? `${workflow} / ${name}` : ""].filter(Boolean));
}

function checkSucceeded(check) {
  if (check.__typename === "StatusContext" || "state" in check) {
    return upper(check.state) === "SUCCESS";
  }
  return upper(check.status) === "COMPLETED" && upper(check.conclusion) === "SUCCESS";
}

function checkUrl(check) {
  return check.detailsUrl ?? check.targetUrl ?? check.url ?? null;
}

function matchesCheck(check, expected) {
  const names = checkNames(check);
  const workflow = String(check.workflowName ?? "").trim();
  if (workflow) return names.has(expected) && expected.includes(" / ");
  return names.has(expected);
}

function contextMatchesCheck(context, check) {
  const value = String(context ?? "").trim();
  if (!value) return false;
  return checkNames(check).has(value);
}

export function evaluatePrCheckEvidence({
  pr,
  isPrivate,
  requiredContexts = [],
  checkName = DEFAULT_PR_CHECK,
  riskLevel = "high",
}) {
  if (String(pr?.state ?? "").toLowerCase() !== "open") throw new Error("PR checks require an open pull request");
  if (pr?.isDraft) throw new Error("PR checks cannot pass while the pull request is a draft");
  if (!SHA_PATTERN.test(String(pr?.headRefOid ?? ""))) throw new Error("PR checks require a valid head SHA");

  const matches = (pr.statusCheckRollup ?? []).filter((check) => matchesCheck(check, checkName));
  if (!matches.length) throw new Error(`Required workflow check was not found: ${checkName}`);
  // A passing duplicate must never shadow a pending/failed same-name run.
  // The GitHub rollup is tied to the exact current headRefOid.
  if (!matches.every(checkSucceeded)) throw new Error(`PR workflow check has not succeeded for every matching run: ${checkName}`);
  const successful = matches[0];
  const url = checkUrl(successful);
  if (!/^https:\/\/github\.com\//.test(String(url ?? ""))) {
    throw new Error(`PR workflow check is missing a GitHub details URL: ${checkName}`);
  }

  const rollup = pr.statusCheckRollup ?? [];
  // Required checks are independently enforced by GitHub, but the control
  // plane must also validate every required context against the current PR.
  for (const context of requiredContexts) {
    const matched = rollup.filter(check => contextMatchesCheck(context, check));
    if (!matched.length || !matched.every(checkSucceeded)) {
      throw new Error(`Required GitHub check is missing or unsuccessful: ${context}`);
    }
  }
  const serverEnforced = requiredContexts.some((context) => contextMatchesCheck(context, successful));
  if (!serverEnforced && !isPrivate) {
    throw new Error("Public repositories must enforce the PR check with GitHub branch protection or a ruleset");
  }
  if (!serverEnforced) {
    const nonSuccessful = (pr.statusCheckRollup ?? []).filter((candidate) => !checkSucceeded(candidate));
    if (nonSuccessful.length) {
      throw new Error("Control-plane merge guard requires every reported PR check to succeed");
    }
  }

  return {
    patch: {
      pr_checks: "passed",
      pr_check_name: checkName,
      pr_check_run_url: url,
      pr_head_sha: pr.headRefOid,
      merge_guard_mode: serverEnforced ? "github_required_checks" : "control_plane_verified",
      required_checks_enforced: serverEnforced,
    },
    server_enforced: serverEnforced,
    private_repository: Boolean(isPrivate),
    human_merge_required: riskLevel === "high",
  };
}

function safeJsonGh(args, cwd, fallback) {
  try {
    return JSON.parse(runGh(args, { cwd }));
  } catch {
    return fallback;
  }
}

function protectionContexts(protection) {
  const checks = protection?.required_status_checks?.checks ?? [];
  const contexts = protection?.required_status_checks?.contexts ?? [];
  return [...contexts, ...checks.map((check) => check.context)].filter(Boolean);
}

function rulesetContexts(rules) {
  if (!Array.isArray(rules)) return [];
  return rules.flatMap((rule) => {
    if (rule.type !== "required_status_checks") return [];
    return (rule.parameters?.required_status_checks ?? []).map((check) => check.context).filter(Boolean);
  });
}

export function assertDefaultBranchTarget(prBase, defaultBranch) {
  if (!String(defaultBranch ?? "").trim() || prBase !== defaultBranch) {
    throw new Error(`PR must target the repository default branch (${defaultBranch ?? "<unknown>"}), found ${prBase ?? "<missing>"}`);
  }
}

export function verifyPullRequestChecks({ root, repository, item, checkName = DEFAULT_PR_CHECK }) {
  if (item.status !== "pr_checking") throw new Error("PR check verification requires pr_checking state");
  if (!Number.isInteger(item.pr_number)) throw new Error("PR check verification requires a recorded PR number");

  const repositoryInfo = JSON.parse(runGh([
    "repo", "view", repository, "--json", "isPrivate,defaultBranchRef",
  ], { cwd: root }));
  const pr = JSON.parse(runGh([
    "pr", "view", String(item.pr_number), "--repo", repository,
    "--json", "number,state,isDraft,url,headRefOid,baseRefName,statusCheckRollup",
  ], { cwd: root }));
  if (pr.number !== item.pr_number) throw new Error("GitHub returned a different PR number");

  const base = pr.baseRefName;
  const defaultBranch = repositoryInfo.defaultBranchRef?.name;
  assertDefaultBranchTarget(base, defaultBranch);
  const protection = safeJsonGh(["api", `repos/${repository}/branches/${base}/protection`], root, null);
  const rules = safeJsonGh(["api", `repos/${repository}/rules/branches/${base}`], root, []);
  const requiredContexts = [...new Set([
    ...protectionContexts(protection),
    ...rulesetContexts(rules),
  ])];

  return evaluatePrCheckEvidence({
    pr,
    isPrivate: repositoryInfo.isPrivate,
    requiredContexts,
    checkName,
    riskLevel: item.risk_level,
  });
}

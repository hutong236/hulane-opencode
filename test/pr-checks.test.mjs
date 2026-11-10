import test from "node:test";
import assert from "node:assert/strict";
import { evaluatePrCheckEvidence, assertDefaultBranchTarget } from "../hulane/scripts/lib/pr-checks.mjs";

const sha = "a".repeat(40);
const check = {
  __typename: "CheckRun",
  name: "verify",
  workflowName: "Hulane PR Checks",
  status: "COMPLETED",
  conclusion: "SUCCESS",
  detailsUrl: "https://github.com/acme/demo/actions/runs/123/job/456",
};
const pr = {
  number: 42,
  state: "OPEN",
  isDraft: false,
  headRefOid: sha,
  statusCheckRollup: [check],
};

test("GitHub-required checks select the server-enforced merge guard", () => {
  const result = evaluatePrCheckEvidence({
    pr,
    isPrivate: false,
    requiredContexts: ["verify"],
  });
  assert.equal(result.patch.merge_guard_mode, "github_required_checks");
  assert.equal(result.patch.required_checks_enforced, true);
  assert.equal(result.patch.pr_head_sha, sha);
});

test("private repositories may use the exact-SHA control-plane guard", () => {
  const result = evaluatePrCheckEvidence({
    pr,
    isPrivate: true,
    requiredContexts: [],
    riskLevel: "low",
  });
  assert.equal(result.patch.merge_guard_mode, "control_plane_verified");
  assert.equal(result.patch.required_checks_enforced, false);
  assert.equal(result.human_merge_required, false);
});

test("human merge requirement follows the risk tier, not the guard mode", () => {
  const high = evaluatePrCheckEvidence({
    pr,
    isPrivate: true,
    requiredContexts: [],
    riskLevel: "high",
  });
  assert.equal(high.human_merge_required, true);
  // 未提供风险等级时按高风险兜底(fail-safe)
  const defaulted = evaluatePrCheckEvidence({ pr, isPrivate: true, requiredContexts: [] });
  assert.equal(defaulted.human_merge_required, true);
});

test("public repositories without free branch enforcement remain blocked", () => {
  assert.throws(() => evaluatePrCheckEvidence({
    pr,
    isPrivate: false,
    requiredContexts: [],
  }), /Public repositories must enforce/);
});

test("non-successful workflow results never satisfy either merge guard", () => {
  assert.throws(() => evaluatePrCheckEvidence({
    pr: { ...pr, statusCheckRollup: [{ ...check, conclusion: "FAILURE" }] },
    isPrivate: true,
    requiredContexts: [],
  }), /has not succeeded/);
});

test("control-plane mode requires every reported check to succeed", () => {
  assert.throws(() => evaluatePrCheckEvidence({
    pr: {
      ...pr,
      statusCheckRollup: [check, {
        __typename: "CheckRun",
        name: "lint",
        workflowName: "Additional Checks",
        status: "IN_PROGRESS",
        conclusion: "",
        detailsUrl: "https://github.com/acme/demo/actions/runs/789",
      }],
    },
    isPrivate: true,
    requiredContexts: [],
  }), /every reported PR check/);
});

test("duplicate pending or failing check with the same name blocks Gate B", () => {
  assert.throws(() => evaluatePrCheckEvidence({
    pr: { ...pr, statusCheckRollup: [check, { ...check, status: "IN_PROGRESS", conclusion: null }] },
    isPrivate: false,
    requiredContexts: ["verify"],
  }), /every matching run/);
});

test("Gate B requires every server-protected check to pass, not just the Hulane check", () => {
  assert.throws(() => evaluatePrCheckEvidence({
    pr,
    isPrivate: false,
    requiredContexts: ["verify", "security-scan"],
  }), /Required GitHub check is missing or unsuccessful: security-scan/);
  assert.throws(() => evaluatePrCheckEvidence({
    pr: { ...pr, statusCheckRollup: [check, { __typename: "StatusContext", context: "security-scan", state: "PENDING" }] },
    isPrivate: false,
    requiredContexts: ["verify", "security-scan"],
  }), /Required GitHub check is missing or unsuccessful: security-scan/);
});

test("production PR verification cannot target an unrelated base branch", () => {
  assert.doesNotThrow(() => assertDefaultBranchTarget("main", "main"));
  assert.throws(() => assertDefaultBranchTarget("sandbox", "main"), /must target the repository default branch/);
  assert.throws(() => assertDefaultBranchTarget("main", null), /must target the repository default branch/);
});

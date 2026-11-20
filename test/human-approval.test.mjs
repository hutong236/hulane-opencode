import test from "node:test";
import assert from "node:assert/strict";
import { createWorkItem } from "../hulane/scripts/lib/state-machine.mjs";
import { checkHumanApproval, verifyHumanApproval } from "../hulane/scripts/lib/human-approval.mjs";

function approvedItem(status = "waiting_approval") {
  return {
    ...createWorkItem({ id: "REQ-12", issue_number: 12, title: "Protected", risk_level: "high", delivery_required: true }),
    status, revision: 7, updated_at: "2026-11-10T12:00:00Z", pr_head_sha: "a".repeat(40),
  };
}
function comment(body, login = "repo-owner", created_at = "2026-11-10T12:00:01Z") {
  return { user: { login }, body, created_at };
}

test("Gate A approval must be an exact current-revision GitHub comment by a write-capable user", () => {
  const item = approvedItem();
  const body = "HULANE_APPROVAL approve_requirement REQ-12 revision=7";
  assert.equal(checkHumanApproval({
    item, event: "approve_requirement", actor: "human:repo-owner", comments: [comment(body)], permission: "write",
  }).verified, true);
  assert.throws(() => checkHumanApproval({
    item, event: "approve_requirement", actor: "human:impostor", comments: [comment(body)], permission: "write",
  }), /No current-revision/);
  assert.throws(() => checkHumanApproval({
    item, event: "approve_requirement", actor: "human:repo-owner", comments: [comment(body)], permission: "read",
  }), /lacks write/);
  assert.throws(() => checkHumanApproval({
    item, event: "approve_requirement", actor: "human:repo-owner", comments: [comment("HULANE_APPROVAL approve_requirement REQ-12 revision=6")], permission: "admin",
  }), /No current-revision/);
  assert.throws(() => checkHumanApproval({
    item, event: "approve_requirement", actor: "human:repo-owner", comments: [comment(body, "repo-owner", "2026-11-10T11:00:00Z")], permission: "write",
  }), /No current-revision/);
});

test("Gate B and C bind approved PR head and release tag, not free-form actor text", () => {
  const item = approvedItem("waiting_human_merge");
  const mergeBody = `HULANE_APPROVAL approve_merge REQ-12 revision=7 head=${"a".repeat(40)}`;
  assert.equal(checkHumanApproval({ item, event: "approve_merge", actor: "human:repo-owner", permission: "maintain", comments: [comment(mergeBody)] }).verified, true);
  assert.throws(() => checkHumanApproval({ item, event: "approve_merge", actor: "human:repo-owner", permission: "maintain", comments: [comment(mergeBody.replace("a".repeat(40), "b".repeat(40)))] }), /No current-revision/);
  const tag = approvedItem("waiting_tag_confirm");
  assert.equal(checkHumanApproval({ item: tag, event: "approve_tag", actor: "human:repo-owner", permission: "admin", patch: { image_tag: "v1.2.3" }, comments: [comment("HULANE_APPROVAL approve_tag REQ-12 revision=7 tag=v1.2.3")] }).verified, true);
  assert.throws(() => checkHumanApproval({ item: tag, event: "approve_tag", actor: "human:repo-owner", permission: "admin", patch: { image_tag: "v1.2.4" }, comments: [comment("HULANE_APPROVAL approve_tag REQ-12 revision=7 tag=v1.2.3")] }), /No current-revision/);
});

test("human approval verifier uses real Issue comments and collaborator permission endpoints", () => {
  const item = approvedItem();
  const requests = [];
  const run = (args) => {
    requests.push(args);
    if (args[1] === "--paginate") return JSON.stringify([[comment("HULANE_APPROVAL approve_requirement REQ-12 revision=7")]]);
    if (args[1].includes("/collaborators/")) return "write";
    throw new Error("unexpected call");
  };
  const result = verifyHumanApproval({ root: "/tmp", repository: "acme/demo", item, event: "approve_requirement", actor: "human:repo-owner", run });
  assert.equal(result.verified, true);
  assert.equal(requests.length, 2);
  assert.throws(() => verifyHumanApproval({ root: "/tmp", repository: "acme/demo", item: { ...item, issue_pending: true }, event: "approve_requirement", actor: "human:repo-owner", run }), /run hulane_flush/);
});

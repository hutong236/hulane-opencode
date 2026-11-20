import { runGh } from "./github-state.mjs";

const AUTH_EVENTS = new Set(["approve_requirement", "approve_merge", "approve_tag", "approve_skip"]);
const PRIVILEGED_ROLES = new Set(["admin", "maintain", "write"]);

function expectedApproval(item, event, patch) {
  let proof = `HULANE_APPROVAL ${event} ${item.id} revision=${item.revision}`;
  if (event === "approve_merge") {
    if (!/^[0-9a-f]{40}$/i.test(String(item.pr_head_sha ?? ""))) {
      throw new Error("Gate B requires a valid recorded PR head SHA");
    }
    proof += ` head=${item.pr_head_sha}`;
  }
  if (event === "approve_tag") {
    if (!/^v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-[0-9A-Za-z.-]+)?$/.test(String(patch?.image_tag ?? ""))) {
      throw new Error("Gate C requires a valid approved tag");
    }
    proof += ` tag=${patch.image_tag}`;
  }
  return proof;
}

export function checkHumanApproval({ item, event, actor, patch, comments, permission }) {
  if (!AUTH_EVENTS.has(event)) throw new Error("Unsupported human approval event");
  const match = String(actor ?? "").match(/^human:([A-Za-z0-9-]+)$/);
  if (!match) throw new Error("Human approval actor must be a real GitHub login in human:<login> form");
  if (!PRIVILEGED_ROLES.has(permission)) throw new Error("GitHub approval author lacks write/maintain/admin repository permission");
  if (item.issue_pending || !Number.isInteger(item.issue_number) || item.issue_number < 1) {
    throw new Error("GitHub Issue is required for auditable human approval");
  }
  const expected = expectedApproval(item, event, patch);
  const approved = (Array.isArray(comments) ? comments : []).some(comment =>
    String(comment.user?.login ?? "").toLowerCase() === match[1].toLowerCase() &&
    String(comment.body ?? "").trim() === expected &&
    Number.isFinite(Date.parse(comment.created_at)) &&
    Date.parse(comment.created_at) >= Math.floor(Date.parse(item.updated_at) / 1000) * 1000
  );
  if (!approved) throw new Error("No current-revision GitHub human approval comment found: " + expected);
  return { verified: true, event, actor: match[1], issue_number: item.issue_number, proof: expected };
}

export function verifyHumanApproval({ root, repository, item, event, actor, patch, run = runGh }) {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(String(repository ?? ""))) {
    throw new Error("Human approval requires a verified owner/repository binding");
  }
  if (!item.issue_number || item.issue_pending) {
    throw new Error("Human approval requires a flushed GitHub Issue; run hulane_flush first");
  }
  const match = String(actor ?? "").match(/^human:([A-Za-z0-9-]+)$/);
  if (!match) throw new Error("Human approval actor must be a real GitHub login");
  const raw = run(["api", "--paginate", "--slurp",
    `repos/${repository}/issues/${item.issue_number}/comments?per_page=100`], { cwd: root });
  const pages = JSON.parse(raw || "[]");
  const comments = Array.isArray(pages[0]) ? pages.flat() : pages;
  const role = run(["api", `repos/${repository}/collaborators/${match[1]}/permission`, "--jq", ".permission"], { cwd: root });
  return checkHumanApproval({ item, event, actor, patch, comments, permission: String(role).trim() });
}

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createWorkItem } from "../hulane/scripts/lib/state-machine.mjs";
import { writeProjection } from "../hulane/scripts/lib/projection.mjs";

test("projection refresh updates frontmatter without replacing the note body", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "hulane-projection-"));
  const item = createWorkItem({
    id: "REQ-55",
    issue_number: 55,
    title: "Projection",
    risk_level: "low",
    delivery_required: false,
    delivery_reason: "Documentation only",
    skip_allowed: true,
  });
  const file = writeProjection(root, item, { plannerSummary: "Original summary", acceptanceCriteria: ["Visible"] });
  fs.appendFileSync(file, "\nHuman-maintained note.\n");
  writeProjection(root, { ...item, status: "ready", revision: 2 });
  const content = fs.readFileSync(file, "utf8");
  assert.match(content, /status: "ready"/);
  assert.match(content, /Human-maintained note\./);
  assert.match(content, /Original summary/);
  assert.match(content, /## 规格关联/);
});

test("projection exposes spec-sync fields and refreshes them with state", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "hulane-projection-specs-"));
  const item = createWorkItem({
    id: "REQ-56",
    issue_number: 56,
    title: "Spec projection",
    risk_level: "low",
    delivery_required: false,
    delivery_reason: "Documentation only",
    skip_allowed: true,
  });
  const file = writeProjection(root, item);
  const initial = fs.readFileSync(file, "utf8");
  assert.match(initial, /spec_sync_required: true/);
  assert.match(initial, /specs_synced: false/);
  assert.match(initial, /specs_commit_sha: null/);
  assert.match(initial, /spec_delta_dir: null/);
  assert.match(initial, /## 规格关联/);
  assert.match(initial, /- capability：/);
  assert.match(initial, /- delta：/);
  assert.match(initial, /- specs_commit_sha：/);
  assert.match(initial, /- sync 状态：/);

  writeProjection(root, {
    ...item,
    revision: 2,
    specs_synced: true,
    specs_commit_sha: "a".repeat(40),
    spec_delta_dir: "openspec/changes/archive/REQ-56",
  });
  const synced = fs.readFileSync(file, "utf8");
  assert.match(synced, /specs_synced: true/);
  assert.match(synced, /specs_commit_sha: "a{40}"/);
  assert.match(synced, /spec_delta_dir: "openspec\/changes\/archive\/REQ-56"/);
});

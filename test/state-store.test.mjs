import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createLocalWorkItem, initializeRepositoryState, readStore, writeStore, putItem } from "../hulane/scripts/lib/state-store.mjs";
import { createWorkItem } from "../hulane/scripts/lib/state-machine.mjs";

test("state store binds once to a GitHub repository", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "hulane-store-"));
  execFileSync("git", ["init", "-q"], { cwd: root });
  initializeRepositoryState(root);
  const bound = initializeRepositoryState(root, "acme/demo");
  assert.equal(bound.repository, "acme/demo");
  assert.throws(() => initializeRepositoryState(root, "other/repo"), /belongs to acme\/demo/);
});

test("state write CAS rejects stale store snapshots", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "hulane-store-cas-"));
  try {
    execFileSync("git", ["init", "-q"], { cwd: root });
    initializeRepositoryState(root, "acme/demo");
    const stale = readStore(root);
    writeStore(root, readStore(root));
    assert.throws(() => writeStore(root, stale), /Stale state write/);
    assert.equal(readStore(root).repository, "acme/demo");
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("Work Item same-revision collisions fail closed; GitHub hydration is explicit", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "hulane-store-collision-"));
  try {
    execFileSync("git", ["init", "-q"], { cwd: root });
    initializeRepositoryState(root, "acme/demo");
    const item = createWorkItem({ id: "REQ-12", issue_number: 12, title: "First", risk_level: "low", delivery_required: true });
    putItem(root, item);
    const revision = readStore(root).revision;
    putItem(root, item);
    assert.equal(readStore(root).revision, revision);
    assert.throws(() => putItem(root, { ...item, title: "stale update" }), /Conflicting Work Item revision/);
    assert.equal(readStore(root).items["REQ-12"].title, "First");
    putItem(root, { ...item, title: "Live GitHub truth" }, { source: "github" });
    assert.equal(readStore(root).items["REQ-12"].title, "Live GitHub truth");
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("existing state write lock is never stolen by another writer", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "hulane-store-locked-"));
  try {
    execFileSync("git", ["init", "-q"], { cwd: root });
    initializeRepositoryState(root);
    const revision = readStore(root).revision;
    const lock = path.join(root, ".hulane", "state-write.lock");
    fs.writeFileSync(lock, '{"pid":12345}\n', { flag: "wx" });
    assert.throws(() => writeStore(root, readStore(root)), /State write locked/);
    assert.equal(readStore(root).revision, revision);
    assert.equal(fs.existsSync(lock), true);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("atomic local Work Item allocation increments across REQ and BUG", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "hulane-atomic-number-"));
  try {
    execFileSync("git", ["init", "-q"], { cwd: root });
    initializeRepositoryState(root, "acme/demo");
    const input = { title: "Offline work", risk_level: "low", delivery_required: true };
    const one = createLocalWorkItem(root, { ...input, type: "feature" }, "acme/demo");
    const two = createLocalWorkItem(root, { ...input, type: "bug" }, "acme/demo");
    assert.equal(one.id, "REQ-1");
    assert.equal(two.id, "BUG-2");
    assert.equal(Object.keys(readStore(root).items).length, 2);
    assert.equal(readStore(root).items["BUG-2"].issue_pending, true);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

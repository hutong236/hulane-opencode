import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { initializeRepositoryState, readStore } from "../hulane/scripts/lib/state-store.mjs";
import { recoverStateWriteLock } from "../hulane/scripts/lib/state-lock-recovery.mjs";

function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "hulane-recovery-"));
  execFileSync("git", ["init", "-q"], { cwd: root });
  initializeRepositoryState(root);
  return { root, lock: path.join(root, ".hulane", "state-write.lock") };
}
const oldTime = "2020-01-01T00:00:00.000Z";
function put(lock, record) { fs.writeFileSync(lock, JSON.stringify({ pid: 9999999, host: os.hostname(), started_at: oldTime, ...record }) + "\n"); }

test("recovery dry-run is read-only; apply removes only verified dead old lock", () => {
  const { root, lock } = setup();
  try {
    put(lock, {});
    const rev = readStore(root).revision;
    assert.equal(recoverStateWriteLock(root).removed, false);
    assert.equal(fs.existsSync(lock), true);
    assert.equal(recoverStateWriteLock(root, { apply: true }).removed, true);
    assert.equal(fs.existsSync(lock), false);
    assert.equal(readStore(root).revision, rev);
    assert.equal(recoverStateWriteLock(root, { apply: true }).removed, false);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("lock recovery rejects live PID, foreign host, missing metadata, and recent locks", () => {
  const { root, lock } = setup();
  try {
    put(lock, { pid: process.pid });
    assert.throws(() => recoverStateWriteLock(root, { apply: true }), /still active/);
    put(lock, { host: "another-host.invalid" });
    assert.throws(() => recoverStateWriteLock(root, { apply: true }), /another host/);
    put(lock, { host: undefined, pid: 9999999 });
    assert.throws(() => recoverStateWriteLock(root, { apply: true }), /another host|lacks valid/);
    put(lock, { started_at: new Date().toISOString() });
    assert.throws(() => recoverStateWriteLock(root, { apply: true }), /too recent/);
    assert.equal(fs.existsSync(lock), true);
    assert.equal(fs.existsSync(path.join(root, ".hulane", "state-write.recovery.lock")), false);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("recovery refuses another active recovery lock", () => {
  const { root, lock } = setup();
  try {
    put(lock, {});
    const sentinel = path.join(root, ".hulane", "state-write.recovery.lock");
    fs.writeFileSync(sentinel, "occupied");
    assert.throws(() => recoverStateWriteLock(root, { apply: true }), /already active/);
    assert.equal(fs.existsSync(lock), true);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

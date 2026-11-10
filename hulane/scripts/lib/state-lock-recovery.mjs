import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveControlDir } from "./state-store.mjs";

// Manual, fail-closed recovery for orphaned state-write.lock files.
// Never infer that an old lock is stale from mtime alone.
function inspect(root, minAgeSeconds, now) {
  if (!Number.isInteger(minAgeSeconds) || minAgeSeconds < 30) throw new Error("Minimum lock age must be at least 30 seconds");
  const lockPath = path.join(resolveControlDir(root), "state-write.lock");
  if (!fs.existsSync(lockPath)) return { found: false, recoverable: false, lockPath };
  const stat = fs.lstatSync(lockPath);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("State lock is not a regular file");
  const raw = fs.readFileSync(lockPath, "utf8");
  let record;
  try { record = JSON.parse(raw); } catch { throw new Error("Malformed state lock: manual investigation required"); }
  if (!Number.isSafeInteger(record.pid) || record.pid < 1 ||
      typeof record.host !== "string" || !record.host ||
      !Number.isFinite(Date.parse(record.started_at))) {
    throw new Error("State lock lacks valid pid, host or timestamp; manual investigation required");
  }
  if (record.host !== os.hostname()) throw new Error("State lock belongs to another host; refusing cross-host removal");
  const ageSeconds = (now() - Date.parse(record.started_at)) / 1000;
  if (!Number.isFinite(ageSeconds) || ageSeconds < minAgeSeconds) {
    throw new Error("State lock is too recent for safe recovery");
  }
  try {
    process.kill(record.pid, 0);
  } catch (error) {
    if (error.code !== "ESRCH") throw new Error("State lock PID cannot be verified dead: " + error.code);
    return { found: true, recoverable: true, lockPath, pid: record.pid, host: record.host, ageSeconds, raw, stat };
  }
  throw new Error("State lock owner PID is still active; refusing removal");
}

export function recoverStateWriteLock(root, { apply = false, minAgeSeconds = 30, now = Date.now } = {}) {
  if (!apply) {
    const data = inspect(root, minAgeSeconds, now);
    return { found: data.found, recoverable: data.recoverable, removed: false, pid: data.pid ?? null, age_seconds: data.ageSeconds ?? null };
  }
  const recoveryFile = path.join(resolveControlDir(root), "state-write.recovery.lock");
  let fd;
  try { fd = fs.openSync(recoveryFile, "wx", 0o600); }
  catch (error) {
    if (error.code === "EEXIST") throw new Error("Another lock recovery is already active; refusing concurrent recovery");
    throw error;
  }
  try {
    const data = inspect(root, minAgeSeconds, now);
    if (!data.found) return { found: false, removed: false };
    const current = fs.lstatSync(data.lockPath);
    if (data.stat.ino !== current.ino || data.stat.dev !== current.dev ||
        data.stat.size !== current.size || fs.readFileSync(data.lockPath, "utf8") !== data.raw) {
      throw new Error("State lock changed during recovery: refusing removal");
    }
    fs.unlinkSync(data.lockPath);
    return { found: true, removed: true, pid: data.pid, age_seconds: data.ageSeconds };
  } finally {
    try { fs.closeSync(fd); }
    finally { fs.rmSync(recoveryFile, { force: true }); }
  }
}

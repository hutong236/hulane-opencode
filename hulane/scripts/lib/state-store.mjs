import fs from "node:fs";
import { hostname } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { normalizeWorkItem, validateWorkItem } from "./state-machine.mjs";

export const CONTROL_DIR = ".hulane";
// V3.0.0 更名前的控制目录:已初始化的存量仓库继续在旧目录下运行(guard、授权、
// worktree 全部照旧),只有新仓库 init 才落 .hulane,避免在途工单状态分裂
export const LEGACY_CONTROL_DIR = ".cmdb-dev";

// 控制根解析:.hulane 优先;只有旧 .cmdb-dev/state.json 时整体回退旧目录
export function resolveControlDir(root) {
  if (fs.existsSync(path.join(root, CONTROL_DIR, "state.json"))) return path.join(root, CONTROL_DIR);
  if (fs.existsSync(path.join(root, LEGACY_CONTROL_DIR, "state.json"))) return path.join(root, LEGACY_CONTROL_DIR);
  return path.join(root, CONTROL_DIR);
}

export const STORE_RELATIVE_PATH = ".hulane/state.json";

const STORE_WRITE_LOCK = "state-write.lock";

function withStateWriteLock(root, operation) {
  const directory = resolveControlDir(root);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const lock = path.join(directory, STORE_WRITE_LOCK);
  let fd;
  try { fd = fs.openSync(lock, "wx", 0o600); }
  catch (error) {
    if (error.code === "EEXIST") throw new Error("State write locked: another process or an unrecovered crash owns the state store");
    throw error;
  }
  try {
    fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, host: hostname(), started_at: new Date().toISOString() }) + "\n");
    return operation();
  } finally {
    try { fs.closeSync(fd); }
    finally { fs.rmSync(lock, { force: true }); }
  }
}


export function findRepositoryRoot(cwd = process.cwd()) {
  const result = spawnSync("git", ["rev-parse", "--show-toplevel"], { cwd, encoding: "utf8" });
  if (result.status !== 0) throw new Error("Current directory is not inside a Git repository");
  return result.stdout.trim();
}

export function findControlRoot(cwd = process.cwd()) {
  const result = spawnSync("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], { cwd, encoding: "utf8" });
  if (result.status !== 0) throw new Error("Current directory is not inside a Git repository");
  const commonDirectory = result.stdout.trim();
  if (path.basename(commonDirectory) !== ".git") {
    throw new Error("Bare repositories are not supported");
  }
  return path.dirname(commonDirectory);
}

export function emptyStore(repository = null) {
  return {
    schema_version: 2,
    repository,
    revision: 0,
    updated_at: new Date(0).toISOString(),
    items: {},
  };
}

export function storePath(root) {
  return path.join(resolveControlDir(root), "state.json");
}

export function readStore(root, { allowMissing = true } = {}) {
  const file = storePath(root);
  if (!fs.existsSync(file)) {
    if (!allowMissing) throw new Error(`${STORE_RELATIVE_PATH} does not exist; run init first`);
    return emptyStore();
  }
  const store = JSON.parse(fs.readFileSync(file, "utf8"));
  if (store.schema_version !== 2 || typeof store.items !== "object") throw new Error("Unsupported state store schema");
  for (const [id, item] of Object.entries(store.items)) {
    store.items[id] = normalizeWorkItem(item);
    validateWorkItem(store.items[id]);
  }
  return store;
}

function writeStoreUnlocked(root, store) {
  const directory = path.dirname(storePath(root));
  fs.mkdirSync(directory, { recursive: true });
  for (const item of Object.values(store.items)) validateWorkItem(item);
  const next = structuredClone(store);
  next.schema_version = 2;
  next.revision = Number(next.revision ?? 0) + 1;
  next.updated_at = new Date().toISOString();
  const temporary = path.join(directory, `.state-${randomUUID()}.tmp`);
  fs.writeFileSync(temporary, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temporary, storePath(root));
  return next;
}


export function writeStore(root, store) {
  return withStateWriteLock(root, () => {
    const filename = storePath(root);
    const latestRevision = fs.existsSync(filename)
      ? Number(JSON.parse(fs.readFileSync(filename, "utf8")).revision)
      : 0;
    if (Number(store.revision ?? 0) !== latestRevision) {
      throw new Error(`Stale state write: expected revision ${store.revision ?? 0}, found ${latestRevision}`);
    }
    return writeStoreUnlocked(root, store);
  });
}

export function initializeRepositoryState(root, repository = null) {
  const existing = readStore(root);
  if (!fs.existsSync(storePath(root))) {
    writeStore(root, { ...existing, repository });
  } else if (repository && !existing.repository) {
    writeStore(root, { ...existing, repository });
  } else if (repository && existing.repository !== repository) {
    throw new Error(`State store belongs to ${existing.repository}, not ${repository}`);
  }
  const controlDirRelative = path.relative(root, resolveControlDir(root));
  for (const relative of ["plan/00_Dashboard", "plan/01_Requirements", "plan/02_Bugs", path.join(controlDirRelative, "worktrees")]) {
    fs.mkdirSync(path.join(root, relative), { recursive: true });
  }
  updateInfoExclude(root);
  return readStore(root, { allowMissing: false });
}

export function updateInfoExclude(root) {
  const result = spawnSync("git", ["rev-parse", "--path-format=absolute", "--git-path", "info/exclude"], {
    cwd: root,
    encoding: "utf8",
  });
  if (result.status !== 0) return;
  const excludePath = result.stdout.trim();
  if (!fs.existsSync(path.dirname(excludePath))) return;
  const required = [
    "/plan/00_Dashboard/",
    "/plan/01_Requirements/",
    "/plan/02_Bugs/",
    `/${CONTROL_DIR}/`,
    // V3.0.0 前初始化的仓库写的是旧目录,这里一并保证,避免存量仓库漏排除
    `/${LEGACY_CONTROL_DIR}/`,
  ];
  const current = fs.existsSync(excludePath) ? fs.readFileSync(excludePath, "utf8") : "";
  const lines = new Set(current.split(/\r?\n/).filter(Boolean));
  let changed = false;
  for (const value of required) {
    if (!lines.has(value)) {
      lines.add(value);
      changed = true;
    }
  }
  if (changed) fs.writeFileSync(excludePath, `${[...lines].join("\n")}\n`);
}

export function putItem(root, item, { source = "local" } = {}) {
  if (!["local", "github"].includes(source)) throw new Error("Unsupported state update source");
  validateWorkItem(item);
  return withStateWriteLock(root, () => {
    const store = readStore(root);
    const existing = store.items[item.id];
    if (existing && source === "local") {
      if (item.revision < existing.revision) throw new Error("Refusing to overwrite newer local state");
      if (item.revision === existing.revision) {
        if (JSON.stringify(item) !== JSON.stringify(existing)) {
          throw new Error("Conflicting Work Item revision: stale concurrent update");
        }
        return store;
      }
    }
    // Explicit exception for remote GitHub Issue canonical state rehydration.
    store.items[item.id] = item;
    return writeStoreUnlocked(root, store);
  });
}

export function getItem(root, id) {
  const item = readStore(root, { allowMissing: false }).items[id];
  if (!item) throw new Error(`Unknown Work Item: ${id}`);
  return item;
}

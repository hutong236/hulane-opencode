import fs from "node:fs";
import path from "node:path";
import { initializeRepositoryState } from "./state-store.mjs";

function installIfMissing(source, target, mode, changed) {
  if (fs.existsSync(target)) return;
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.copyFileSync(source, target);
  if (mode) fs.chmodSync(target, mode);
  changed.push(target);
}

export function initializeTargetRepository(root, pluginRoot, repository = null) {
  const state = initializeRepositoryState(root, repository);
  const changed = [];
  const templateRoot = path.join(pluginRoot, "templates");

  for (const name of ["首页.md", "研发控制台.md", "研发看板.md", "需求列表.md"]) {
    installIfMissing(path.join(templateRoot, "obsidian", name), path.join(root, "plan", "00_Dashboard", name), 0o600, changed);
  }
  installIfMissing(path.join(templateRoot, "github-actions", "pr-checks.yml"), path.join(root, ".github", "workflows", "pr-checks.yml"), 0o644, changed);
  installIfMissing(path.join(templateRoot, "github-actions", "hulane-pr-checks.sh"), path.join(root, ".github", "scripts", "hulane-pr-checks.sh"), 0o755, changed);
  if (fs.existsSync(path.join(root, "Dockerfile"))) {
    installIfMissing(path.join(templateRoot, "github-actions", "build-image.yml"), path.join(root, ".github", "workflows", "build-image.yml"), 0o644, changed);
  }
  return { state, changed_files: changed.map((value) => path.relative(root, value)) };
}

// REQ-9 执行纪律守卫测试。含 --no-verify/密钥形状的字符串只出现在本文件
// 与 spawnSync 的 stdin 输入里,不进入任何 Bash 工具直接执行的命令行。
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createWorkItem } from "../hulane/scripts/lib/state-machine.mjs";
import { writeStore } from "../hulane/scripts/lib/state-store.mjs";
import {
  analyzeGitBypass,
  disabledChecks,
  evaluateDisciplineBash,
  evaluateDisciplineEdit,
  isProtectedConfigName,
  scanStagedContent,
} from "../hulane/scripts/lib/discipline.mjs";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const guardHook = path.join(repositoryRoot, "hulane", "hooks", "guard.mjs");
const disciplineHook = path.join(repositoryRoot, "hulane", "hooks", "discipline.mjs");

function plainRepository() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "hulane-discipline-"));
  execFileSync("git", ["init", "-q"], { cwd: root });
  for (const [key, value] of [["user.email", "test@example.com"], ["user.name", "Hulane Test"]]) {
    execFileSync("git", ["config", key, value], { cwd: root });
  }
  return root;
}

function managedRepository({ allowlist } = {}) {
  const root = plainRepository();
  const item = { ...createWorkItem({
    id: "REQ-66",
    issue_number: 66,
    title: "Discipline state",
    risk_level: "low",
    delivery_required: true,
  }), status: "doing" };
  writeStore(root, { schema_version: 2, repository: "acme/demo", revision: 0, updated_at: new Date().toISOString(), items: { [item.id]: item } });
  if (allowlist) {
    fs.mkdirSync(path.join(root, ".hulane"), { recursive: true });
    fs.writeFileSync(path.join(root, ".hulane", "guard-allowlist.json"), JSON.stringify(allowlist));
  }
  return root;
}

function stage(root, file, content) {
  fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
  fs.writeFileSync(path.join(root, file), content);
  execFileSync("git", ["add", file], { cwd: root });
}

function runHook(script, payload, { env } = {}) {
  return spawnSync(process.execPath, [script], {
    input: JSON.stringify(payload),
    encoding: "utf8",
    env: env ? { ...process.env, ...env } : process.env,
  });
}

function decision(result) {
  assert.equal(result.status, 0);
  return JSON.parse(result.stdout).hookSpecificOutput;
}

// ── 验收 1/2/5:--no-verify 形态、短旗标簇、多分段与消息体干扰 ────────────────

test("acceptance 1: protected subcommands with --no-verify are denied with a hook-bypass reason", () => {
  for (const command of ['git commit --no-verify -m "x"', "git merge --no-verify", "git push --no-veri"]) {
    const violation = analyzeGitBypass(command);
    assert.ok(violation, command);
    assert.equal(violation.check, "git-bypass");
    assert.match(violation.reason, /Git 钩子不可绕过/);
  }
  // 其余受保护子命令同拦
  for (const command of ["git cherry-pick --no-verify", "git rebase --no-verify", "git am --no-verify"]) {
    assert.ok(analyzeGitBypass(command), command);
  }
  // 引号包裹的旗标仍是旗标(shell 会剥引号传给 git)
  assert.ok(analyzeGitBypass('git commit "--no-verify"'));
});

test("acceptance 2: commit short-flag cluster analysis for -n", () => {
  assert.ok(analyzeGitBypass("git commit -an"), "-an is -a plus -n");
  assert.equal(analyzeGitBypass('git commit -mn "fix"'), null, "n in -mn is -m's message value");
  assert.equal(analyzeGitBypass("git log -n 5"), null, "log is not a protected subcommand");
  assert.equal(analyzeGitBypass("git commit -uno"), null, "-uno means untracked-files=no");
  assert.equal(analyzeGitBypass("git commit -Sn keyid"), null, "S swallows the rest of the cluster");
  assert.equal(analyzeGitBypass("git push -n origin main"), null, "push -n is dry-run, not hook bypass");
});

test("acceptance 5: multi-segment commands and -m message-body interference", () => {
  assert.ok(analyzeGitBypass("a && git commit --no-verify"));
  assert.ok(analyzeGitBypass('echo ok; git commit -m "feat: x" || git push --no-ver'));
  assert.equal(analyzeGitBypass('git commit -m "fix -n bug"'), null, "message body is not scanned as flags");
  assert.equal(analyzeGitBypass('git commit -m "mentions --no-verify in the message"'), null);
  assert.equal(analyzeGitBypass('git commit -m "text && git push --no-verify"'), null, "body stripped before segmentation");
  assert.equal(analyzeGitBypass('git tag -a v1.0.0 -m "bypass --no-verify" && git commit -m "ok"'), null);
});

// ── 验收 3/4:hook-redirect 配置键与环境注入 ─────────────────────────────────

test("acceptance 3: -c / --config-env overrides and git config persistent writes are denied", () => {
  for (const command of [
    "git -c core.hooksPath=/dev/null commit",
    "git -ccore.hooksPath=/dev/null commit",
    "git --config-env core.hooksPath=MYENV commit",
    "git --config-env=core.hooksPath=MYENV commit",
    "git -c include.path=/x merge",
    "git -c includeif.gitworktree.foo.path=/x push",
    "git -c core.HooksPath=/dev/null commit",
  ]) {
    const violation = analyzeGitBypass(command);
    assert.ok(violation, command);
    assert.equal(violation.check, "git-bypass");
    assert.match(violation.reason, /Git 钩子不可绕过/);
  }
  for (const command of [
    "git config core.hooksPath /dev/null",
    "git config --global include.path /x",
    "git config --local core.hooksPath /y",
    "git config --system includeif.gitworktree.foo.path /z",
    "git config core.HooksPath /dev/null",
  ]) {
    assert.ok(analyzeGitBypass(command), command);
  }
  // 非绕过的普通 git 命令放行
  for (const command of [
    "git config user.email x",
    "git config --list",
    "git config --get core.hooksPath",
    "git -c user.name=x commit",
    'git commit -m "feat: ok"',
    "git push origin main",
  ]) {
    assert.equal(analyzeGitBypass(command), null, command);
  }
});

test("acceptance 4: same-command-line GIT_CONFIG_* injection is denied, non-hook keys pass", () => {
  for (const command of [
    "GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=core.hooksPath GIT_CONFIG_VALUE_0=/x git commit",
    "env GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=core.hooksPath GIT_CONFIG_VALUE_0=/x git commit",
    "GIT_CONFIG_PARAMETERS='core.hooksPath=/x' git commit",
    'GIT_CONFIG_PARAMETERS="include.path=/x" git push',
  ]) {
    const violation = analyzeGitBypass(command);
    assert.ok(violation, command);
    assert.equal(violation.check, "git-bypass");
  }
  for (const command of [
    "GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=user.name GIT_CONFIG_VALUE_0=x git commit",
    "GIT_CONFIG_PARAMETERS='user.name=x' git commit",
    "GIT_CONFIG_VALUE_0=/x git commit",
  ]) {
    assert.equal(analyzeGitBypass(command), null, command);
  }
});

// ── 验收 6/7/8:配置保护清单、首创放行、fail-closed 与非保护面 ───────────────

test("acceptance 6/8: protected config names, case variants, wildcards and non-protected build configs", () => {
  for (const name of [
    ".eslintrc", ".eslintrc.js", ".eslintrc.yaml", "eslint.config.mts",
    ".prettierrc.cjs", "prettier.config.mjs", "biome.jsonc", ".biome.json",
    ".ruff.toml", "ruff.toml", ".shellcheckrc", ".stylelintrc.mjs", "stylelint.config.cts",
    ".markdownlint-cli2.jsonc", ".markdownlintrc", ".eslintignore", ".markdownlintignore",
  ]) {
    assert.equal(isProtectedConfigName(name), true, name);
  }
  // 大小写不敏感(大小写不敏感文件系统上写 .ESLINTRC.JS 落到同一 inode)
  assert.equal(isProtectedConfigName(".ESLINTRC.JS"), true);
  assert.equal(isProtectedConfigName("Eslint.Config.Js"), true);
  // 两条通配:<tool>.config.<qualifier>.<ext> 与 .<tool>rc.<qualifier>.<ext>(含 commitlint/oxlint)
  assert.equal(isProtectedConfigName("eslint.config.base.mjs"), true);
  assert.equal(isProtectedConfigName("prettier.config.shared.cjs"), true);
  assert.equal(isProtectedConfigName(".eslintrc.base.json"), true);
  assert.equal(isProtectedConfigName("commitlint.config.js"), true);
  assert.equal(isProtectedConfigName("oxlint.config.mjs"), true);
  // 构建/测试配置不在保护面
  for (const name of ["vite.config.ts", "vitest.config.ts", "jest.config.js", "playwright.config.ts", "tsconfig.json", "pyproject.toml", "README.md", "package.json"]) {
    assert.equal(isProtectedConfigName(name), false, name);
  }
});

test("acceptance 6/7: existing protected configs deny, first-time creation allows, lstat errors fail closed", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "hulane-discipline-edit-"));
  const existing = path.join(root, ".eslintrc.js");
  fs.writeFileSync(existing, "module.exports = {};\n");
  assert.equal(evaluateDisciplineEdit({ filePath: existing }).allowed, false);
  assert.match(evaluateDisciplineEdit({ filePath: existing }).reason, /应修代码而非弱化检查配置/);
  // 大小写变体 basename(独立新文件名,避免大小写不敏感文件系统冲突)
  const caseVariant = path.join(root, "sub-upper", ".ESLINTRC.JS");
  fs.mkdirSync(path.dirname(caseVariant), { recursive: true });
  fs.writeFileSync(caseVariant, "module.exports = {};\n");
  assert.equal(evaluateDisciplineEdit({ filePath: caseVariant }).allowed, false);
  // 通配变体且已存在
  const wildcard = path.join(root, "eslint.config.base.mjs");
  fs.writeFileSync(wildcard, "export default {};\n");
  assert.equal(evaluateDisciplineEdit({ filePath: wildcard }).allowed, false);

  // 首创放行
  assert.equal(evaluateDisciplineEdit({ filePath: path.join(root, "nested", "eslint.config.mjs") }).allowed, true);
  // 非保护名且已存在:放行
  const buildConfig = path.join(root, "vite.config.ts");
  for (const name of ["vite.config.ts", "jest.config.js", "tsconfig.json", "pyproject.toml"]) {
    fs.writeFileSync(path.join(root, name), "content\n");
    assert.equal(evaluateDisciplineEdit({ filePath: path.join(root, name) }).allowed, true, name);
  }
  assert.equal(evaluateDisciplineEdit({ filePath: buildConfig }).allowed, true);
  // 缺 file_path:无检查对象,放行
  assert.equal(evaluateDisciplineEdit({}).allowed, true);

  // lstat EACCES → fail-closed deny(父目录去掉 x 位,lstat 不可达)
  const locked = path.join(root, "locked");
  fs.mkdirSync(locked);
  fs.writeFileSync(path.join(locked, ".eslintrc.js"), "module.exports = {};\n");
  fs.chmodSync(locked, 0o000);
  try {
    const result = evaluateDisciplineEdit({ filePath: path.join(locked, ".eslintrc.js") });
    assert.equal(result.allowed, false);
  } finally {
    fs.chmodSync(locked, 0o755);
  }
});

// ── 验收 9/10/11:提交内容卫生 ────────────────────────────────────────────────

test("acceptance 9: staged secret shapes deny with file and line in the reason", () => {
  const root = plainRepository();
  stage(root, "src/token.ts", 'const anthropicKey = "sk-ant-ABCDEFGHIJKLMNOPQRSTUVWXYZ12";\n');
  let violations = scanStagedContent(root, 'git commit -m "feat: keys"');
  assert.ok(Array.isArray(violations) && violations.length > 0);
  assert.match(violations[0].reason, /src\/token\.ts:1/);
  assert.match(violations[0].reason, /密钥/);

  stage(root, "src/aws.ts", "const aws = 'AKIAIOSFODNN7EXAMPLE';\n");
  violations = scanStagedContent(root, "git commit");
  assert.ok(violations.some((entry) => entry.reason.includes("src/aws.ts:1")));

  stage(root, "src/generic.ts", 'config.apiKey = "real9secret";\nconfig.api_key = "another8secret8value";\n');
  violations = scanStagedContent(root, "git commit");
  assert.ok(violations.some((entry) => entry.reason.includes("src/generic.ts:1")));
  assert.ok(violations.some((entry) => entry.reason.includes("src/generic.ts:2")));

  // 整链路:Bash 编排层同样 deny
  const verdict = evaluateDisciplineBash({ cwd: root, command: 'git commit -m "feat: keys"' });
  assert.equal(verdict.allowed, false);
  assert.match(verdict.reason, /src\/token\.ts:1/);
});

test("acceptance 10: obvious placeholder secrets are exempted", () => {
  const root = plainRepository();
  stage(root, "src/placeholders.ts", [
    'apiKey: "REPLACE_ME",',
    "api_key: process.env.API_KEY,",
    'apiKey: "<KEY>",',
    'apiKey: "${KEY}",',
    'apiKey: "",',
    'apiKey: "YOUR_API_KEY",',
    "apiKey: 'TODO',",
  ].join("\n") + "\n");
  assert.deepEqual(scanStagedContent(root, "git commit"), []);
  assert.equal(evaluateDisciplineBash({ cwd: root, command: 'git commit -m "feat: placeholders"' }).allowed, true);
});

test("acceptance 11: debugger and console.log deny, comments pass, amend and non-checkable pass", () => {
  const root = plainRepository();
  stage(root, "src/main.py", "def run():\n    debugger\n");
  let violations = scanStagedContent(root, 'git commit -m "wip"');
  assert.ok(violations.some((entry) => entry.reason.includes("src/main.py:2") && entry.reason.includes("debugger")));

  stage(root, "src/app.ts", 'console.log("debug");\n');
  violations = scanStagedContent(root, "git commit");
  assert.ok(violations.some((entry) => entry.reason.includes("src/app.ts:1") && entry.reason.includes("console.log")));

  // 注释行不误报
  const clean = plainRepository();
  stage(clean, "src/clean.ts", [
    "// console.log('commented out')",
    " * console.log('inside a jsdoc block')",
    "# console.log('hash style')",
    "// debugger was here in a comment",
    "const value = config.apiKey || process.env.API_KEY;",
  ].join("\n") + "\n");
  stage(clean, "src/clean.py", "# debugger mentioned in a comment only\n");
  assert.deepEqual(scanStagedContent(clean, "git commit"), []);

  // --amend 不触发;空暂存/仅 .md 放行;git 失败返回 null
  assert.equal(scanStagedContent(clean, "git commit --amend --no-edit"), null);
  assert.equal(evaluateDisciplineBash({ cwd: clean, command: "git commit --amend --no-edit" }).allowed, true);
  const empty = plainRepository();
  assert.deepEqual(scanStagedContent(empty, 'git commit -m "empty"'), []);
  stage(empty, "README.md", "# docs only\n");
  assert.deepEqual(scanStagedContent(empty, "git commit"), []);
  assert.equal(evaluateDisciplineBash({ cwd: empty, command: 'git commit -m "docs"' }).allowed, true);
  const notGit = fs.mkdtempSync(path.join(os.tmpdir(), "hulane-discipline-nogit-"));
  assert.equal(scanStagedContent(notGit, "git commit"), null);
  assert.equal(scanStagedContent(root, "npm run build"), null, "non-commit commands never trigger the scan");
});

// ── 验收 12/13:全局生效与逃生口 ──────────────────────────────────────────────

test("acceptance 12: git-bypass discipline applies globally, including non-hulane repositories", () => {
  const root = plainRepository(); // 无 .hulane 控制根:非 hulane 管理仓
  const output = decision(runHook(guardHook, {
    hook_event_name: "PreToolUse",
    cwd: root,
    tool_input: { command: 'git commit --no-verify -m "x"' },
  }));
  assert.equal(output.permissionDecision, "deny");
  assert.match(output.permissionDecisionReason, /Git 钩子不可绕过/);
  const notGit = fs.mkdtempSync(path.join(os.tmpdir(), "hulane-discipline-anywhere-"));
  assert.equal(evaluateDisciplineBash({ cwd: notGit, command: "git merge --no-verify" }).allowed, false);
});

test("acceptance 13: HULANE_DISCIPLINE_DISABLE only honors the hook process environment", () => {
  // 进程环境逃生口(库层)
  delete process.env.HULANE_DISCIPLINE_DISABLE;
  const root = plainRepository();
  stage(root, "src/noisy.ts", 'console.log("noise");\n');
  assert.equal(evaluateDisciplineBash({ cwd: root, command: 'git commit -m "wip"' }).allowed, false);
  try {
    process.env.HULANE_DISCIPLINE_DISABLE = "commit-quality";
    assert.ok(disabledChecks().has("commit-quality"));
    assert.equal(evaluateDisciplineBash({ cwd: root, command: 'git commit -m "wip"' }).allowed, true);
    // 逃生口只放行对应检查:git-bypass 仍拦
    assert.equal(evaluateDisciplineBash({ cwd: root, command: 'git commit --no-verify -m "x"' }).allowed, false);
    process.env.HULANE_DISCIPLINE_DISABLE = "git-bypass";
    // merge 不是 commit:commit-quality 不触发,单独验证 git-bypass 逃生口
    assert.equal(evaluateDisciplineBash({ cwd: root, command: "git merge --no-verify" }).allowed, true);
    // 只禁 git-bypass 时,commit-quality 仍拦暂存里的 console.log
    assert.equal(evaluateDisciplineBash({ cwd: root, command: 'git commit -m "wip"' }).allowed, false);
    process.env.HULANE_DISCIPLINE_DISABLE = "bogus,commit-quality";
    assert.deepEqual([...disabledChecks()], ["commit-quality"], "unknown names are ignored");
  } finally {
    delete process.env.HULANE_DISCIPLINE_DISABLE;
  }

  // 进程环境逃生口(hook 进程层,spawnSync env 注入)
  const hooked = decision(runHook(guardHook, {
    hook_event_name: "PreToolUse",
    cwd: root,
    tool_input: { command: 'git commit -m "wip"' },
  }, { env: { HULANE_DISCIPLINE_DISABLE: "commit-quality" } }));
  assert.equal(hooked.permissionDecision, "allow");

  // 命令内联同名赋值不可自禁(进程环境未设)
  const selfDisable = evaluateDisciplineBash({
    cwd: root,
    command: "HULANE_DISCIPLINE_DISABLE=git-bypass git commit --no-verify",
  });
  assert.equal(selfDisable.allowed, false);
  assert.match(selfDisable.reason, /Git 钩子不可绕过/);
});

// ── 验收 14/15:fail-closed 与纪律优先 ───────────────────────────────────────

test("acceptance 14: discipline main flow fails closed on internal errors and malformed stdin", () => {
  assert.equal(evaluateDisciplineBash({ get command() { throw new Error("boom"); } }).allowed, false);
  assert.match(evaluateDisciplineBash({ get command() { throw new Error("boom"); } }).reason, /fail-closed/);
  assert.equal(evaluateDisciplineEdit({ get filePath() { throw new Error("boom"); } }).allowed, false);
  assert.match(evaluateDisciplineEdit({ get filePath() { throw new Error("boom"); } }).reason, /fail-closed/);

  // hook 入口:stdin JSON 解析失败 → deny(fail-closed)
  const badGuard = spawnSync(process.execPath, [guardHook], { input: "not json at all", encoding: "utf8" });
  assert.equal(JSON.parse(badGuard.stdout).hookSpecificOutput.permissionDecision, "deny");
  const badDiscipline = spawnSync(process.execPath, [disciplineHook], { input: "not json at all", encoding: "utf8" });
  assert.equal(JSON.parse(badDiscipline.stdout).hookSpecificOutput.permissionDecision, "deny");
  assert.match(JSON.parse(badDiscipline.stdout).hookSpecificOutput.permissionDecisionReason, /fail-closed/);
});

test("acceptance 15: a discipline deny outranks whitelist and token authorizations", () => {
  const root = managedRepository({ allowlist: ["hutong236/hutong-zcode-marketplace"] });
  const remote = "https://github.com/hutong236/hutong-zcode-marketplace.git";
  // 正向对照:无绕过旗标时该推送本会被白名单放行
  const control = decision(runHook(guardHook, {
    hook_event_name: "PreToolUse",
    cwd: root,
    tool_input: { command: `git push ${remote} main` },
  }));
  assert.equal(control.permissionDecision, "allow");
  assert.match(control.permissionDecisionReason, /exempt remote/);
  // 带 --no-verify:纪律 deny 优先
  const denied = decision(runHook(guardHook, {
    hook_event_name: "PreToolUse",
    cwd: root,
    tool_input: { command: `git push --no-verify ${remote} main` },
  }));
  assert.equal(denied.permissionDecision, "deny");
  assert.match(denied.permissionDecisionReason, /Git 钩子不可绕过/);
});

// ── Edit/Write 薄入口协议(hooks/discipline.mjs) ─────────────────────────────

test("discipline Edit/Write entry speaks the PreToolUse protocol with file_path and file fallbacks", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "hulane-discipline-entry-"));
  const existing = path.join(root, ".eslintrc.js");
  fs.writeFileSync(existing, "module.exports = {};\n");

  const denied = decision(runHook(disciplineHook, {
    hook_event_name: "PreToolUse",
    tool_input: { file_path: existing },
  }));
  assert.equal(denied.permissionDecision, "deny");
  assert.match(denied.permissionDecisionReason, /应修代码而非弱化检查配置/);

  const fallback = decision(runHook(disciplineHook, {
    hook_event_name: "PreToolUse",
    tool_input: { file: existing },
  }));
  assert.equal(fallback.permissionDecision, "deny");

  const allowed = decision(runHook(disciplineHook, {
    hook_event_name: "PreToolUse",
    tool_input: { file_path: path.join(root, "src", "main.ts") },
  }));
  assert.equal(allowed.permissionDecision, "allow");
});

test("acceptance 17: hooks.json wires Bash→guard.mjs and Edit|Write→discipline.mjs process hooks", () => {
  const hooks = JSON.parse(fs.readFileSync(path.join(repositoryRoot, "hulane", "hooks", "hooks.json"), "utf8"));
  const preToolUse = hooks.hooks.PreToolUse;
  const bash = preToolUse.find((entry) => entry.matcher === "Bash");
  assert.ok(bash, "Bash matcher entry must remain");
  assert.ok(bash.hooks.every((hook) => hook.type === "process" && hook.args.some((arg) => arg.endsWith("guard.mjs"))));
  const editWrite = preToolUse.find((entry) => entry.matcher === "Edit|Write");
  assert.ok(editWrite, "Edit|Write matcher entry is missing");
  assert.ok(editWrite.hooks.every((hook) => hook.type === "process" && hook.args.some((arg) => arg.endsWith("discipline.mjs"))));
});

// ── 验收 11 附属:Bash 编排层对干净暂存的普通提交零打扰 ───────────────────────

test("clean staged content commits without discipline interference", () => {
  const root = plainRepository();
  stage(root, "src/clean-feature.ts", "export const value = 1;\n");
  const verdict = evaluateDisciplineBash({ cwd: root, command: 'git commit -m "feat: clean"' });
  assert.equal(verdict.allowed, true);
  assert.equal(verdict.reason, "No discipline violation");
});

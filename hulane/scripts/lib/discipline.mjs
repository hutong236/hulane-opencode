// hulane/scripts/lib/discipline.mjs — 执行纪律守卫(纯检测库)
//
// PreToolUse Hook: Execution Discipline Guard
//
// 三个纪律检查的核心检测面移植自 affaan-m/ECC(MIT),轻量重写:
//   ① git 钩子绕过拦截        ← scripts/hooks/block-no-verify.js
//   ② lint/formatter 配置保护  ← scripts/hooks/config-protection.js
//   ③ 提交内容卫生检查          ← scripts/hooks/pre-bash-commit-quality.js
//
// 与 ECC 原版的差异:不携带其完整 shell 语义解析器(shell-scan),检测在
// guard.mjs 的 shell 分段(换行/&&/||/;)粒度进行;heredoc、管道生成命令、
// sed 动态生成、env -S 传播等形态明确不在覆盖面(见 hulane/README.md
// 「执行纪律守卫」的 v2 已知缺口)。
//
// ---------------------------------------------------------------------------
// ECC 原始版权与 MIT 声明(检测面来源):
//
// MIT License
//
// Copyright (c) 2026 Affaan Mustafa
//
// Permission is hereby granted, free of charge, to any person obtaining a copy
// of this software and associated documentation files (the "Software"), to deal
// in the Software without restriction, including without limitation the rights
// to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
// copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions:
//
// The above copyright notice and this permission notice shall be included in all
// copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
// AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
// LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
// OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
// SOFTWARE.
// ---------------------------------------------------------------------------

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";
// 复用既有守卫的 shell 分段与 -m 消息体剥离(与 push/tag 守卫同一套分段语义;
// 函数声明提升使本模块与 guard.mjs 的相互引用在 ESM 循环下安全)
import { shellSegments, stripMessageBodies } from "../../hooks/guard.mjs";

// ── 逃生口 ───────────────────────────────────────────────────────────────────
// 只读 hook 进程环境:被检命令文本里的同名内联赋值不是逃生口(不可自禁)。
const DISCIPLINE_CHECK_NAMES = new Set(["git-bypass", "config-protection", "commit-quality"]);

export function disabledChecks() {
  const raw = process.env.HULANE_DISCIPLINE_DISABLE ?? "";
  return new Set(
    String(raw)
      .split(",")
      .map((value) => value.trim())
      .filter((value) => DISCIPLINE_CHECK_NAMES.has(value)),
  );
}

// ── ① git 钩子绕过拦截(轻量版) ──────────────────────────────────────────────

// Git config 的节与变量名大小写不敏感(core.hookspath 无 subsection),
// 候选键统一小写后比较。见 https://git-scm.com/docs/git-config
function isHookRedirectConfigKey(key) {
  const normalized = key.toLowerCase();
  return normalized === "core.hookspath" || normalized === "include.path"
    || /^includeif\..*\.path$/.test(normalized);
}

// setting 形如 "core.hooksPath=/dev/null":等号前是配置键
function isHookRedirectSetting(setting) {
  return isHookRedirectConfigKey(setting.split("=", 1)[0]);
}

const PROTECTED_GIT_COMMANDS = new Set(["commit", "push", "merge", "cherry-pick", "rebase", "am"]);
// git 全局选项中"取一值"的选项:解析时跳过其值 token(-c 的值另行检测)
const GIT_GLOBAL_VALUES = new Set(["-c", "-C", "--config-env", "--work-tree", "--git-dir", "--namespace", "--super-prefix"]);
// 包装器:允许 VAR=... 赋值前缀出现在这些 token 之后仍视为命令头部
const WRAPPER_COMMANDS = new Set(["env", "sudo", "doas", "command", "exec"]);

// commit 的取值型长选项(取一值,跳下一 token)
const COMMIT_OPTIONS_WITH_VALUE = new Set([
  "-m", "--message", "-F", "--file", "-C", "--reuse-message", "-c", "--reedit-message",
  "--author", "--date", "--template", "--fixup", "--squash", "--pathspec-from-file",
]);
// commit 的内联值型长选项(--message=...):值在同一 token 内,不视为独立旗标
const COMMIT_OPTIONS_WITH_INLINE_VALUE = [
  "--message=", "--file=", "--reuse-message=", "--reedit-message=", "--author=",
  "--date=", "--template=", "--fixup=", "--squash=", "--pathspec-from-file=",
];
// 短选项簇中的取值型短选项:其后字母是该选项的内联值(如 -m 的消息),停扫
const COMMIT_SHORT_OPTIONS_WITH_VALUE = new Set(["m", "F", "C", "c", "t"]);
// 短选项簇中的可选值型短选项(-uno、-S<keyid>):簇剩余部分是值,停扫
const COMMIT_SHORT_OPTIONS_WITH_OPTIONAL_VALUE = new Set(["u", "S"]);

// 简化引号感知 tokenizer:双/单引号包住的 token 不拆(引号剥除、内容为单一
// token),避免 `git commit -m "fix -n bug"` 里消息体被误判成旗标
function tokenize(segment) {
  const tokens = [];
  let current = "";
  let quote = null;
  let started = false;
  for (const character of segment) {
    if (quote) {
      if (character === quote) quote = null;
      else current += character;
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      started = true;
      continue;
    }
    if (/\s/.test(character)) {
      if (started) {
        tokens.push(current);
        current = "";
        started = false;
      }
      continue;
    }
    current += character;
    started = true;
  }
  if (started) tokens.push(current);
  return tokens;
}

function basename(value) {
  return String(value).replace(/\\/g, "/").split("/").pop();
}

function isGitExecutable(value) {
  const name = basename(value).toLowerCase();
  return name === "git" || name === "git.exe";
}

function isEnvAssignment(value) {
  return /^[A-Za-z_][A-Za-z0-9_]*=/.test(value);
}

// git 的选项解析器接受长选项的任意无歧义前缀:`--no-veri`/`--no-verif` 等价于
// --no-verify;更短的前缀(--no-ver)与 --no-verbose 歧义、git 自会拒绝,
// 因此从 --no-v 起全拦不会放过任何本可运行的形态
function isNoVerifyLongFlag(value) {
  return value.length >= "--no-v".length && "--no-verify".startsWith(value);
}

// 短选项簇分析:commit 的 -n 不必领头(-an 即 -a 加 -n)。扫到取值型/可选值
// 型短选项即停——其后字母是内联值,-mn 的 n 是消息文本不是旗标
function isCommitNoVerifyShortFlag(value) {
  if (!value.startsWith("-") || value.startsWith("--") || value === "-") return false;
  const options = value.slice(1);
  for (let index = 0; index < options.length; index += 1) {
    const option = options.charAt(index);
    if (option === "n") return true;
    if (COMMIT_SHORT_OPTIONS_WITH_VALUE.has(option)) return false;
    if (COMMIT_SHORT_OPTIONS_WITH_OPTIONAL_VALUE.has(option)) return false;
  }
  return false;
}

// 分类含取值型短选项的簇 token:-m 在簇尾则吞下一 token,在簇中则内联值
function getCommitShortValueOption(value) {
  if (!value.startsWith("-") || value.startsWith("--") || value === "-") return null;
  const options = value.slice(1);
  for (let index = 0; index < options.length; index += 1) {
    if (COMMIT_SHORT_OPTIONS_WITH_VALUE.has(options.charAt(index))) {
      return {
        consumesNextValue: index === options.length - 1,
        containsInlineValue: index < options.length - 1,
      };
    }
  }
  return null;
}

function commitOptionConsumesNextValue(value) {
  if (isCommitNoVerifyShortFlag(value)) return false;
  if (COMMIT_OPTIONS_WITH_VALUE.has(value)) return true;
  const shortValueOption = getCommitShortValueOption(value);
  return Boolean(shortValueOption && shortValueOption.consumesNextValue);
}

function commitOptionContainsInlineValue(value) {
  if (isCommitNoVerifyShortFlag(value)) return false;
  if (COMMIT_OPTIONS_WITH_INLINE_VALUE.some((prefix) => value.startsWith(prefix))) return true;
  const shortValueOption = getCommitShortValueOption(value);
  return Boolean(shortValueOption && shortValueOption.containsInlineValue);
}

// 仅跟踪本条命令文本上出现的字面量赋值;不读宿主环境、不展开任意引用。
// 出现四类 GIT_CONFIG_* 变量的命令行赋值且关联 hook-redirect 键即拦;
// GIT_CONFIG_KEY_0=user.name 这类非 hook 键不拦。
const GIT_CONFIG_ENV_NAME = /^GIT_CONFIG_(COUNT|PARAMETERS|KEY_[0-9]+|VALUE_[0-9]+)$/;

function gitEnvironmentOverride(assignments) {
  let override = null;
  for (const [name, value] of assignments) {
    if (!GIT_CONFIG_ENV_NAME.test(name)) continue;
    if (/^GIT_CONFIG_KEY_[0-9]+$/.test(name)) {
      if (isHookRedirectConfigKey(value)) {
        override = name;
        break;
      }
    } else if (name === "GIT_CONFIG_PARAMETERS") {
      // 旧 'key=value' 与新 "key"='value' 形态都做引号剥除后的字面量检查
      const settings = String(value).match(/'[^']*'|[^\s']+/g) ?? [];
      for (const setting of settings) {
        if (isHookRedirectSetting(setting.replace(/^'|'$/g, ""))) {
          override = name;
          break;
        }
      }
    }
    if (override) break;
  }
  return override;
}

function violation(check, reason) {
  return { check, reason };
}

// `git config <key> <value>` 持久写入(含 --global/--local/--system/--file 前缀):
// ECC 未覆盖、spec 要求拦截的持久 hook-redirect 设置路径
function checkGitConfigWrite(tokens, index) {
  let key = null;
  let value = null;
  let endOfOptions = false;
  for (let cursor = index + 1; cursor < tokens.length; cursor += 1) {
    const token = tokens[cursor];
    if (!endOfOptions && token === "--") {
      endOfOptions = true;
      continue;
    }
    if (!endOfOptions && token.startsWith("-")) {
      // --file/-f/--blob 取一值,其值不是配置键
      if (token === "-f" || token === "--file" || token === "--blob") cursor += 1;
      continue;
    }
    if (key === null) {
      key = token;
      continue;
    }
    value = token;
    break;
  }
  if (key !== null && value !== null && isHookRedirectConfigKey(key)) {
    return violation(
      "git-bypass",
      `检测到 git config 持久写入 ${key}(hook-redirect 配置键):Git 钩子不可绕过`,
    );
  }
  return null;
}

// 从 tokens[start](git 可执行)开始解析:全局选项段(检测 -c/--config-env 的
// hook-redirect 设置)→ 受保护子命令 → 子命令参数段的 --no-verify/-n 扫描
function checkGitWords(tokens, start, assignments) {
  let index = start + 1;
  let override = assignments ? gitEnvironmentOverride(assignments) : null;
  for (; index < tokens.length; index += 1) {
    const value = tokens[index];
    if (!value.startsWith("-")) break;
    if (value === "--") {
      index += 1;
      break;
    }
    if (value === "-c" || value === "--config-env") {
      const setting = tokens[index + 1] ?? "";
      if (isHookRedirectSetting(setting)) override = `git ${value} ${setting.split("=", 1)[0]}`;
    } else if (value.startsWith("-c")) {
      if (isHookRedirectSetting(value.slice(2))) override = `git -c ${value.slice(2).split("=", 1)[0]}`;
    } else if (value.startsWith("--config-env=")) {
      const setting = value.slice("--config-env=".length);
      if (isHookRedirectSetting(setting)) override = `git --config-env= ${setting.split("=", 1)[0]}`;
    }
    if (GIT_GLOBAL_VALUES.has(value)) index += 1;
  }
  const subcommand = tokens[index];
  if (subcommand === "config") return checkGitConfigWrite(tokens, index);
  if (!PROTECTED_GIT_COMMANDS.has(subcommand)) return null;
  if (override) {
    return violation(
      "git-bypass",
      `检测到 ${override} 重定向 Git 钩子路径(git ${subcommand} 前置):Git 钩子不可绕过`,
    );
  }
  let skipNext = false;
  for (index += 1; index < tokens.length; index += 1) {
    const value = tokens[index];
    if (skipNext) {
      skipNext = false;
      continue;
    }
    if (value === "--") break;
    if (subcommand === "commit") {
      if (commitOptionConsumesNextValue(value)) {
        skipNext = true;
        continue;
      }
      if (commitOptionContainsInlineValue(value)) continue;
    }
    if (isNoVerifyLongFlag(value) || (subcommand === "commit" && isCommitNoVerifyShortFlag(value))) {
      return violation(
        "git-bypass",
        `检测到 git ${subcommand} ${value}(--no-verify 类钩子绕过旗标):Git 钩子不可绕过`,
      );
    }
  }
  return null;
}

// 单段分析:允许 VAR=... 赋值前缀(含 env/sudo 等包装器后的赋值),命令头
// 第一个非赋值/非包装器 token 是 git 才进入检测;其余命令头即放行(管道等
// 复合形态不在轻量版覆盖面)
function analyzeSegment(segment) {
  const tokens = tokenize(segment);
  const assignments = new Map();
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (isEnvAssignment(token)) {
      const equals = token.indexOf("=");
      assignments.set(token.slice(0, equals), token.slice(equals + 1));
      continue;
    }
    if (WRAPPER_COMMANDS.has(token)) continue;
    if (isGitExecutable(token)) return checkGitWords(tokens, index, assignments);
    return null;
  }
  return null;
}

// 检测面:--no-verify 及无歧义前缀 / commit -n 短旗标簇 / -c 与 --config-env 的
// hook-redirect 覆盖 / git config 持久写入 / 同命令行 GIT_CONFIG_* 注入。
// 分段与消息体剥离复用 guard.mjs 既有工具。
export function analyzeGitBypass(command) {
  const text = String(command ?? "");
  for (const segment of shellSegments(stripMessageBodies(text))) {
    const result = analyzeSegment(segment);
    if (result) return result;
  }
  return null;
}

// ── ② lint/formatter 配置保护 ────────────────────────────────────────────────

// 精确 basename 清单(全部小写,大小写不敏感匹配):ESLint/Prettier/Biome/
// Ruff/Stylelint/markdownlint 全家族 + ignore 文件
const PROTECTED_FILES = new Set([
  // ESLint(legacy + v9 flat config)
  ".eslintrc", ".eslintrc.js", ".eslintrc.cjs", ".eslintrc.json", ".eslintrc.yml", ".eslintrc.yaml",
  "eslint.config.js", "eslint.config.mjs", "eslint.config.cjs", "eslint.config.ts", "eslint.config.mts", "eslint.config.cts",
  // Prettier
  ".prettierrc", ".prettierrc.js", ".prettierrc.cjs", ".prettierrc.json", ".prettierrc.yml", ".prettierrc.yaml",
  "prettier.config.js", "prettier.config.cjs", "prettier.config.mjs",
  // Biome
  "biome.json", "biome.jsonc", ".biome.json", ".biome.jsonc",
  // Ruff(pyproject.toml 故意不含:它同时承载项目元数据,全拦会阻断正常依赖变更)
  ".ruff.toml", "ruff.toml",
  // Shell / Stylelint / Markdown
  ".shellcheckrc",
  ".stylelintrc", ".stylelintrc.json", ".stylelintrc.yml", ".stylelintrc.yaml", ".stylelintrc.js", ".stylelintrc.cjs", ".stylelintrc.mjs",
  "stylelint.config.js", "stylelint.config.cjs", "stylelint.config.mjs", "stylelint.config.ts", "stylelint.config.mts", "stylelint.config.cts",
  ".markdownlint.json", ".markdownlint.jsonc", ".markdownlint.yaml", ".markdownlint.yml", ".markdownlint.cjs", ".markdownlint.mjs", ".markdownlintrc",
  ".markdownlint-cli2.jsonc", ".markdownlint-cli2.yaml", ".markdownlint-cli2.cjs", ".markdownlint-cli2.mjs",
  // ignore 文件:不动代码也不动配置、加一行路径就让检查闭嘴的最廉价绕过
  ".eslintignore", ".prettierignore", ".stylelintignore", ".markdownlintignore",
]);

// 两条通配:<tool>.config.<qualifier>.<ext> 与 .<tool>rc.<qualifier>.<ext>
// (monorepo 常见的共享基座配置,如 eslint.config.base.mjs)。刻意不含
// vite/jest/playwright/tsconfig 等构建测试工具配置:本检查的目的 是阻止
// "改弱检查配置代替修代码",动打包器/测试配置是正常工作
const PROTECTED_PATTERNS = [
  /^(eslint|prettier|stylelint|commitlint|oxlint)\.config(\.[A-Za-z0-9_-]+)*\.(js|mjs|cjs|ts|mts|cts)$/i,
  /^\.(eslintrc|prettierrc|stylelintrc|markdownlintrc)(\.[A-Za-z0-9_-]+)*\.(js|cjs|mjs|json|jsonc|yml|yaml|toml)$/i,
];

export function isProtectedConfigName(name) {
  const value = String(name ?? "");
  const lower = value.toLowerCase();
  return PROTECTED_FILES.has(value) || PROTECTED_FILES.has(lower)
    || PROTECTED_PATTERNS.some((pattern) => pattern.test(value));
}

export function evaluateDisciplineEdit(input = {}) {
  try {
    const filePath = input.filePath;
    if (!filePath) return { allowed: true, reason: "No file path to inspect" };
    if (disabledChecks().has("config-protection")) {
      return { allowed: true, reason: "config-protection discipline disabled via HULANE_DISCIPLINE_DISABLE" };
    }
    const name = path.basename(String(filePath));
    if (!isProtectedConfigName(name)) return { allowed: true, reason: `${name} is not a protected check config` };
    // 首创放行:没有既有配置可弱化。用 lstatSync 而非 existsSync——悬空
    // symlink 也算存在;仅 ENOENT 视为不存在,其余错误(EACCES/EPERM/ELOOP)
    // 一律视为存在,fail-closed
    let exists = true;
    try {
      fs.lstatSync(filePath);
    } catch (error) {
      if (error && error.code === "ENOENT") exists = false;
    }
    if (!exists) return { allowed: true, reason: `First-time creation of ${name} is allowed` };
    return {
      allowed: false,
      reason: `禁止修改已存在的检查配置 ${name}:应修代码而非弱化检查配置;确属必要的配置变更请临时设置 HULANE_DISCIPLINE_DISABLE=config-protection`,
    };
  } catch (error) {
    return { allowed: false, reason: `Hulane discipline guard fail-closed: ${error.message}` };
  }
}

// ── ③ 提交内容卫生检查 ────────────────────────────────────────────────────────

const COMMIT_TRIGGER = /\bgit\s+commit\b/;
const CHECKABLE_EXTENSIONS = [".js", ".jsx", ".ts", ".tsx", ".py", ".go", ".rs"];
const MAX_STAGED_FILES = 200;
const MAX_FILE_CONTENT_BYTES = 256 * 1024;
const MAX_REPORTED_VIOLATIONS = 5;

// 捕获到的 api-key 值是否为"明显的非密钥占位符":刻意收窄——只豁免整值的
// 环境引用/插值/尖括号 token 与显式占位词白名单;任意高熵数据(全大写
// hex、base32、纯数字、混合 token)不豁免,泛化规则是唯一兜住无前缀密钥
// 的网,漏报是该检查要防的安全临界失效
function isPlaceholderSecret(value) {
  const trimmed = (value || "").trim();
  if (trimmed.length === 0) return true;
  if (/^process\.env\.[A-Za-z0-9_]+$/.test(trimmed)) return true;
  if (/^\$\{[^}]*\}$/.test(trimmed)) return true;
  if (/^<[^<>]*>$/.test(trimmed)) return true;
  if (/^(REPLACE_ME|CHANGE_?ME|YOUR[_-]?API[_-]?KEY|YOUR[_-]?KEY[_-]?HERE|API[_-]?KEY|SECRET|TOKEN|KEY|TODO|TBD|FIXME|XXX+)$/i.test(trimmed)) return true;
  return false;
}

const SECRET_PATTERNS = [
  { pattern: /sk-ant-[a-zA-Z0-9_-]{20,}/, name: "Anthropic API key" },
  { pattern: /sk-[a-zA-Z0-9]{20,}/, name: "OpenAI API key" },
  { pattern: /ghp_[a-zA-Z0-9]{36}/, name: "GitHub PAT" },
  { pattern: /AKIA[A-Z0-9]{16}/, name: "AWS Access Key" },
  { pattern: /api[_-]?key\s*[=:]\s*['"]([^'"]+)['"]/i, name: "API key", valueGroup: 1 },
  { pattern: /api[_-]?key\s*[=:]\s*(?!['"])((?=[A-Za-z0-9_-]*\d)[A-Za-z0-9_-]{12,})/i, name: "API key", valueGroup: 1 },
];

function findLineIssues(filePath, line, lineNum) {
  const issues = [];
  const trimmed = line.trim();
  if (trimmed.includes("console.log") && !trimmed.startsWith("//") && !trimmed.startsWith("*") && !trimmed.startsWith("#")) {
    issues.push({ kind: "console.log", reason: `${filePath}:${lineNum} console.log 调试输出` });
  }
  if (/\bdebugger\b/.test(line) && !trimmed.startsWith("//") && !trimmed.startsWith("#")) {
    issues.push({ kind: "debugger", reason: `${filePath}:${lineNum} debugger 语句` });
  }
  for (const { pattern, name, valueGroup } of SECRET_PATTERNS) {
    const match = line.match(pattern);
    if (match && !(valueGroup && isPlaceholderSecret(match[valueGroup]))) {
      issues.push({ kind: "secret", reason: `${filePath}:${lineNum} 疑似硬编码密钥(${name})` });
      break;
    }
  }
  return issues;
}

// 暂存区内容扫描。command 提供时先做触发判定:非 `git commit` 或含 --amend
// 返回 null(检查不适用);git 命令失败(如非 git 目录)也返回 null(无法
// 执行,放行);空数组=触发且干净;命中返回违规数组(前 5 条)。
export function scanStagedContent(cwd, command) {
  if (command !== undefined) {
    const text = String(command ?? "");
    if (!COMMIT_TRIGGER.test(text) || text.includes("--amend")) return null;
  }
  const staged = spawnSync("git", ["diff", "--cached", "--name-only", "--diff-filter=ACMR"], {
    cwd,
    encoding: "utf8",
    stdio: ["pipe", "pipe", "pipe"],
  });
  if (staged.status !== 0) return null;
  const files = staged.stdout.trim().split("\n")
    .filter((file) => file.length > 0 && CHECKABLE_EXTENSIONS.some((extension) => file.endsWith(extension)))
    .slice(0, MAX_STAGED_FILES);
  const violations = [];
  for (const file of files) {
    if (violations.length >= MAX_REPORTED_VIOLATIONS) break;
    // 读暂存区内容(git show :path),不是工作区
    const shown = spawnSync("git", ["show", `:${file}`], {
      cwd,
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
    });
    if (shown.status !== 0) continue;
    // 单文件内容上限 256KB:超出截断尾部(尾部不扫描,fail-open)
    const content = shown.stdout.length > MAX_FILE_CONTENT_BYTES
      ? shown.stdout.slice(0, MAX_FILE_CONTENT_BYTES)
      : shown.stdout;
    for (const [index, line] of content.split("\n").entries()) {
      if (violations.length >= MAX_REPORTED_VIOLATIONS) break;
      violations.push(...findLineIssues(file, line, index + 1).slice(0, MAX_REPORTED_VIOLATIONS - violations.length));
    }
  }
  return violations;
}

// ── 编排:Bash 侧三检查入口(guard.mjs 调用) ────────────────────────────────

export function evaluateDisciplineBash(input = {}) {
  try {
    const command = input.command;
    if (!disabledChecks().has("git-bypass")) {
      const bypass = analyzeGitBypass(command);
      if (bypass) return { allowed: false, reason: bypass.reason };
    }
    if (!disabledChecks().has("commit-quality")) {
      const violations = scanStagedContent(input.cwd, command);
      if (violations && violations.length > 0) {
        return { allowed: false, reason: violations.map((entry) => entry.reason).join(";") };
      }
    }
    return { allowed: true, reason: "No discipline violation" };
  } catch (error) {
    return { allowed: false, reason: `Hulane discipline guard fail-closed: ${error.message}` };
  }
}

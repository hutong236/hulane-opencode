// 纯函数规格校验器:只约束 Markdown 标题骨架(内容可中文),不做任何 IO,
// 供 MCP 控制面与测试复用。路径约定:
//   主规格  openspec/specs/<capability>/spec.md
//   delta   openspec/changes/**/delta.md(含 archive/<REQ-ID>/ 决策史归档)

export const SPECS_DIR = "openspec/specs";
export const CHANGES_DIR = "openspec/changes";
export const SPECS_ARCHIVE_DIR = "openspec/changes/archive";
export const CAPABILITY_SPEC_FILE = "spec.md";
export const DELTA_SPEC_FILE = "delta.md";
export const DELTA_GROUPS = Object.freeze(["ADDED", "MODIFIED", "REMOVED", "RENAMED"]);

const HEADING_PATTERN = /^(#{1,6})\s+(.*?)\s*$/;
const REQUIREMENT_TITLE = /^Requirement:\s*(\S.*?)\s*$/;
const SCENARIO_TITLE = /^Scenario:\s*(\S.*?)\s*$/;
const DELTA_GROUP_TITLE = /^(ADDED|MODIFIED|REMOVED|RENAMED) Requirements$/;

function linesOf(content) {
  return String(content ?? "").split(/\r?\n/);
}

function headings(content) {
  return linesOf(content)
    .map((line, index) => {
      const match = line.match(HEADING_PATTERN);
      return match ? { level: match[1].length, title: match[2], line: index + 1 } : null;
    })
    .filter(Boolean);
}

// 需求块 = 一个 "### Requirement: <名称>" 标题 + 到下一个 H3/H2/H1 标题为止的
// 正文;期间收集 "#### Scenario: <名称>" 与原始正文行(RENAMED 的 FROM:/TO: 用)
function parseRequirementBlocks(content) {
  const blocks = [];
  let current = null;
  for (const [index, line] of linesOf(content).entries()) {
    const match = line.match(HEADING_PATTERN);
    if (match && match[1].length <= 3) {
      if (current) blocks.push(current);
      current = null;
      if (match[1].length === 3) {
        const title = match[2].match(REQUIREMENT_TITLE);
        if (title) current = { name: title[1], line: index + 1, scenarios: [], body: [] };
      }
      continue;
    }
    if (!current) continue;
    if (match && match[1].length === 4) {
      const scenario = match[2].match(SCENARIO_TITLE);
      if (scenario) current.scenarios.push(scenario[1]);
      continue;
    }
    current.body.push(line);
  }
  if (current) blocks.push(current);
  return blocks;
}

export function isCapabilitySpecPath(relativePath) {
  const normalized = String(relativePath ?? "").replaceAll("\\", "/");
  return normalized.startsWith(`${SPECS_DIR}/`) && normalized.endsWith(`/${CAPABILITY_SPEC_FILE}`);
}

export function isDeltaSpecPath(relativePath) {
  const normalized = String(relativePath ?? "").replaceAll("\\", "/");
  return normalized.startsWith(`${CHANGES_DIR}/`) && normalized.endsWith(`/${DELTA_SPEC_FILE}`);
}

// 主规格骨架:# <capability> Specification(唯一 H1) + ## Purpose + ## Requirements,
// 且至少一个需求块、每个需求块至少一个 Scenario
export function validateCapabilitySpec(content) {
  const text = String(content ?? "");
  if (!text.trim()) throw new Error("capability spec is empty");
  const heads = headings(text);
  const h1 = heads.filter((heading) => heading.level === 1);
  if (h1.length !== 1) throw new Error("capability spec must have exactly one H1 heading");
  if (!/^\S.*?\s+Specification$/.test(h1[0].title)) {
    throw new Error(`capability spec H1 must be "<capability> Specification", found: ${h1[0].title}`);
  }
  const h2Titles = new Set(heads.filter((heading) => heading.level === 2).map((heading) => heading.title));
  for (const section of ["Purpose", "Requirements"]) {
    if (!h2Titles.has(section)) throw new Error(`capability spec is missing "## ${section}"`);
  }
  const blocks = parseRequirementBlocks(text);
  if (!blocks.length) throw new Error('capability spec must declare at least one "### Requirement:"');
  for (const block of blocks) {
    if (!block.scenarios.length) {
      throw new Error(`Requirement "${block.name}" must declare at least one "#### Scenario:"`);
    }
  }
  return {
    capability: h1[0].title.replace(/\s+Specification$/, ""),
    requirements: blocks.map((block) => ({ name: block.name, scenarios: block.scenarios })),
  };
}

// delta 骨架:至少一个 "## ADDED|MODIFIED|REMOVED|RENAMED Requirements" 分组;
// 每个分组至少一个需求条目;ADDED/MODIFIED 条目同主规格(至少一个 Scenario),
// REMOVED 只需需求块,RENAMED 条目带 FROM:/TO: 行
export function validateDeltaSpec(content) {
  const text = String(content ?? "");
  if (!text.trim()) throw new Error("delta spec is empty");
  const lines = linesOf(text);
  const boundaries = headings(text).filter((heading) => heading.level <= 2);
  const groups = [];
  for (let index = 0; index < boundaries.length; index += 1) {
    const heading = boundaries[index];
    if (!DELTA_GROUP_TITLE.test(heading.title)) continue;
    const end = boundaries[index + 1]?.line ?? lines.length + 1;
    groups.push({
      kind: DELTA_GROUP_TITLE.exec(heading.title)[1],
      body: lines.slice(heading.line, end - 1).join("\n"),
    });
  }
  if (!groups.length) {
    throw new Error('delta spec needs at least one "## ADDED|MODIFIED|REMOVED|RENAMED Requirements" group');
  }
  const summary = [];
  for (const group of groups) {
    const blocks = parseRequirementBlocks(group.body);
    if (!blocks.length) {
      throw new Error(`"## ${group.kind} Requirements" declares no "### Requirement:" entries`);
    }
    for (const block of blocks) {
      if ((group.kind === "ADDED" || group.kind === "MODIFIED") && !block.scenarios.length) {
        throw new Error(`${group.kind} requirement "${block.name}" must declare at least one "#### Scenario:"`);
      }
      if (group.kind === "RENAMED") {
        const body = block.body.join("\n");
        if (!/^(?:[-*]\s*)?FROM:\s*\S/m.test(body)) throw new Error(`RENAMED requirement "${block.name}" is missing a "FROM:" line`);
        if (!/^(?:[-*]\s*)?TO:\s*\S/m.test(body)) throw new Error(`RENAMED requirement "${block.name}" is missing a "TO:" line`);
      }
    }
    summary.push({ group: group.kind, requirements: blocks.map((block) => block.name) });
  }
  return { groups: summary };
}

// 按路径路由:主规格与 delta 各走各的骨架校验;其余文件返回 null(不校验)
export function validateSpecFile(relativePath, content) {
  if (isCapabilitySpecPath(relativePath)) {
    return { kind: "capability", file: relativePath, ...validateCapabilitySpec(content) };
  }
  if (isDeltaSpecPath(relativePath)) {
    return { kind: "delta", file: relativePath, ...validateDeltaSpec(content) };
  }
  return null;
}

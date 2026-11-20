#!/usr/bin/env node
import { appendFile } from 'node:fs/promises';

const TOTAL = 28;
const GITHUB_API = 'https://api.github.com';
const REPO = process.env.GITHUB_REPOSITORY || 'hutong236/hulane-opencode';

function parseIssueCode(title) {
  const result = /^\[WB-(\d{3})\]/.exec(title || '');
  if (!result) return null;
  const code = Number(result[1]);
  return code >= 1 && code <= TOTAL ? code : null;
}

export function summarizeIssues(issues, prs, runs = []) {
  const tasks = new Map();
  for (const issue of issues) {
    if (issue.pull_request) continue;
    const n = parseIssueCode(issue.title);
    if (n === null) continue;
    if (tasks.has(n)) throw new Error(`Duplicate WB-${String(n).padStart(3, '0')} Issue`);
    tasks.set(n, issue);
  }
  const missing = Array.from({ length: TOTAL }, (_, idx) => idx + 1).filter(n => !tasks.has(n));
  const closed = [...tasks.values()].filter(x => x.state === 'closed').length;
  const open = tasks.size - closed;
  const matching = prs.filter(p => /WB-\d{3}/i.test(`${p.title || ''} ${p.body || ''}`));
  const latest = runs.find(r => r.head_branch === 'main') || null;
  const next = [...tasks.entries()].filter(([,i]) => i.state === 'open').sort(([a], [b]) => a - b).slice(0, 5);
  return { tasks, missing, closed, open, total: TOTAL, matching, latest, next };
}

export function formatSummary(s) {
  const lines = [
    '# OpenCode Workbench · 28 Issues 交付巡检',
    '',
    `- 目标：完成全部 **${s.total}** 项；当前已关闭 **${s.closed}** 项，仍开放 **${s.open}** 项。`,
    '- 提示：Issue 已关闭不等于独立验证了部署、安全或端到端测试；以 PR、CI 与实际验收证据为准。',
    `- 缺失工作项：${s.missing.length ? s.missing.map(n => `WB-${String(n).padStart(3, '0')}`).join(', ') : '无'}`,
    `- 关联工作台 PR：${s.matching.length} 个（可能包含已关闭 PR）。`,
    `- 最新 main CI：${s.latest ? `${s.latest.conclusion || s.latest.status} (${s.latest.html_url})` : '没有找到最近的 main CI'}`,
    '', '## 下一步开放工作项', '',
  ];
  if (!s.next.length) lines.push('全部 28 项已关闭；仍需复核 CI、部署与安全验收证据。');
  for (const [num, issue] of s.next) {
    lines.push(`- [WB-${String(num).padStart(3, '0') }](${issue.html_url}): ${issue.title}`);
  }
  lines.push('', '## 当前关联 PR', '');
  if (!s.matching.length) lines.push('- 暂无');
  for (const pr of s.matching.slice(0, 15)) {
    lines.push(`- [#${pr.number}](${pr.html_url}) ${pr.draft ? 'Draft · ' : ''}${pr.merged_at ? 'Merged' : pr.state}: ${pr.title}`);
  }
  return lines.join('\n') + '\n';
}

async function github(path) {
  const token = process.env.GH_TOKEN;
  if (!token) throw new Error('GH_TOKEN is required for API access');
  const response = await fetch(`${GITHUB_API}${path}`, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'hulane-workbench-progress-monitor',
    },
    signal: AbortSignal.timeout(20000),
  });
  if (!response.ok) throw new Error(`GitHub GET ${path} failed: ${response.status}`);
  return response.json();
}

async function listAll(path) {
  const result = [];
  for (let page = 1; page <= 10; page++) {
    const join = path.includes('?') ? '&' : '?';
    const batch = await github(`${path}${join}per_page=100&page=${page}`);
    if (!Array.isArray(batch)) throw new Error(`Expected array from ${path}`);
    result.push(...batch);
    if (batch.length < 100) return result;
  }
  throw new Error(`Pagination limit reached for ${path}`);
}

async function main() {
  if (!/^[\w.-]+\/[\w.-]+$/.test(REPO)) throw new Error('Invalid GITHUB_REPOSITORY');
  const [issues, prs, runData] = await Promise.all([
    listAll(`/repos/${REPO}/issues?state=all`),
    listAll(`/repos/${REPO}/pulls?state=all`),
    github(`/repos/${REPO}/actions/runs?per_page=20`),
  ]);
  const summary = summarizeIssues(issues, prs, runData.workflow_runs ?? []);
  const content = formatSummary(summary);
  process.stdout.write(content);
  if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, content);
  if (summary.missing.length) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  main().catch(error => {
    console.error(error);
    process.exitCode = 1;
  });
}

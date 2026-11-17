import assert from 'node:assert/strict';
import test from 'node:test';
import { formatSummary, summarizeIssues } from '../bin/workbench-progress.mjs';

const issues = Array.from({ length: 28 }, (_, index) => ({
  number: index + 5,
  title: `[WB-${String(index + 1).padStart(3, '0')}][M1][P0] Test task ${index + 1}`,
  state: index === 0 ? 'closed' : 'open',
  html_url: `https://github.com/hutong236/hulane-opencode/issues/${index + 5}`,
}));

test('counts all 28 tasks, ignores unrelated issues and PRs, shows first open tasks', () => {
  const report = summarizeIssues([...issues, { number: 3, title: 'Production acceptance', state: 'open' }, { title: '[WB-029] out of scope', state: 'open' }, { ...issues[0], pull_request: {} }], [{ title: 'WB-001 bootstrap', number: 33, draft: true, html_url: 'https://example.com/33', state: 'open' }], []);
  assert.equal(report.closed, 1);
  assert.equal(report.open, 27);
  assert.deepEqual(report.missing, []);
  assert.equal(report.next[0][0], 2);
  assert.match(formatSummary(report), /WB-002/);
  assert.match(formatSummary(report), /28/);
});

test('detects missing or duplicate task definitions', () => {
  assert.deepEqual(summarizeIssues(issues.slice(0, -1), []).missing, [28]);
  assert.throws(() => summarizeIssues([...issues, issues[0]], []), /Duplicate WB-001/);
});

test('uses latest main branch CI status only', () => {
  const runs = [{ head_branch: 'feature', conclusion: 'success' }, { head_branch: 'main', conclusion: 'failure', html_url: 'https://example.com/ci' }];
  const report = summarizeIssues(issues, [], runs);
  assert.match(formatSummary(report), /failure/);
  assert.match(formatSummary(report), /https:\/\/example\.com\/ci/);
});

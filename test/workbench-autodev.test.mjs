import assert from 'node:assert/strict';
import test from 'node:test';
import { ciVerdict, codeOf, dependencies, pages, rowsOf, selectWork, taskOfTitle, validateNoWeakening, validatePaths, weakenedScripts } from '../bin/workbench-autodev.mjs';
const make=()=>Array.from({length:28},(_,i)=>({
  number:i+5,title:`[WB-${String(i+1).padStart(3,'0')}] Task`,state:'open',
  body:i?'## 前置依赖\n- WB-001\n\n## 验收条件\n- WB-028':'## 依赖\n- 无'
}));
const pr={number:33,state:'open',title:'WB-001 bootstrap',
  head:{ref:'feat/WB-001-workbench-bootstrap',sha:'s1',repo:{full_name:'hutong236/hulane-opencode'}}};
test('only 28 IDs and dependency section',()=>{
  assert.equal(codeOf({title:'[WB-001] Start'}),1);
  assert.equal(codeOf({title:'[WB-029] Invalid'}),null);
  assert.deepEqual(dependencies(make()[1]),[1]);
});
test('selects first dependency-ready task',()=>{
  const items=make();
  assert.equal(selectWork(items,[],[]).id,1);
  items[0].state='closed';
  assert.equal(selectWork(items,[],[]).id,2);
});
test('repairs failed CI',()=>{
  const pick=selectWork(make(),[pr],[{head_sha:'s1',name:'Hulane OpenCode CI',status:'completed',conclusion:'failure'}]);
  assert.equal(pick.mode,'repair');
  assert.equal(pick.pr,33);
});
test('green or queued CI waits for approval or completion',()=>{
  assert.equal(selectWork(make(),[pr],[{head_sha:'s1',name:'Workbench CI',status:'completed',conclusion:'success'}]).mode,'wait');
  assert.equal(selectWork(make(),[pr],[{head_sha:'s1',name:'Workbench CI',status:'queued'}]).mode,'wait');
});
test('does not modify fork PR or privileged file paths',()=>{
  const fork=structuredClone(pr);fork.head.repo.full_name='someone/fork';
  assert.equal(selectWork(make(),[fork],[]).mode,'wait');
  assert.equal(validatePaths(['workbench/apps/web/src/App.tsx','docs/WORKBENCH_AUTODEV_LOG.md']),true);
  assert.throws(()=>validatePaths(['docs/SESSION_HANDOFF.md']),/Denied edit/);
  assert.throws(()=>validatePaths(['hulane/mcp/server.mjs']),/Denied edit/);
  assert.throws(()=>validatePaths(['.github/workflows/ci.yml']),/Denied edit/);
  assert.throws(()=>validatePaths(['workbench/.env.local']),/Secret-like/);
  assert.throws(()=>validatePaths(['workbench/secret.pem']),/Secret-like/);
  assert.throws(()=>validatePaths(Array.from({length:31},(_,i)=>`workbench/file${i}`)),/30/);
});
test('an autonomous change cannot remove the checks that judge it',()=>{
  assert.equal(validateNoWeakening({}),true);
  assert.throws(()=>validateNoWeakening({deleted:['workbench/apps/api/test/health.spec.ts']}),/Deleting files/);
  assert.throws(()=>validateNoWeakening({scripts:['test']}),/scripts may not change/);
  assert.throws(()=>validateNoWeakening({scripts:['lint','typecheck','build']}),/scripts may not change/);
  assert.throws(()=>validateNoWeakening({protectedFiles:['workbench/playwright.config.ts']}),/configuration may not change/);
});
test('a protected script counts as weakened only when an existing definition is removed or redefined',()=>{
  const before={test:'node --test',build:'tsc','test:e2e':'playwright test'};
  assert.deepEqual(weakenedScripts(before,{...before}),[]);
  assert.deepEqual(weakenedScripts(before,{...before,test:'echo ok'}),['test']);
  assert.deepEqual(weakenedScripts(before,{build:'tsc','test:e2e':'playwright test'}),['test']);
  assert.deepEqual(weakenedScripts(before,{...before,'test:e2e':'true',lint:'true',dev:'vite'}),['test:e2e']);
  assert.deepEqual(weakenedScripts({}, {test:'true'}),[]);
});

const run = (id, name, event, status, conclusion, extra = {}) => ({ id, name, event, status, conclusion, head_sha: 's1', ...extra });
const jobs = (...pairs) => pairs.map(([name, status, conclusion]) => ({ name, status, conclusion }));
const macOS = 'platform-install-smoke (macos-15)';

test('a job the runner cancelled is not a failed check', () => {
  // What happened to the first automated pull request: the push run lost its macOS job before it started, while
  // the pull request run of the same commit passed it. The selector repaired a green pull request.
  const runs = [
    run(1, 'Hulane OpenCode CI', 'push', 'completed', 'failure',
      { jobs: jobs(['core-tests (20)', 'completed', 'success'], [macOS, 'completed', 'cancelled']) }),
    run(2, 'Workbench CI', 'push', 'completed', 'success'),
    run(3, 'Hulane OpenCode CI', 'pull_request', 'completed', 'success', { jobs: jobs([macOS, 'completed', 'success']) }),
    run(4, 'Workbench CI', 'pull_request', 'completed', 'success'),
  ];
  assert.equal(ciVerdict(runs, r => r.jobs), 'passed');
  const pick = selectWork(make(), [pr], runs);
  assert.equal(pick.mode, 'wait');
  assert.match(pick.reason, /PR #33 awaiting review/);
});

test('a check that failed is still repaired, and a newer run replaces an older one of the same workflow', () => {
  const failed = run(9, 'Workbench CI', 'pull_request', 'completed', 'failure',
    { jobs: jobs(['workbench (20)', 'completed', 'success'], ['workbench (22)', 'completed', 'failure']) });
  assert.equal(selectWork(make(), [pr], [failed]).mode, 'repair');
  const rerun = run(10, 'Workbench CI', 'pull_request', 'completed', 'success',
    { jobs: jobs(['workbench (22)', 'completed', 'success']) });
  assert.equal(ciVerdict([failed, rerun], r => r.jobs), 'passed');
  // A run whose jobs are unknown is judged by its own conclusion.
  assert.equal(ciVerdict([failed]), 'failed');
  assert.equal(ciVerdict([rerun]), 'passed');
});

test('cancelled, missing and running CI make the selector wait instead of rewriting the pull request', () => {
  const cancelled = run(5, 'Workbench CI', 'pull_request', 'completed', 'failure',
    { jobs: jobs(['workbench (22)', 'completed', 'cancelled']) });
  for (const [runs, reason] of [
    [[cancelled], /was cancelled, not failed/],
    [[], /has no CI yet/],
    [[run(6, 'Workbench CI', 'pull_request', 'completed', null, { jobs: jobs(['workbench (22)', 'in_progress', null]) })], /CI running/],
    [[run(7, 'Workbench CI', 'pull_request', 'queued', null)], /CI running/],
  ]) {
    const pick = selectWork(make(), [pr], runs);
    assert.equal(pick.mode, 'wait', String(reason));
    assert.match(pick.reason, reason);
  }
});

test('other commits and other workflows do not count', () => {
  const elsewhere = run(11, 'Workbench CI', 'push', 'completed', 'failure', { head_sha: 'someone-elses-commit' });
  const progress = run(12, 'Workbench 28 Issues progress', 'schedule', 'completed', 'failure');
  // The selector hands the verdict only the runs of the pull request head; other workflows are never in it.
  const pick = selectWork(make(), [pr], [elsewhere, progress]);
  assert.equal(pick.mode, 'wait');
  assert.match(pick.reason, /PR #33 has no CI yet/);
});

test('every dependency line counts, and the dependency section ends at the next heading', () => {
  const issue = { body: '## 实现范围\n提到 WB-028 只是举例\n\n## 前置依赖\n- [WB-002](https://example.invalid/6)\n- [WB-010](https://example.invalid/14)\n\n## 可验收条件\n- WB-009 也被提到\n' };
  // Reading only the first line made WB-012 look ready while WB-010 was still open.
  assert.deepEqual(dependencies(issue), [2, 10]);
  assert.deepEqual(dependencies({ body: '## 依赖\n- 无' }), []);
  assert.deepEqual(dependencies({ body: '## 实现范围\n- WB-001' }), []);
  assert.deepEqual(dependencies({}), []);
  // The incident itself: WB-010 is still open, so WB-012 must not be selected even when everything else is finished.
  const items = make();
  for (const item of items) item.state = 'closed';
  items[9].state = 'open';
  items[11].state = 'open';
  items[11].body = issue.body;
  const busy = { ...pr, title: 'WB-010 in progress',
    head: { ref: 'feat/WB-010-autodev', sha: 's1', repo: { full_name: 'hutong236/hulane-opencode' } } };
  const choice = selectWork(items, [busy], [run(1, 'Workbench CI', 'pull_request', 'completed', 'success')]);
  assert.equal(choice.mode, 'wait');
  assert.match(choice.reason, /WB-12: blocked by 10/);
});

test('the rows of an endpoint are read from the shape the API really answers with', async () => {
  // The Actions endpoints answer with an object that carries the rows, the others with a plain list. The test used to
  // mock the Actions endpoint with a list, so the selector failed on every real run with "Unexpected GitHub response".
  assert.deepEqual(rowsOf([{ id: 1 }]), [{ id: 1 }]);
  assert.deepEqual(rowsOf({ total_count: 1, workflow_runs: [{ id: 1 }] }), [{ id: 1 }]);
  assert.deepEqual(rowsOf({ total_count: 1, jobs: [{ id: 2 }] }), [{ id: 2 }]);
  assert.equal(rowsOf({ total_count: 0 }), null);
  assert.equal(rowsOf({ message: 'Not Found' }), null);
  assert.equal(rowsOf(null), null);
  assert.equal(rowsOf(42), null);

  // The whole list of an Actions endpoint, page by page.
  const asked = [];
  const rows = await pages('/repos/x/actions/runs', async (path) => {
    asked.push(path);
    return { total_count: 1, workflow_runs: [{ id: 7, head_sha: 'abc' }] };
  });
  assert.deepEqual(rows, [{ id: 7, head_sha: 'abc' }]);
  assert.deepEqual(asked, ['/repos/x/actions/runs?per_page=100&page=1']);

  // A full page is followed by the next one.
  let page = 0;
  const many = await pages('/repos/x/pulls', async () => {
    page += 1;
    return page === 1 ? Array.from({ length: 100 }, (_, i) => ({ id: i })) : [{ id: 100 }];
  });
  assert.equal(many.length, 101);
  assert.equal(page, 2);

  // An answer that is neither a list nor an object with rows is refused.
  await assert.rejects(() => pages('/repos/x/issues', async () => ({ message: 'Bad credentials' })), /Unexpected GitHub response/);
});

test('a task whose change has landed waits for acceptance instead of being implemented again', () => {
  // After the delivery pull request is merged the task is done but its issue is still open until a person accepts
  // it. Selecting it again would duplicate work that has already been reviewed and merged.
  const items = make();
  for (const item of items) item.state = 'closed';
  items[3].state = 'open'; // WB-004
  const landed = { number: 65, state: 'closed', merged_at: '2026-11-25T09:11:11Z', title: 'WB-004 remaining scope' };
  const choice = selectWork(items, [], [], [landed]);
  assert.equal(choice.mode, 'wait');
  assert.match(choice.reason, /WB-004: delivered in PR #65, awaiting acceptance/);

  // A pull request that was closed without merging delivers nothing: the task may be started.
  const declined = { ...landed, merged_at: null };
  assert.equal(selectWork(items, [], [], [declined]).mode, 'new');

  // A merged pull request of another task does not stand in the way either.
  const other = { ...landed, title: 'WB-005: something else' };
  assert.equal(selectWork(items, [], [], [other]).mode, 'new');

  // No merged pull request at all: unchanged behavior.
  assert.equal(selectWork(items, [], []).mode, 'new');

  // The task may lead the title or close it; a title that names another task first delivers that one.
  assert.match(selectWork(items, [], [], [{ ...landed, title: 'feat(workbench): rename, default branch and remote (WB-004)' }]).reason,
    /WB-004: delivered in PR #65/);
  assert.equal(selectWork(items, [], [], [{ ...landed, title: 'WB-007: impact rules on top of WB-004' }]).mode, 'new');
  assert.equal(taskOfTitle(undefined), null);
  // A longer number, or a code glued to a word, is not a task.
  assert.equal(taskOfTitle('chore: WB-0040 cleanup'), null);
  assert.equal(taskOfTitle('fix(AWB-004): read the title'), null);

  // An open pull request for the task still decides on its own, before the delivery check.
  const pr = { state: 'open', number: 65, title: 'WB-004: in progress', head: { ref: 'feat/WB-004-autodev', sha: 's1', repo: { full_name: 'hutong236/hulane-opencode' } } };
  const busy = selectWork(items, [pr], [run(1, 'Workbench CI', 'pull_request', 'completed', 'success')], [landed]);
  assert.equal(busy.mode, 'wait');
  assert.match(busy.reason, /PR #65 awaiting review/);
});

test('a merged pull request that only mentions a task does not deliver it', () => {
  const items = make();
  for (const item of items) item.state = 'closed';
  // What held WB-010 back on 2026-11-25: a fix of the selector quoted the task in its text.
  const quote = {
    number: 68, state: 'closed', merged_at: '2026-11-25T05:36:47Z',
    title: 'fix(autodev): own log file, CI verdict by job, every dependency line',
    body: 'WB-012 lists WB-002 (closed) and WB-010 (open) and read as ready.',
  };
  items[9].state = 'open'; // WB-010
  assert.equal(taskOfTitle(quote.title), null);
  assert.equal(selectWork(items, [], [], [quote]).id, 10);

  // A title that spans several tasks is about none of them. Its first code is WB-001, which is closed.
  const span = { number: 35, state: 'closed', merged_at: '2026-11-17T00:00:00Z', title: 'ci(workbench): 每 30 分钟自动推进 WB-001～WB-028', body: '' };
  assert.equal(taskOfTitle(span.title), 1);
  items[9].state = 'closed';
  items[27].state = 'open'; // WB-028
  assert.equal(selectWork(items, [], [], [span]).id, 28);

  // A delivery of another task that says a later task will build on it is not that later task's delivery.
  const delivery = {
    number: 65, state: 'closed', merged_at: '2026-11-25T09:11:11Z', title: 'feat(workbench): WB-004 remaining scope',
    body: 'The capability and dependency tags are reserved storage; WB-007 builds on it.',
  };
  items[27].state = 'closed';
  items[6].state = 'open'; // WB-007
  assert.equal(selectWork(items, [], [], [delivery]).id, 7);
});

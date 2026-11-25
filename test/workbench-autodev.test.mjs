import assert from 'node:assert/strict';
import test from 'node:test';
import { codeOf, dependencies, selectWork, validateNoWeakening, validatePaths, weakenedScripts } from '../bin/workbench-autodev.mjs';
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

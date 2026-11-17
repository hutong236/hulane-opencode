import assert from 'node:assert/strict';
import test from 'node:test';
import { codeOf, dependencies, selectWork, validatePaths } from '../bin/workbench-autodev.mjs';
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
  assert.equal(validatePaths(['workbench/apps/web/src/App.tsx','docs/SESSION_HANDOFF.md']),true);
  assert.throws(()=>validatePaths(['hulane/mcp/server.mjs']),/Denied edit/);
  assert.throws(()=>validatePaths(['.github/workflows/ci.yml']),/Denied edit/);
  assert.throws(()=>validatePaths(Array.from({length:31},(_,i)=>`workbench/file${i}`)),/30/);
});

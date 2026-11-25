import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  ApiError, createRequirement, getRequirement, getRequirements, getRequirementVersion,
  getRequirementVersions, restoreRequirement, transitionRequirement, updateRequirement,
} from '../src/api/client.js';

const UUID = '12345678-1234-4234-8234-123456789abc';
const SHA = 'a'.repeat(64);
const content = {
  title: 'CMDB 扩容', background: '背景', goal: '目标', scope: '范围', risk: '风险',
  acceptanceCriteria: [{ id: 'AC-1', text: '可扩容到 10 倍' }], priority: 'high',
};
const requirement = {
  id: UUID, requirement_key: 'REQ-001', title: 'CMDB 扩容', status: 'draft',
  current_version: 1, revision: 1, created_at: '2026-11-25T00:00:00Z', updated_at: '2026-11-25T00:00:00Z',
  content, content_sha256: SHA,
};
const input = { requirementKey: 'REQ-001', content: content as never, actor: '张三', summary: '初稿' };

test('a write posts the content beside the key, actor and summary, and decodes the answer', async () => {
  const original = globalThis.fetch;
  try {
    globalThis.fetch = async (url, init) => {
      assert.equal(url, '/api/requirements');
      assert.equal(init?.method, 'POST');
      const body = JSON.parse(String(init?.body));
      assert.equal(body.requirementKey, 'REQ-001');
      assert.equal(body.actor, '张三');
      assert.equal(body.summary, '初稿');
      assert.equal(body.title, 'CMDB 扩容');
      assert.deepEqual(body.acceptanceCriteria, [{ id: 'AC-1', text: '可扩容到 10 倍' }]);
      return new Response(JSON.stringify(requirement), { status: 201 });
    };
    assert.deepEqual(await createRequirement(input), requirement);
  } finally { globalThis.fetch = original; }
});

test('a revision and a transition carry the revision the caller saw', async () => {
  const original = globalThis.fetch;
  try {
    const calls: [string, string, unknown][] = [];
    globalThis.fetch = async (url, init) => {
      calls.push([String(url), String(init?.method), JSON.parse(String(init?.body))]);
      return new Response(JSON.stringify({ ...requirement, revision: 2 }), { status: 200 });
    };
    await updateRequirement(UUID, { ...input, expectedRevision: 1 });
    await transitionRequirement(UUID, { status: 'reviewed', expectedRevision: 2, actor: '张三', summary: '评审通过' });
    await restoreRequirement(UUID, { version: 1, expectedRevision: 2, actor: '张三', summary: '恢复 V1' });
    assert.deepEqual(calls.map(call => [call[0], call[1]]), [
      [`/api/requirements/${UUID}`, 'PUT'],
      [`/api/requirements/${UUID}/transitions`, 'POST'],
      [`/api/requirements/${UUID}/restore`, 'POST'],
    ]);
    assert.equal((calls[0][2] as { expectedRevision: number }).expectedRevision, 1);
    assert.equal((calls[1][2] as { expectedRevision: number }).expectedRevision, 2);
    assert.deepEqual(
      [calls[1][2], calls[2][2]].map(body => [body.status ?? body.version, body.expectedRevision]),
      [['reviewed', 2], [1, 2]],
    );
  } finally { globalThis.fetch = original; }
});

test('the answer of an API is refused as a whole when one row is malformed', async () => {
  const original = globalThis.fetch;
  try {
    const broken: unknown[] = [
      { ...requirement, id: 'not-a-uuid' },
      { ...requirement, requirement_key: 'X-1' },
      { ...requirement, status: 'unknown' },
      { ...requirement, content_sha256: 'zz' },
      { ...requirement, content: { ...content, title: '  ' } },
      { ...requirement, content: { ...content, acceptanceCriteria: [{ id: 'AC-1', text: 'a' }, { id: 'AC-1', text: 'b' }] } },
      { ...requirement, content: { ...content, priority: 'urgent' } },
      { ...requirement, current_version: 0 },
    ];
    for (const row of broken) {
      globalThis.fetch = async () => new Response(JSON.stringify({ requirements: [row] }), { status: 200 });
      await assert.rejects(getRequirements(), (e: unknown) => e instanceof ApiError && e.message === 'API 返回的数据结构不正确');
    }
    globalThis.fetch = async () => new Response(JSON.stringify({ requirements: [requirement, requirement] }), { status: 200 });
    await assert.rejects(getRequirements(), (e: unknown) => e instanceof ApiError, 'a duplicated id is refused');
  } finally { globalThis.fetch = original; }
});

test('refused writes say what to do next and never leak the server body', async () => {
  const original = globalThis.fetch;
  try {
    for (const [status, message] of [
      [409, '需求已被他人修改或状态不允许该转换，请刷新后重试'],
      [400, '需求输入无效或格式不正确'],
      [404, '需求不存在'],
    ] as const) {
      globalThis.fetch = async () => new Response('SECRET_SERVER_PATH=/home/secret', { status });
      await assert.rejects(createRequirement(input), (e: unknown) =>
        e instanceof ApiError && e.status === status && e.message === message && !e.message.includes('SECRET'));
    }
  } finally { globalThis.fetch = original; }
});

test('versions decode strictly and ids are checked before any request', async () => {
  const original = globalThis.fetch;
  try {
    const version = {
      id: UUID, requirement_id: UUID, version: 2, content, content_sha256: SHA,
      actor: '张三', summary: '第二次修订', created_at: '2026-11-25T01:00:00Z',
    };
    globalThis.fetch = async url => {
      assert.ok(String(url).startsWith(`/api/requirements/${UUID}/versions`));
      return new Response(JSON.stringify({ versions: [version] }), { status: 200 });
    };
    assert.deepEqual(await getRequirementVersions(UUID), [version]);
    globalThis.fetch = async () => new Response(JSON.stringify(version), { status: 200 });
    assert.deepEqual(await getRequirementVersion(UUID, 2), version);

    globalThis.fetch = async () => { throw new Error('unexpected network request'); };
    for (const call of [
      () => getRequirement('nope'),
      () => getRequirementVersions('nope'),
      () => getRequirementVersion(UUID, 0),
      () => transitionRequirement('nope', { status: 'draft', expectedRevision: 1, actor: 'a', summary: 'b' }),
    ]) {
      await assert.rejects(call(), (e: unknown) => e instanceof ApiError && e.status === 400);
    }
  } finally { globalThis.fetch = original; }
});

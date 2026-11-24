import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ApiError, renameProject } from '../src/api/client.js';

const id = '12345678-1234-4234-8234-123456789abc';
const stored = {
  id, slug: 'cmdb', name: 'CMDB', repo_root: '/tmp/cmdb', default_branch: 'main', revision: 2,
  created_at: '2026-11-20T00:00:00Z', updated_at: '2026-11-25T00:00:00Z',
};

test('rename sends the name with the loaded revision and validates the stored answer', async () => {
  const original = globalThis.fetch;
  try {
    globalThis.fetch = async (url, init) => {
      assert.equal(url, `/api/projects/${id}`);
      assert.equal(init?.method, 'PATCH');
      assert.equal(init?.cache, 'no-store');
      assert.equal(new Headers(init?.headers).get('Content-Type'), 'application/json');
      assert.deepEqual(JSON.parse(String(init?.body)), { name: 'CMDB v2', revision: 1 });
      return new Response(JSON.stringify(stored), { status: 200 });
    };
    assert.deepEqual(await renameProject(id, { name: 'CMDB v2', revision: 1 }), stored);
  } finally { globalThis.fetch = original; }
});

test('rename refuses malformed input before any request', async () => {
  const original = globalThis.fetch;
  try {
    globalThis.fetch = async () => { throw new Error('unexpected network request'); };
    for (const invalid of ['', 'not-a-uuid', `${id}/status`]) {
      await assert.rejects(renameProject(invalid, { name: 'New', revision: 1 }),
        (e: unknown) => e instanceof ApiError && e.status === 400);
    }
    for (const revision of [-1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1]) {
      await assert.rejects(renameProject(id, { name: 'New', revision }),
        (e: unknown) => e instanceof ApiError && e.status === 409);
    }
    for (const name of ['', '   ', 'x'.repeat(121)]) {
      await assert.rejects(renameProject(id, { name, revision: 1 }),
        (e: unknown) => e instanceof ApiError && e.status === 400);
    }
  } finally { globalThis.fetch = original; }
});

test('rename reports stale, missing and invalid answers without exposing the server body', async () => {
  const original = globalThis.fetch;
  try {
    for (const [status, expected] of [[409, /已被其他操作修改/], [404, /项目不存在/], [400, /项目名称无效/]] as const) {
      globalThis.fetch = async () => new Response('SECRET_/private/repo', { status });
      await assert.rejects(renameProject(id, { name: 'New', revision: 1 }),
        (e: unknown) => e instanceof ApiError && e.status === status && expected.test(e.message));
    }
    globalThis.fetch = async () => new Response('SECRET_/private/repo', { status: 500 });
    await assert.rejects(renameProject(id, { name: 'New', revision: 1 }),
      (e: unknown) => e instanceof ApiError && e.status === 500 && !e.message.includes('SECRET_'));
    globalThis.fetch = async () => new Response(JSON.stringify({ id: 'bad' }), { status: 200 });
    await assert.rejects(renameProject(id, { name: 'New', revision: 1 }), ApiError);
    globalThis.fetch = async () => { throw new TypeError('ECONNRESET private host'); };
    await assert.rejects(renameProject(id, { name: 'New', revision: 1 }), /无法连接本地 API/);
  } finally { globalThis.fetch = original; }
});

test('rename preserves request cancellation', async () => {
  const original = globalThis.fetch;
  try {
    const controller = new AbortController();
    globalThis.fetch = async () => { controller.abort(); throw new DOMException('aborted', 'AbortError'); };
    await assert.rejects(renameProject(id, { name: 'New', revision: 1 }, controller.signal),
      (e: unknown) => e instanceof DOMException && e.name === 'AbortError');
  } finally { globalThis.fetch = original; }
});

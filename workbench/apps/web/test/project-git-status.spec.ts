import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ApiError, decodeProjectGitStatus, getProjectStatus } from '../src/api/client.js';

const id = '12345678-1234-4234-8234-123456789abc';
const status = { repoRoot: '/tmp/cmdb', headSha: 'a'.repeat(40), branch: 'main', dirty: true };

test('project Git status decoder accepts committed and unborn repositories', () => {
  assert.deepEqual(decodeProjectGitStatus(status), status);
  const unborn = { ...status, headSha: null, branch: 'feature', dirty: false };
  assert.deepEqual(decodeProjectGitStatus(unborn), unborn);
  assert.deepEqual(decodeProjectGitStatus({ ...status, branch: null }), { ...status, branch: null });
});

test('project Git status rejects malformed payloads', () => {
  for (const value of [null, [], {}, { ...status, repoRoot: 'relative' },
    { ...status, headSha: 'secret' }, { ...status, headSha: 123 },
    { ...status, branch: '' }, { ...status, dirty: 'false' }]) {
    assert.throws(() => decodeProjectGitStatus(value), ApiError);
  }
});

test('project Git status requests only a validated persisted ID with abort signal', async () => {
  const original = globalThis.fetch;
  const controller = new AbortController();
  try {
    globalThis.fetch = async (url, init) => {
      assert.equal(url, `/api/projects/${id}/status`);
      assert.equal(init?.signal, controller.signal);
      assert.equal(init?.cache, 'no-store');
      return new Response(JSON.stringify(status), { status: 200 });
    };
    assert.deepEqual(await getProjectStatus(id, controller.signal), status);
    await assert.rejects(getProjectStatus('../etc/passwd'), (e: unknown) => e instanceof ApiError && e.status === 400);
  } finally { globalThis.fetch = original; }
});

test('project Git status redacts server errors and rejects invalid JSON', async () => {
  const original = globalThis.fetch;
  try {
    for (const code of [404, 409, 500]) {
      globalThis.fetch = async () => new Response('secret=/private/path', { status: code });
      await assert.rejects(getProjectStatus(id), (e: unknown) =>
        e instanceof ApiError && e.status === code && !e.message.includes('secret'));
    }
    globalThis.fetch = async () => new Response('not-json', { status: 200 });
    await assert.rejects(getProjectStatus(id), ApiError);
    globalThis.fetch = async () => new Response(JSON.stringify({ ...status, dirty: null }), { status: 200 });
    await assert.rejects(getProjectStatus(id), ApiError);
  } finally { globalThis.fetch = original; }
});

test('project Git status preserves request cancellation', async () => {
  const original = globalThis.fetch;
  const controller = new AbortController();
  try {
    globalThis.fetch = async () => { controller.abort(); throw new DOMException('aborted', 'AbortError'); };
    await assert.rejects(getProjectStatus(id, controller.signal),
      (e: unknown) => e instanceof DOMException && e.name === 'AbortError');
  } finally { globalThis.fetch = original; }
});

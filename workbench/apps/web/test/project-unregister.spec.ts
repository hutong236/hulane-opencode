import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ApiError, unregisterProject } from '../src/api/client.js';

const id = '12345678-1234-4234-8234-123456789abc';

test('unregister sends DELETE for persisted UUID and accepts empty 204', async () => {
  const original = globalThis.fetch;
  try {
    globalThis.fetch = async (url, init) => {
      assert.equal(url, `/api/projects/${id}`);
      assert.equal(init?.method, 'DELETE');
      assert.equal(init?.cache, 'no-store');
      assert.equal(init?.body, undefined);
      return new Response(null, { status: 204 });
    };
    assert.equal(await unregisterProject(id), undefined);
  } finally { globalThis.fetch = original; }
});

test('unregister rejects malformed identifiers before fetch', async () => {
  const original = globalThis.fetch;
  try {
    globalThis.fetch = async () => { throw new Error('unexpected network'); };
    for (const invalid of ['', '../etc/passwd', 'not-a-uuid', id + '/status']) {
      await assert.rejects(unregisterProject(invalid), (e: unknown) => e instanceof ApiError && e.status === 400);
    }
  } finally { globalThis.fetch = original; }
});

test('unregister sanitizes errors and rejects unexpected success responses', async () => {
  const original = globalThis.fetch;
  try {
    for (const status of [404, 409, 500]) {
      globalThis.fetch = async () => new Response('private filesystem path /secret', { status });
      await assert.rejects(unregisterProject(id), (e: unknown) =>
        e instanceof ApiError && e.status === status && !e.message.includes('/secret'));
    }
    globalThis.fetch = async () => new Response('{}', { status: 200 });
    await assert.rejects(unregisterProject(id), (e: unknown) => e instanceof ApiError && e.status === 200);
  } finally { globalThis.fetch = original; }
});

test('unregister preserves cancellation and sanitizes network errors', async () => {
  const original = globalThis.fetch;
  try {
    const controller = new AbortController();
    globalThis.fetch = async () => { controller.abort(); throw new DOMException('aborted', 'AbortError'); };
    await assert.rejects(unregisterProject(id, controller.signal),
      (e: unknown) => e instanceof DOMException && e.name === 'AbortError');
    globalThis.fetch = async () => { throw new Error('private host and token'); };
    await assert.rejects(unregisterProject(id),
      (e: unknown) => e instanceof ApiError && !e.message.includes('token'));
  } finally { globalThis.fetch = original; }
});

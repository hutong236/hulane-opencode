import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ApiError, getProjects, requestJson } from '../src/api/client.js';

test('project list request stays same-origin and does not send credentials', async () => {
  const previous = globalThis.fetch;
  try {
    globalThis.fetch = async (input, init) => {
      assert.equal(input, '/api/projects');
      assert.equal(init?.cache, 'no-store');
      assert.equal(init?.headers && (init.headers as Record<string, string>).Accept, 'application/json');
      assert.equal(init?.credentials, undefined);
      assert.equal(init?.method, undefined);
      return new Response(JSON.stringify({ projects: [] }), { status: 200 });
    };
    assert.deepEqual(await getProjects(), []);
  } finally {
    globalThis.fetch = previous;
  }
});

test('generic JSON client rejects non-API and external URLs before fetch', async () => {
  const previous = globalThis.fetch;
  let called = false;
  try {
    globalThis.fetch = async () => {
      called = true;
      throw new Error('unexpected network call');
    };
    for (const path of ['https://example.invalid/api/projects', '//example.invalid/api/projects', '/projects', '/api']) {
      await assert.rejects(requestJson(path, value => value), (error: unknown) =>
        error instanceof ApiError && /非本地/.test(error.message));
    }
    assert.equal(called, false);
  } finally {
    globalThis.fetch = previous;
  }
});

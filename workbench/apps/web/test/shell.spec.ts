import assert from 'node:assert/strict';
import test from 'node:test';
import { sections, defaultSection, getSection, isSection } from '../src/routes.ts';
import { getHealth, requestJson, ApiError } from '../src/api/client.ts';

test('six route paths are unique, support reload and trailing slash', () => {
  assert.equal(sections.length, 6);
  assert.equal(new Set(sections.map(x => x.path)).size, 6);
  for (const item of sections) {
    assert.equal(getSection(item.path), item);
    assert.equal(getSection(`${item.path}/`), item);
    assert.equal(isSection(item.path), true);
  }
  assert.equal(getSection('/missing'), defaultSection);
  assert.equal(isSection('/missing'), false);
});

test('API status is validated', async () => {
  const oldFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ status: 'ok', service: 'hulane-workbench-api' }));
  try { assert.deepEqual(await getHealth(), { status: 'ok', service: 'hulane-workbench-api' }); }
  finally { globalThis.fetch = oldFetch; }
});

test('API 500 and offline/invalid data do not look successful', async () => {
  const oldFetch = globalThis.fetch;
  try {
    globalThis.fetch = async () => new Response('error', { status: 500 });
    await assert.rejects(getHealth(), (err: unknown) => err instanceof ApiError && err.status === 500);
    globalThis.fetch = async () => { throw new Error('ECONNREFUSED'); };
    await assert.rejects(getHealth(), /无法连接本地 API/);
    globalThis.fetch = async () => new Response('not json', { status: 200 });
    await assert.rejects(getHealth(), /无效 JSON/);
    globalThis.fetch = async () => new Response(JSON.stringify({ status: 'error' }), { status: 200 });
    await assert.rejects(getHealth(), /结构不正确/);
  } finally { globalThis.fetch = oldFetch; }
});

test('client rejects external URLs', async () => {
  await assert.rejects(requestJson('https://example.invalid/', x => x), /禁止访问非本地/);
});

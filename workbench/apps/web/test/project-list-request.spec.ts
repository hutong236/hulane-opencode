import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ApiError, getProjects } from '../src/api/client.js';

test('project list retries a failed request and accepts an empty result', async () => {
  const previous = globalThis.fetch;
  const paths: string[] = [];
  let attempt = 0;
  try {
    globalThis.fetch = async (input, init) => {
      paths.push(String(input));
      assert.equal(init?.cache, 'no-store');
      attempt++;
      if (attempt === 1) return new Response('unavailable', { status: 503 });
      return new Response(JSON.stringify({ projects: [] }), { status: 200 });
    };
    await assert.rejects(getProjects(), (error: unknown) =>
      error instanceof ApiError && error.status === 503);
    assert.deepEqual(await getProjects(), []);
    assert.deepEqual(paths, ['/api/projects', '/api/projects']);
  } finally { globalThis.fetch = previous; }
});

test('aborted project list request preserves AbortError', async () => {
  const previous = globalThis.fetch;
  const controller = new AbortController();
  try {
    globalThis.fetch = async (_input, init) => {
      assert.equal(init?.signal, controller.signal);
      controller.abort();
      throw new DOMException('aborted', 'AbortError');
    };
    await assert.rejects(getProjects(controller.signal), (error: unknown) =>
      error instanceof DOMException && error.name === 'AbortError');
  } finally { globalThis.fetch = previous; }
});

test('invalid project payload cannot be treated as success', async () => {
  const previous = globalThis.fetch;
  try {
    globalThis.fetch = async () => new Response(JSON.stringify({ projects: [{ id: 'invalid' }] }));
    await assert.rejects(getProjects(), (error: unknown) =>
      error instanceof ApiError && /结构不正确/.test(error.message));
  } finally { globalThis.fetch = previous; }
});


test('project list rejects malformed JSON and can recover on the next request', async () => {
  const previous = globalThis.fetch;
  let attempts = 0;
  try {
    globalThis.fetch = async () => {
      attempts++;
      return attempts === 1
        ? new Response('{invalid', { status: 200, headers: { 'content-type': 'application/json' } })
        : new Response(JSON.stringify({ projects: [] }), { status: 200 });
    };
    await assert.rejects(getProjects(), (error: unknown) =>
      error instanceof ApiError && /无效 JSON/.test(error.message));
    assert.deepEqual(await getProjects(), []);
    assert.equal(attempts, 2);
  } finally { globalThis.fetch = previous; }
});

test('project list transport errors do not expose raw failure details', async () => {
  const previous = globalThis.fetch;
  try {
    globalThis.fetch = async () => { throw new Error('private credential and local path'); };
    await assert.rejects(getProjects(), (error: unknown) =>
      error instanceof ApiError &&
      /无法连接本地 API/.test(error.message) &&
      !/private credential|local path/.test(error.message));
  } finally { globalThis.fetch = previous; }
});

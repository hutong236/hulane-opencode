import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ApiError, registerProject } from '../src/api/client.js';

const project = {
  id: '12345678-1234-4234-8234-123456789abc', slug: 'cmdb', name: 'CMDB',
  repo_root: '/tmp/cmdb', default_branch: 'main', remote_url: null, revision: 0,
  created_at: '2026-11-20T00:00:00Z', updated_at: '2026-11-20T00:00:00Z',
};

test('registration posts JSON to local API and validates persisted response', async () => {
  const original = globalThis.fetch;
  try {
    globalThis.fetch = async (url, init) => {
      assert.equal(url, '/api/projects');
      assert.equal(init?.method, 'POST');
      assert.equal(init?.cache, 'no-store');
      assert.equal(new Headers(init?.headers).get('Content-Type'), 'application/json');
      assert.deepEqual(JSON.parse(String(init?.body)), { path: '/tmp/cmdb', slug: 'cmdb', name: 'CMDB' });
      return new Response(JSON.stringify(project), { status: 201 });
    };
    assert.deepEqual(await registerProject({ path: '/tmp/cmdb', slug: 'cmdb', name: 'CMDB' }), project);
  } finally { globalThis.fetch = original; }
});

test('registration rejects invalid input without a request', async () => {
  const original = globalThis.fetch;
  try {
    globalThis.fetch = async () => { throw new Error('unexpected network request'); };
    await assert.rejects(registerProject({ path: 'relative', slug: 'cmdb', name: 'CMDB' }), (e: unknown) => e instanceof ApiError && e.status === 400);
    await assert.rejects(registerProject({ path: '/tmp/cmdb', slug: 'BAD', name: 'CMDB' }), (e: unknown) => e instanceof ApiError && e.status === 400);
  } finally { globalThis.fetch = original; }
});

test('registration rejects duplicate or unsafe roots without exposing server body', async () => {
  const original = globalThis.fetch;
  try {
    for (const status of [400, 409]) {
      globalThis.fetch = async () => new Response('secret=/private/token', { status });
      await assert.rejects(registerProject({ path: '/tmp/cmdb', slug: 'cmdb', name: 'CMDB' }), (e: unknown) =>
        e instanceof ApiError && e.status === status && !e.message.includes('secret'));
    }
  } finally { globalThis.fetch = original; }
});

test('registration rejects malformed success payload and preserves abort', async () => {
  const original = globalThis.fetch;
  try {
    globalThis.fetch = async () => new Response(JSON.stringify({ id: 'bad' }), { status: 201 });
    await assert.rejects(registerProject({ path: '/tmp/cmdb', slug: 'cmdb', name: 'CMDB' }), ApiError);
    const controller = new AbortController();
    globalThis.fetch = async () => { controller.abort(); throw new DOMException('aborted', 'AbortError'); };
    await assert.rejects(registerProject({ path: '/tmp/cmdb', slug: 'cmdb', name: 'CMDB' }, controller.signal),
      (e: unknown) => e instanceof DOMException && e.name === 'AbortError');
  } finally { globalThis.fetch = original; }
});

test('registration tells which kind of problem the API named, and never shows its raw text', async () => {
  const original = globalThis.fetch;
  const input = { path: '/private/secret/repo', slug: 'cmdb', name: 'CMDB' };
  try {
    for (const [reason, message] of [
      ['missing', '目录不存在'],
      ['not_directory', '该路径不是目录'],
      ['symlink', '路径中包含符号链接，请使用真实路径'],
      ['unreadable', '没有读取该目录的权限'],
      ['not_git_root', '该目录不是 Git 仓库的根目录'],
      ['not_absolute', '必须使用绝对路径'],
    ]) {
      globalThis.fetch = async () => new Response(JSON.stringify({ error: 'Invalid Git repository root', reason }), { status: 400 });
      await assert.rejects(registerProject(input), (e: unknown) => e instanceof ApiError && e.status === 400 && e.message === message);
    }
    // A reason the page does not know, a body that is not JSON, and a 400 for another cause all get the general message.
    globalThis.fetch = async () => new Response(JSON.stringify({ error: 'Invalid project registration' }), { status: 400 });
    await assert.rejects(registerProject(input), /仓库路径或登记信息无效/);
    globalThis.fetch = async () => new Response(JSON.stringify({ error: 'x', reason: '/private/secret/repo' }), { status: 400 });
    await assert.rejects(registerProject(input),
      (e: unknown) => e instanceof ApiError && e.message === '仓库路径或登记信息无效');
    globalThis.fetch = async () => new Response('PRIVATE /private/secret/repo', { status: 400 });
    await assert.rejects(registerProject(input),
      (e: unknown) => e instanceof ApiError && e.message === '仓库路径或登记信息无效');
    // "constructor" is a key of every object: it must not be mistaken for a known reason.
    globalThis.fetch = async () => new Response(JSON.stringify({ reason: 'constructor' }), { status: 400 });
    await assert.rejects(registerProject(input), /仓库路径或登记信息无效/);
  } finally { globalThis.fetch = original; }
});

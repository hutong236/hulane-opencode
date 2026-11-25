import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ApiError, decodeProjectList } from '../src/api/client.js';

const valid = {
  id: '12345678-1234-1234-1234-123456789abc',
  slug: 'demo-project',
  name: 'Demo',
  repo_root: '/tmp/demo',
  default_branch: 'main',
  remote_url: null,
  revision: 0,
  created_at: '2026-11-19T00:00:00.000Z',
  updated_at: '2026-11-19T00:00:00.000Z',
};

test('project list accepts an empty list and a valid persisted project', () => {
  assert.deepEqual(decodeProjectList({ projects: [] }), []);
  assert.deepEqual(decodeProjectList({ projects: [valid] }), [valid]);
});

test('project list rejects malformed records and duplicate IDs', () => {
  for (const value of [
    null, {}, { projects: null }, { projects: {} },
    { projects: [null] }, { projects: [{ ...valid, id: 'bad' }] },
    { projects: [{ ...valid, revision: -1 }] },
    { projects: [{ ...valid, repo_root: 'relative' }] },
    { projects: [{ ...valid, name: '' }] },
    { projects: [valid, valid] },
  ]) assert.throws(() => decodeProjectList(value), ApiError);
});

test('a remote is null or a non-empty address, and a missing field is not accepted', () => {
  const url = 'https://github.com/example/cmdb.git';
  assert.deepEqual(decodeProjectList({ projects: [{ ...valid, remote_url: url }] }), [{ ...valid, remote_url: url }]);
  assert.deepEqual(decodeProjectList({ projects: [valid] }), [valid]);
  for (const remote_url of [undefined, '', '   ', 42, false, { url }, ['x']]) {
    assert.throws(() => decodeProjectList({ projects: [{ ...valid, remote_url }] }), ApiError, String(remote_url));
  }
  const { remote_url, ...withoutField } = valid;
  assert.throws(() => decodeProjectList({ projects: [withoutField] }), ApiError);
});

test('credentials in a remote address are never passed on to the page', () => {
  // The API strips them before storing. Should one slip through, the list must not display it.
  const leaking = 'https://x-access-token:ghp_SECRET@github.com/example/cmdb.git';
  const decoded = JSON.stringify(decodeProjectList({ projects: [{ ...valid, remote_url: leaking }] }));
  assert.ok(decoded.includes('https://github.com/example/cmdb.git'));
  assert.equal(decoded.includes('ghp_SECRET'), false);
  assert.equal(decoded.includes('x-access-token'), false);
  // The scp-like form and a local path carry no password and stay as they are.
  assert.deepEqual(decodeProjectList({ projects: [{ ...valid, remote_url: 'git@github.com:example/cmdb.git' }] }),
    [{ ...valid, remote_url: 'git@github.com:example/cmdb.git' }]);
  // An address with a scheme that cannot be parsed is refused rather than shown unchecked.
  assert.throws(() => decodeProjectList({ projects: [{ ...valid, remote_url: 'https://[not-a-valid-host/x' }] }), ApiError);
});

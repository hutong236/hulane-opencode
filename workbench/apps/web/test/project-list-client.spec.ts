import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ApiError, decodeProjectList } from '../src/api/client.js';

const valid = {
  id: '12345678-1234-1234-1234-123456789abc',
  slug: 'demo-project',
  name: 'Demo',
  repo_root: '/tmp/demo',
  default_branch: 'main',
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

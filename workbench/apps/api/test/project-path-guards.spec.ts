import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, rm, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { buildApp } from '../src/app.js';
import { fixturePrefix } from './fixture-prefix.js';

test('validation endpoint rejects nested and symlinked Git paths without disclosing local paths', async () => {
  const temp = await mkdtemp(fixturePrefix('wb-api-path-guards-'));
  const app = buildApp();
  try {
    const root = join(temp, 'repo');
    const nested = join(root, 'nested');
    const alias = join(temp, 'alias');
    await mkdir(nested, { recursive: true });
    execFileSync('git', ['init', '-q', root]);
    await symlink(root, alias, 'dir');

    const valid = await app.inject({
      method: 'POST', url: '/api/projects/validate', payload: { path: root },
    });
    assert.equal(valid.statusCode, 200);
    assert.deepEqual(valid.json(), { repoRoot: root });

    for (const path of [nested, alias, join(alias, 'nested')]) {
      const response = await app.inject({
        method: 'POST', url: '/api/projects/validate', payload: { path },
      });
      assert.equal(response.statusCode, 400, `unsafe path should be rejected: ${path}`);
      assert.deepEqual(response.json(), { error: 'Invalid Git repository root' });
      assert.ok(!response.body.includes(temp), 'must not leak local filesystem paths');
    }
  } finally {
    await app.close();
    await rm(temp, { recursive: true, force: true });
  }
});

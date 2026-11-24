import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { buildApp } from '../src/app.js';
import { fixturePrefix } from './fixture-prefix.js';

test('repository validation API accepts a real root and fails closed for invalid input', async () => {
  const temp = await mkdtemp(fixturePrefix('wb-project-api-'));
  const app = buildApp();
  try {
    const root = join(temp, 'repo');
    await mkdir(root);
    execFileSync('git', ['init', '-q', root]);
    const valid = await app.inject({ method: 'POST', url: '/api/projects/validate', payload: { path: root } });
    assert.equal(valid.statusCode, 200);
    assert.deepEqual(valid.json(), { repoRoot: root });

    for (const payload of [{}, { path: 123 }, { path: temp }, { path: 'relative/path' }]) {
      const invalid = await app.inject({ method: 'POST', url: '/api/projects/validate', payload });
      assert.equal(invalid.statusCode, 400);
      assert.equal(typeof invalid.json().error, 'string');
      assert.ok(!invalid.body.includes(temp), 'must not leak local paths');
    }
  } finally {
    await app.close();
    await rm(temp, { recursive: true, force: true });
  }
});

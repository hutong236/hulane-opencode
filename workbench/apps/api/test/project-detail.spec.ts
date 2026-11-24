import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { WorkbenchDatabase } from '@hulane/workbench-database';
import { buildApp } from '../src/app.js';

test('project detail returns persisted metadata and safe 400/404 errors', async () => {
  const temp = mkdtempSync(join(tmpdir(), 'wb-project-detail-'));
  const repo = join(temp, 'repo');
  execFileSync('git', ['init', '-q', repo]);
  const db = new WorkbenchDatabase({ dataDirectory: join(temp, 'data') });
  const app = buildApp({ database: db });
  try {
    const registered = await app.inject({
      method: 'POST', url: '/api/projects',
      payload: { path: repo, slug: 'detail-1', name: 'Detail project' },
    });
    assert.equal(registered.statusCode, 201);
    const created = registered.json();
    const detail = await app.inject({ method: 'GET', url: '/api/projects/' + created.id });
    assert.equal(detail.statusCode, 200);
    assert.deepEqual(detail.json(), created);
    const malformed = await app.inject({ method: 'GET', url: '/api/projects/not-a-uuid' });
    assert.equal(malformed.statusCode, 400);
    assert.ok(!malformed.body.includes(temp));
    const missing = await app.inject({
      method: 'GET', url: '/api/projects/00000000-0000-4000-8000-000000000000',
    });
    assert.equal(missing.statusCode, 404);
    assert.ok(!missing.body.includes(temp));
  } finally {
    await app.close();
    db.close();
    rmSync(temp, { recursive: true, force: true });
  }
});

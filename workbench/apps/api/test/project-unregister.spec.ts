import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { WorkbenchDatabase } from '@hulane/workbench-database';
import { buildApp } from '../src/app.js';

test('unregister removes SQLite metadata only and preserves Git repository files', async () => {
  const temp = mkdtempSync(join(tmpdir(), 'wb-unregister-'));
  const repo = join(temp, 'repo');
  const db = new WorkbenchDatabase({ dataDirectory: join(temp, 'data') });
  const app = buildApp({ database: db });
  try {
    execFileSync('git', ['init', '-q', repo]);
    const marker = join(repo, 'keep-me.txt');
    writeFileSync(marker, 'repository data must survive');
    const created = await app.inject({
      method: 'POST', url: '/api/projects',
      payload: { path: repo, slug: 'safe-delete', name: 'Safe delete' },
    });
    assert.equal(created.statusCode, 201);
    const id: string = created.json().id;
    const invalid = await app.inject({ method: 'DELETE', url: '/api/projects/not-a-uuid' });
    assert.equal(invalid.statusCode, 400);
    assert.ok(!invalid.body.includes(repo));
    assert.equal((await app.inject({ method: 'GET', url: '/api/projects/' + id })).statusCode, 200);
    const deleted = await app.inject({ method: 'DELETE', url: '/api/projects/' + id });
    assert.equal(deleted.statusCode, 204);
    assert.equal(deleted.body, '');
    assert.equal((await app.inject({ method: 'GET', url: '/api/projects/' + id })).statusCode, 404);
    const missing = await app.inject({ method: 'DELETE', url: '/api/projects/' + id });
    assert.equal(missing.statusCode, 404);
    assert.ok(!missing.body.includes(repo));
    assert.equal(readFileSync(marker, 'utf8'), 'repository data must survive');
    assert.ok(existsSync(join(repo, '.git')));
    assert.deepEqual((await app.inject({ method: 'GET', url: '/api/projects' })).json(), { projects: [] });
  } finally {
    await app.close();
    db.close();
    rmSync(temp, { recursive: true, force: true });
  }
});

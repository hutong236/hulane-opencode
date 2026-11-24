import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { WorkbenchDatabase } from '@hulane/workbench-database';
import { buildApp } from '../src/app.js';

test('persisted project ID status reports Git changes and fails closed on missing roots', async () => {
  const temp = mkdtempSync(join(tmpdir(), 'wb-status-id-'));
  const repo = join(temp, 'repo');
  execFileSync('git', ['init', '-q', repo]);
  execFileSync('git', ['-C', repo, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid',
    'commit', '--allow-empty', '-qm', 'initial']);
  const db = new WorkbenchDatabase({ dataDirectory: join(temp, 'data') });
  const app = buildApp({ database: db });
  try {
    const registered = await app.inject({ method: 'POST', url: '/api/projects',
      payload: { path: repo, slug: 'status-id', name: 'Status by ID' } });
    assert.equal(registered.statusCode, 201);
    const id = registered.json().id as string;
    const url = '/api/projects/' + id + '/status';
    const clean = await app.inject({ method: 'GET', url });
    assert.equal(clean.statusCode, 200);
    assert.equal(clean.json().dirty, false);
    assert.equal(clean.json().headSha, execFileSync('git', ['-C', repo, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim());
    writeFileSync(join(repo, 'new.txt'), 'dirty');
    assert.equal((await app.inject({ method: 'GET', url })).json().dirty, true);

    for (const [invalid, expected] of [
      ['/api/projects/not-a-uuid/status', 400],
      ['/api/projects/00000000-0000-4000-8000-000000000000/status', 404],
    ] as const) {
      const response = await app.inject({ method: 'GET', url: invalid });
      assert.equal(response.statusCode, expected);
      assert.ok(!response.body.includes(temp));
    }
    rmSync(repo, { recursive: true, force: true });
    const stale = await app.inject({ method: 'GET', url });
    assert.equal(stale.statusCode, 409);
    assert.ok(!stale.body.includes(temp), 'do not expose local paths');
  } finally {
    await app.close();
    db.close();
    rmSync(temp, { recursive: true, force: true });
  }
});

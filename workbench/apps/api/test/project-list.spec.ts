import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { WorkbenchDatabase } from '@hulane/workbench-database';
import { buildApp } from '../src/app.js';
import { fixturePrefix } from './fixture-prefix.js';

test('project listing returns persisted projects in stable order without touching repositories', async () => {
  const temp = mkdtempSync(fixturePrefix('wb-project-list-'));
  const db = new WorkbenchDatabase({ dataDirectory: join(temp, 'data') });
  const app = buildApp({ database: db });
  try {
    const empty = await app.inject({ method: 'GET', url: '/api/projects' });
    assert.equal(empty.statusCode, 200);
    assert.deepEqual(empty.json(), { projects: [] });
    const created = [];
    for (const slug of ['list-one', 'list-two']) {
      const repo = join(temp, slug);
      execFileSync('git', ['init', '-q', repo]);
      const response = await app.inject({
        method: 'POST', url: '/api/projects',
        payload: { path: repo, slug, name: slug },
      });
      assert.equal(response.statusCode, 201);
      created.push(response.json());
    }
    const listed = await app.inject({ method: 'GET', url: '/api/projects' });
    assert.equal(listed.statusCode, 200);
    assert.deepEqual(listed.json().projects.map((p: { id: string }) => p.id), created.map(p => p.id));
    assert.deepEqual(listed.json().projects, created);
    assert.ok(!listed.body.includes('git stderr'));
  } finally {
    await app.close();
    db.close();
    rmSync(temp, { recursive: true, force: true });
  }
});

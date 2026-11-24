import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { WorkbenchDatabase } from '@hulane/workbench-database';
import { buildApp } from '../src/app.js';
import { fixturePrefix } from './fixture-prefix.js';

test('project registration validates, rejects duplicates and persists after database reopen', async () => {
  const temp = mkdtempSync(fixturePrefix('wb-register-'));
  const repo = join(temp, 'repo');
  execFileSync('git', ['init', '-q', repo]);
  const dataDirectory = join(temp, 'data');
  let db = new WorkbenchDatabase({ dataDirectory });
  let app = buildApp({ database: db });
  try {
    const invalid = await app.inject({ method: 'POST', url: '/api/projects', payload: { path: join(repo, 'missing'), slug: 'repo-1', name: 'Test' } });
    assert.equal(invalid.statusCode, 400);
    assert.ok(!invalid.body.includes(temp));
    const created = await app.inject({ method: 'POST', url: '/api/projects', payload: { path: repo, slug: 'repo-1', name: 'Test' } });
    assert.equal(created.statusCode, 201);
    const project = created.json();
    assert.equal(project.repo_root, repo);
    const duplicate = await app.inject({ method: 'POST', url: '/api/projects', payload: { path: repo, slug: 'repo-2', name: 'Again' } });
    assert.equal(duplicate.statusCode, 409);
    assert.ok(!duplicate.body.includes(temp));
    await app.close();
    db.close();
    db = new WorkbenchDatabase({ dataDirectory });
    app = buildApp({ database: db });
    assert.equal(db.projects.find(project.id)?.slug, 'repo-1');
  } finally {
    await app.close();
    db.close();
    rmSync(temp, { recursive: true, force: true });
  }
});

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { WorkbenchDatabase } from '@hulane/workbench-database';
import { buildApp } from '../src/app.js';
import { fixturePrefix } from './fixture-prefix.js';

type App = ReturnType<typeof buildApp>;
type Project = { id: string; revision: number; name: string; repo_root: string; updated_at: string };
const patch = (app: App, url: string, payload: unknown) => app.inject({ method: 'PATCH', url, payload: payload as never });
const idOfMissing = '00000000-0000-4000-8000-00000000c0de';

async function registered(app: App, temp: string, slug: string, name: string) {
  const repo = join(temp, `repo-${slug}`);
  execFileSync('git', ['init', '-q', repo]);
  const created = await app.inject({ method: 'POST', url: '/api/projects', payload: { path: repo, slug, name } });
  assert.equal(created.statusCode, 201);
  return { repo, project: created.json() as Project };
}

test('renaming changes only the catalog name, bumps the revision and persists', async () => {
  const temp = mkdtempSync(fixturePrefix('wb-rename-'));
  const dataDirectory = join(temp, 'data');
  let db = new WorkbenchDatabase({ dataDirectory });
  let app = buildApp({ database: db });
  let first: Pick<Project, 'id' | 'revision'>;
  try {
    const { repo, project } = await registered(app, temp, 'rename', 'Before');
    first = project;
    const renamed = await patch(app, `/api/projects/${project.id}`, { name: '  After  ', revision: project.revision });
    assert.equal(renamed.statusCode, 200);
    // Surrounding whitespace is not part of the name; nothing else about the registration changes.
    assert.deepEqual(renamed.json(), { ...project, name: 'After', revision: project.revision + 1, updated_at: renamed.json().updated_at });
    assert.notEqual(renamed.json().updated_at, project.updated_at);
    const again = await patch(app, `/api/projects/${project.id}`, { name: 'Third', revision: project.revision + 1 });
    assert.equal(again.json().name, 'Third');
    assert.equal(again.json().revision, project.revision + 2);
    const listed = (await app.inject({ method: 'GET', url: '/api/projects' })).json().projects;
    assert.equal(listed.length, 1);
    assert.equal(listed[0].name, 'Third');
    assert.equal(execFileSync('git', ['-C', repo, 'status', '--porcelain'], { encoding: 'utf8' }), '', 'the repository is untouched');
  } finally {
    await app.close();
    db.close();
  }
  db = new WorkbenchDatabase({ dataDirectory });
  app = buildApp({ database: db });
  try {
    const detail = (await app.inject({ method: 'GET', url: `/api/projects/${first.id}` })).json();
    assert.equal(detail.name, 'Third');
    assert.equal(detail.revision, first.revision + 2);
  } finally {
    await app.close();
    db.close();
    rmSync(temp, { recursive: true, force: true });
  }
});

test('a stale revision is refused instead of overwriting a newer name', async () => {
  const temp = mkdtempSync(fixturePrefix('wb-rename-stale-'));
  const db = new WorkbenchDatabase({ dataDirectory: join(temp, 'data') });
  const app = buildApp({ database: db });
  try {
    const { project } = await registered(app, temp, 'stale', 'First');
    const url = `/api/projects/${project.id}`;
    assert.equal((await patch(app, url, { name: 'Second', revision: project.revision })).statusCode, 200);
    // The same request replayed, and an editor who loaded the row before the first rename: both are refused.
    for (let attempt = 0; attempt < 2; attempt++) {
      const stale = await patch(app, url, { name: 'Must not be stored', revision: project.revision });
      assert.equal(stale.statusCode, 409);
      assert.ok(!stale.body.includes(temp));
    }
    // A revision the row never had is refused as well.
    assert.equal((await patch(app, url, { name: 'Must not be stored', revision: project.revision + 5 })).statusCode, 409);
    const current = (await app.inject({ method: 'GET', url })).json();
    assert.equal(current.name, 'Second');
    assert.equal(current.revision, project.revision + 1);
  } finally {
    await app.close();
    db.close();
    rmSync(temp, { recursive: true, force: true });
  }
});

test('invalid, unknown and malformed renames change nothing and disclose no local path', async () => {
  const temp = mkdtempSync(fixturePrefix('wb-rename-invalid-'));
  const db = new WorkbenchDatabase({ dataDirectory: join(temp, 'data') });
  const app = buildApp({ database: db });
  try {
    const { project } = await registered(app, temp, 'invalid', 'Kept');
    const url = `/api/projects/${project.id}`;
    for (const [payload, expected] of [
      [{ name: '   ', revision: project.revision }, 400],
      [{ name: '', revision: project.revision }, 400],
      [{ name: 'x'.repeat(121), revision: project.revision }, 400],
      [{ name: 'No revision' }, 400],
      [{ name: 'Fraction', revision: 0.5 }, 400],
      [{ name: 'String', revision: `${project.revision}` }, 400],
      [{ name: 'Negative', revision: -1 }, 400],
      [{ name: 42, revision: project.revision }, 400],
      [[], 400],
    ] as const) {
      const response = await patch(app, url, payload);
      assert.equal(response.statusCode, expected, JSON.stringify(payload));
      assert.ok(!response.body.includes(temp));
    }
    assert.equal((await app.inject({ method: 'PATCH', url })).statusCode, 400, 'a request without a body');
    assert.equal((await patch(app, '/api/projects/not-a-uuid', { name: 'Nope', revision: project.revision })).statusCode, 400);
    const missing = await patch(app, `/api/projects/${idOfMissing}`, { name: 'Nope', revision: project.revision });
    assert.equal(missing.statusCode, 404);
    assert.ok(!missing.body.includes(temp));
    const detail = (await app.inject({ method: 'GET', url })).json();
    assert.equal(detail.name, 'Kept');
    assert.equal(detail.revision, project.revision);
  } finally {
    await app.close();
    db.close();
    rmSync(temp, { recursive: true, force: true });
  }
});

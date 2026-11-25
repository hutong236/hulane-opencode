import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { WorkbenchDatabase } from '@hulane/workbench-database';
import { buildApp } from '../src/app.js';
import { fixturePrefix } from './fixture-prefix.js';

/** A repository with one commit on `main`. */
function repository(parent: string, name: string): string {
  const repo = join(parent, name);
  execFileSync('git', ['init', '-q', '-b', 'main', repo]);
  writeFileSync(join(repo, 'README.md'), `${name}\n`);
  execFileSync('git', ['-C', repo, 'add', '--', 'README.md']);
  execFileSync('git', ['-C', repo, '-c', 'user.name=Workbench Test', '-c', 'user.email=test@example.invalid',
    '-c', 'commit.gpgsign=false', 'commit', '-qm', 'initial'], { stdio: 'ignore' });
  return repo;
}

async function setup() {
  const temp = mkdtempSync(fixturePrefix('wb-api-tags-'));
  const db = new WorkbenchDatabase({ dataDirectory: join(temp, 'data') });
  const app = buildApp({ database: db });
  const registered = await app.inject({ method: 'POST', url: '/api/projects',
    payload: { path: repository(temp, 'cmdb'), slug: 'cmdb', name: 'CMDB' } });
  assert.equal(registered.statusCode, 201);
  return {
    temp, db, app, id: registered.json().id as string,
    dispose: async () => { await app.close(); db.close(); rmSync(temp, { recursive: true, force: true }); },
  };
}

// The capability and dependency tags are reserved storage: no route reads or writes them yet, WB-007 will. These two
// cases tie that storage to what the API already does, so the one cannot drift away from the other.
test('unregistering a project through the API deletes its tags with it and leaves the repository alone', async () => {
  const { temp, db, app, id, dispose } = await setup();
  try {
    assert.deepEqual(db.projects.updateTags(id, 1, { capability: ['cmdb'], dependency: ['mysql'] }),
      { capability: ['cmdb'], dependency: ['mysql'] });
    assert.equal((await app.inject({ method: 'DELETE', url: `/api/projects/${id}` })).statusCode, 204);
    assert.equal(db.projects.tags(id), null);
    assert.deepEqual(db.projects.taggedWith('capability', 'cmdb'), []);
    // Only the registration and its tags are gone.
    const repo = join(temp, 'cmdb');
    assert.equal(readFileSync(join(repo, 'README.md'), 'utf8'), 'cmdb\n');
    assert.equal(execFileSync('git', ['--no-optional-locks', '-C', repo, 'status', '--porcelain'], { encoding: 'utf8' }), '');
  } finally { await dispose(); }
});

test('a rename from a list loaded before a tag change is refused, and a tag change from before a rename too', async () => {
  const { db, app, id, dispose } = await setup();
  try {
    assert.deepEqual(db.projects.updateTags(id, 1, { capability: ['cmdb'], dependency: [] }), { capability: ['cmdb'], dependency: [] });
    // The list was loaded at revision 1; the tag change moved the project to revision 2.
    const stale = await app.inject({ method: 'PATCH', url: `/api/projects/${id}`, payload: { name: 'Stale', revision: 1 } });
    assert.deepEqual({ status: stale.statusCode, body: stale.json() }, { status: 409, body: { error: 'Project changed since it was loaded' } });
    assert.equal(db.projects.find(id)?.name, 'CMDB');
    const current = await app.inject({ method: 'PATCH', url: `/api/projects/${id}`, payload: { name: 'CMDB Core', revision: 2 } });
    assert.equal(current.statusCode, 200);
    assert.equal(current.json().revision, 3);
    assert.equal(db.projects.find(id)?.name, 'CMDB Core');
    // The rename moved the project to revision 3, so the tag change quoting revision 2 writes nothing.
    assert.equal(db.projects.updateTags(id, 2, { capability: ['inventory'], dependency: [] }), null);
    assert.deepEqual(db.projects.tags(id), { capability: ['cmdb'], dependency: [] });
    assert.equal(db.projects.find(id)?.revision, 3);
  } finally { await dispose(); }
});

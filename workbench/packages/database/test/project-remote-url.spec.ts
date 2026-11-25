import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import Sqlite from 'better-sqlite3';
import { WorkbenchDatabase, applyMigrations, BASE_MIGRATIONS } from '../src/index.ts';

const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');
const directory = (prefix: string) => mkdtempSync(join(realpathSync(tmpdir()), prefix));
const LEGACY_ID = '11111111-1111-4111-8111-111111111111';

test('every shipped migration keeps its published checksum', () => {
  // Editing an applied migration makes every existing database refuse to start with "Migration history mismatch".
  // One dropped letter in an index name slipped through review once before this list existed.
  assert.deepEqual(BASE_MIGRATIONS.map(migration => [migration.version, migration.name, sha256(migration.sql)]), [
    [1, 'workbench_initial_schema', 'd6210700ab7384286754f5529cd7da5a69cd028180d185f13838dc404c4da3ad'],
    [2, 'project_remote_url', '58805dfe62ef81978f83a2ca49f562a6e4176d767ce7c0ea91ce6b34d29f44b6'],
    [3, 'project_tags', '061eb74850dd0fc5663f9cc6d924fcdab4440de388161cc2741b2bdce056745d'],
    [4, 'requirement_version_authors_and_immutability', 'afc91313e7d8512fed1f38fcf173b18af49437589a05a75ccb2db9df7bf29f97'],
  ]);
});

test('a project keeps its default branch and its remote, or no remote at all', () => {
  const dir = directory('wb-remote-url-');
  const database = new WorkbenchDatabase({ dataDirectory: dir });
  try {
    const withRemote = database.projects.create({
      slug: 'cmdb', name: 'CMDB', repoRoot: '/tmp/cmdb', defaultBranch: 'trunk', remoteUrl: 'https://github.com/example/cmdb.git',
    });
    assert.equal(withRemote.default_branch, 'trunk');
    assert.equal(withRemote.remote_url, 'https://github.com/example/cmdb.git');
    assert.equal(database.projects.find(withRemote.id)?.remote_url, 'https://github.com/example/cmdb.git');
    // Left out and null both mean "no origin"; the branch still falls back to main.
    for (const input of [{ slug: 'plain', name: 'Plain', repoRoot: '/tmp/plain' },
      { slug: 'none', name: 'None', repoRoot: '/tmp/none', remoteUrl: null }]) {
      const project = database.projects.create(input);
      assert.equal(project.remote_url, null);
      assert.equal(project.default_branch, 'main');
    }
    // Renaming, listing and finding all carry the column through. Rows created in the same millisecond share a
    // created_at, so the list order falls back to the random id: compare without depending on it.
    database.projects.updateName(withRemote.id, withRemote.revision, 'CMDB Core');
    assert.deepEqual(database.projects.list().map(project => [project.name, project.remote_url]).sort(), [
      ['CMDB Core', 'https://github.com/example/cmdb.git'], ['Plain', null], ['None', null],
    ].sort());
    assert.equal(database.projects.find(withRemote.id)?.name, 'CMDB Core');
  } finally {
    database.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a database from the release before the remote column keeps its projects and gains the column on the next start', () => {
  const dir = directory('wb-remote-upgrade-');
  const file = join(dir, 'workbench.sqlite');
  // A database as the previous release left it: the first migration only and a project registered without a remote.
  const old = new Sqlite(file);
  try {
    applyMigrations(old, BASE_MIGRATIONS.slice(0, 1));
    old.prepare(`INSERT INTO projects(id,slug,name,repo_root,default_branch,created_at,updated_at)
      VALUES (?, 'legacy', 'Legacy', '/tmp/legacy', 'main', '2026-11-01T00:00:00Z', '2026-11-01T00:00:00Z')`).run(LEGACY_ID);
    assert.equal(old.pragma('user_version', { simple: true }), 1);
  } finally { old.close(); }

  const upgraded = new WorkbenchDatabase({ dataDirectory: dir });
  try {
    const legacy = upgraded.projects.find(LEGACY_ID);
    assert.equal(legacy?.name, 'Legacy');
    assert.equal(legacy?.default_branch, 'main', 'a stored default branch is not rewritten by the upgrade');
    assert.equal(legacy?.remote_url, null, 'a project from before the column has no recorded remote');
    assert.deepEqual(upgraded.connection.prepare('SELECT version, sha256 FROM schema_migrations ORDER BY version').all(),
      BASE_MIGRATIONS.map(migration => ({ version: migration.version, sha256: sha256(migration.sql) })));
    assert.equal(upgraded.projects.create({ slug: 'new', name: 'New', repoRoot: '/tmp/new', remoteUrl: 'git@example.com:new.git' }).remote_url,
      'git@example.com:new.git');
    // Starting again on the upgraded file changes nothing.
    assert.equal(applyMigrations(upgraded.connection), BASE_MIGRATIONS.length);
    assert.equal(upgraded.projects.list().length, 2);
  } finally {
    upgraded.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

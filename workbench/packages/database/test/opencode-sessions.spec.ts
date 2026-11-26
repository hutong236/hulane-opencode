import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import Sqlite from 'better-sqlite3';
import { applyMigrations, BASE_MIGRATIONS, EXPECTED_TABLES, WorkbenchDatabase } from '../src/index.ts';

const directory = (prefix: string) => mkdtempSync(join(realpathSync(tmpdir()), prefix));
const ids = (database: WorkbenchDatabase, projectId: string): string[] =>
  database.opencodeSessions.forProject(projectId).map(record => record.session_id);

function fixture(prefix: string) {
  const dir = directory(prefix);
  const database = new WorkbenchDatabase({ dataDirectory: dir });
  const project = database.projects.create({ slug: 'cmdb', name: 'CMDB', repoRoot: '/tmp/cmdb' });
  return {
    dir, database, project,
    dispose: () => { database.close(); rmSync(dir, { recursive: true, force: true }); },
  };
}

test('the sessions a project was given are noted, the newest first, and said to be gone when the server has them no more', () => {
  const { database, project, dispose } = fixture('wb-oc-sessions-');
  try {
    assert.ok(EXPECTED_TABLES.includes('opencode_sessions'), 'the table is not among the required tables');
    assert.deepEqual(database.opencodeSessions.forProject(project.id), []);
    database.opencodeSessions.see(project.id, [
      { id: 'ses_one', title: 'First', created: 1_000 },
      { id: 'ses_two', title: 'Second', created: 2_000 },
    ]);
    const records = database.opencodeSessions.forProject(project.id);
    assert.deepEqual(records.map(record => [record.session_id, record.title, record.on_server]), [
      ['ses_two', 'Second', true], ['ses_one', 'First', true],
    ]);
    assert.equal(records[0].created_at, new Date(2_000).toISOString());

    // Seen again with nothing new: the title and the time of creation are kept, and it is still on the server.
    database.opencodeSessions.see(project.id, [{ id: 'ses_one' }]);
    database.opencodeSessions.onServer(project.id, ['ses_one']);
    assert.deepEqual(database.opencodeSessions.forProject(project.id).map(record => [record.session_id, record.title, record.on_server]), [
      ['ses_two', 'Second', false], ['ses_one', 'First', true],
    ]);
    // Back on the server: said so again.
    database.opencodeSessions.see(project.id, [{ id: 'ses_two', title: 'Renamed', created: 2_000 }]);
    assert.deepEqual(database.opencodeSessions.forProject(project.id).map(record => [record.session_id, record.title, record.on_server]), [
      ['ses_two', 'Renamed', true], ['ses_one', 'First', true],
    ]);
    // A title that is not given does not wipe out the one that was.
    database.opencodeSessions.see(project.id, [{ id: 'ses_two', created: 2_000 }]);
    assert.equal(database.opencodeSessions.forProject(project.id)[0].title, 'Renamed');

    // Two projects keep their sessions apart, and unregistering takes them with the project.
    const other = database.projects.create({ slug: 'other', name: 'Other', repoRoot: '/tmp/other' });
    database.opencodeSessions.see(other.id, [{ id: 'ses_one', title: 'Elsewhere' }]);
    assert.deepEqual([ids(database, project.id), ids(database, other.id)], [['ses_two', 'ses_one'], ['ses_one']]);
    assert.equal(database.opencodeSessions.onServer(other.id, []), 1);
    assert.equal(database.opencodeSessions.onServer(other.id, []), 0, 'taken off the server a second time');
    database.projects.delete(other.id);
    assert.deepEqual(ids(database, other.id), []);

    // An id that is not one is refused, and nothing is noted.
    assert.throws(() => database.opencodeSessions.see(project.id, [{ id: 'not a session' }]), /Invalid OpenCode session id/);
    assert.throws(() => database.opencodeSessions.see(project.id, [{ id: 'x'.repeat(129) }]), /Invalid OpenCode session id/);
    assert.throws(() => database.opencodeSessions.onServer(project.id, ['../..']), /Invalid OpenCode session id/);
    assert.deepEqual(ids(database, project.id), ['ses_two', 'ses_one']);
  } finally { dispose(); }
});

test('a database from the release before the sessions table gains it on the next start and keeps its servers', () => {
  const dir = directory('wb-oc-sessions-upgrade-');
  const file = join(dir, 'workbench.sqlite');
  const old = new Sqlite(file);
  try {
    applyMigrations(old, BASE_MIGRATIONS.slice(0, 5));
    old.prepare(`INSERT INTO projects(id,slug,name,repo_root,default_branch,remote_url,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?)`).run(
      '33333333-3333-4333-8333-333333333333', 'cmdb', 'CMDB', '/tmp/cmdb', 'main', null, '2026-11-01T00:00:00.000Z', '2026-11-01T00:00:00.000Z');
    old.prepare(`INSERT INTO opencode_servers(id, project_id, kind, directory, base_url, version, state, readonly_agent, created_at, updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?)`).run(
      '44444444-4444-4444-8444-444444444444', '33333333-3333-4333-8333-333333333333', 'attached', '/tmp/cmdb', 'http://127.0.0.1:4096',
      '2.2.7', 'stopped', 1, '2026-11-01T00:00:00.000Z', '2026-11-01T00:00:00.000Z');
    const tables = (old.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>).map(row => row.name);
    assert.ok(!tables.includes('opencode_sessions'), 'the old database already has the table');
  } finally { old.close(); }
  const database = new WorkbenchDatabase({ dataDirectory: dir });
  try {
    assert.equal(database.opencodeServers.forProject('33333333-3333-4333-8333-333333333333')?.state, 'stopped');
    database.opencodeSessions.see('33333333-3333-4333-8333-333333333333', [{ id: 'ses_after' }]);
    assert.deepEqual(ids(database, '33333333-3333-4333-8333-333333333333'), ['ses_after']);
    assert.equal(applyMigrations(database.connection), BASE_MIGRATIONS.length);
  } finally { database.close(); rmSync(dir, { recursive: true, force: true }); }
});

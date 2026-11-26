import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import Sqlite from 'better-sqlite3';
import {
  BASE_MIGRATIONS, EXPECTED_TABLES, OPENCODE_SERVER_STATES, WorkbenchDatabase, applyMigrations,
  type NewOpenCodeServer, type OpenCodeServerRecord, type OpenCodeServerState,
} from '../src/index.ts';

const directory = (prefix: string) => mkdtempSync(join(realpathSync(tmpdir()), prefix));
const MANAGED: NewOpenCodeServer = {
  projectId: '', kind: 'managed', directory: '/tmp/cmdb', baseUrl: 'http://127.0.0.1:4096',
  pid: 4321, pidStarted: 'Thu Nov 26 12:17:55 2026', ownerPid: 321, version: '2.2.7', state: 'running',
  readonlyAgent: true, startedAt: '2026-11-26T04:00:00.000Z',
};

function fixture(prefix: string) {
  const dir = directory(prefix);
  const database = new WorkbenchDatabase({ dataDirectory: dir });
  const project = database.projects.create({ slug: 'cmdb', name: 'CMDB', repoRoot: '/tmp/cmdb' });
  return {
    dir, database, project,
    dispose: () => { database.close(); rmSync(dir, { recursive: true, force: true }); },
  };
}
const rows = (database: WorkbenchDatabase): number =>
  (database.connection.prepare('SELECT count(*) AS n FROM opencode_servers').get() as { n: number }).n;

test('a project has one server record, and its next server replaces it under the same id', () => {
  const { database, project, dispose } = fixture('wb-oc-servers-');
  try {
    // Every start checks that the table exists, so it belongs to the tables the schema must have.
    assert.ok(EXPECTED_TABLES.includes('opencode_servers'), 'the table is not among the required tables');
    assert.equal(database.opencodeServers.forProject(project.id), null);

    const managed = database.opencodeServers.save({ ...MANAGED, projectId: project.id });
    assert.deepEqual(managed, {
      id: managed.id, project_id: project.id, kind: 'managed', directory: '/tmp/cmdb', base_url: 'http://127.0.0.1:4096',
      pid: 4321, pid_started: 'Thu Nov 26 12:17:55 2026', owner_pid: 321, version: '2.2.7', state: 'running',
      readonly_agent: true, started_at: '2026-11-26T04:00:00.000Z', ended_at: null,
      created_at: managed.created_at, updated_at: managed.updated_at,
    });
    assert.match(managed.id, /^[0-9a-f-]{36}$/);
    assert.deepEqual([database.opencodeServers.find(managed.id), database.opencodeServers.forProject(project.id)], [managed, managed]);

    // Attached to one someone else started: the pid is the one the server reports, and there is no process of ours.
    const attached = database.opencodeServers.save({
      projectId: project.id, kind: 'attached', directory: '/tmp/cmdb', baseUrl: 'http://127.0.0.1:4097',
      pid: 99, version: '2.2.7', state: 'running', readonlyAgent: false,
    });
    assert.deepEqual(attached, {
      ...managed, kind: 'attached', base_url: 'http://127.0.0.1:4097', pid: 99, readonly_agent: false,
      pid_started: null, owner_pid: null, started_at: null, ended_at: null, updated_at: attached.updated_at,
    });
    assert.equal(attached.updated_at >= managed.updated_at, true);
    assert.deepEqual([rows(database), database.opencodeServers.list().map(row => row.id)], [1, [managed.id]]);
    assert.deepEqual(database.opencodeServers.inStates(['running', 'stopped']).map(row => row.id), [managed.id]);
    assert.deepEqual(database.opencodeServers.inStates(['exited']), []);

    // Two projects keep their records apart, in the order of the registry.
    const other = database.projects.create({ slug: 'other', name: 'Other', repoRoot: '/tmp/other' });
    const second = database.opencodeServers.save({ ...MANAGED, projectId: other.id, pid: 8 });
    assert.deepEqual(database.opencodeServers.list().map(row => [row.project_id, row.pid]), [[project.id, 99], [other.id, 8]]);
    assert.equal(database.opencodeServers.inStates(['running']).length, 2);

    // A server for a project that is not registered is not stored.
    assert.throws(() => database.opencodeServers.save({ ...MANAGED, projectId: '11111111-1111-4111-8111-111111111111' }),
      /FOREIGN KEY/);
    assert.equal(rows(database), 2);
    // Forgetting one record leaves the other, and the server itself alone.
    assert.deepEqual([database.opencodeServers.delete(second.id), database.opencodeServers.delete(second.id)], [true, false]);
    assert.deepEqual(database.opencodeServers.list().map(row => row.id), [managed.id]);
    // Unregistering a project removes its record with it.
    database.projects.delete(project.id);
    assert.equal(rows(database), 0);
  } finally { dispose(); }
});

test('a record that is not a server the Workbench can name is refused, and nothing is stored', () => {
  const { database, project, dispose } = fixture('wb-oc-servers-invalid-');
  try {
    const refused: Array<[string, Partial<NewOpenCodeServer>]> = [
      ['kind', { kind: 'ours' as NewOpenCodeServer['kind'] }],
      ['state', { state: 'fine' as OpenCodeServerState }],
      ['directory', { directory: 'relative/cmdb' }],
      ['address with a path', { baseUrl: 'http://127.0.0.1:4096/api' }],
      ['address that is not one', { baseUrl: '127.0.0.1:4096' }],
      ['address with credentials', { baseUrl: 'http://opencode:secret@127.0.0.1:4096' }],
      ['a running server without an address', { baseUrl: null }],
      ['a running server without a version', { version: null }],
      ['pid 0', { pid: 0 }],
      ['negative pid', { ownerPid: -1 }],
      ['version', { version: '' }],
    ];
    for (const [name, change] of refused) {
      assert.throws(() => database.opencodeServers.save({ ...MANAGED, projectId: project.id, ...change }), Error, name);
    }
    assert.equal(rows(database), 0);
    assert.throws(() => database.opencodeServers.setState('x', 'fine' as OpenCodeServerState), /Invalid OpenCode server state/);
    assert.throws(() => database.opencodeServers.inStates(['fine' as OpenCodeServerState]), /Invalid OpenCode server state/);
    assert.deepEqual(database.opencodeServers.inStates([]), []);
  } finally { dispose(); }
});

test('how a server is gets noted, with when it ended, and nothing is noted for a record that is not there', () => {
  const { database, project, dispose } = fixture('wb-oc-servers-state-');
  try {
    const managed = database.opencodeServers.save({ ...MANAGED, projectId: project.id });
    const exited = database.opencodeServers.setState(managed.id, 'exited', '2026-11-26T04:01:00.000Z');
    assert.deepEqual([exited?.state, exited?.ended_at, exited?.started_at], ['exited', '2026-11-26T04:01:00.000Z', managed.started_at]);
    assert.ok(exited!.updated_at >= managed.updated_at, 'the note is older than the record');
    // A note without an end keeps the end that was noted before.
    const unavailable = database.opencodeServers.setState(managed.id, 'unavailable');
    assert.deepEqual([unavailable?.state, unavailable?.ended_at], ['unavailable', '2026-11-26T04:01:00.000Z']);
    // A failed start is stored as what it is, with no end: nothing ran.
    // A start that failed is stored as what it is: no address, no version and no end, because nothing ran.
    const failed = database.opencodeServers.save({
      projectId: project.id, kind: 'managed', directory: '/tmp/cmdb', state: 'not_installed', readonlyAgent: false,
    });
    assert.deepEqual([failed.state, failed.base_url, failed.version, failed.pid, failed.ended_at, failed.started_at],
      ['not_installed', null, null, null, null, null]);
    assert.deepEqual([database.opencodeServers.setState('11111111-1111-4111-8111-111111111111', 'stopped'), database.opencodeServers.find('11111111-1111-4111-8111-111111111111')], [null, null]);
  } finally { dispose(); }
});

test('the states the table accepts are the states the repository names', () => {
  const { database, dispose } = fixture('wb-oc-servers-states-');
  try {
    const sql = (database.connection.prepare(
      "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'opencode_servers'").get() as { sql: string }).sql;
    const list = sql.slice(sql.indexOf('CHECK(state IN ('), sql.indexOf(')),', sql.indexOf('CHECK(state IN (')));
    assert.deepEqual([...list.matchAll(/'([a-z_]+)'/g)].map(match => match[1]), [...OPENCODE_SERVER_STATES]);
  } finally { dispose(); }
});

test('a database from the release before the server table keeps its projects and gains the table on the next start', () => {
  const dir = directory('wb-oc-servers-upgrade-');
  const file = join(dir, 'workbench.sqlite');
  // A database as the previous release left it: four migrations and a project registered without a server.
  const old = new Sqlite(file);
  try {
    applyMigrations(old, BASE_MIGRATIONS.slice(0, 4));
    old.prepare(`INSERT INTO projects(id,slug,name,repo_root,default_branch,remote_url,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?)`).run(
      '22222222-2222-4222-8222-222222222222', 'cmdb', 'CMDB', '/tmp/cmdb', 'main', null, '2026-11-01T00:00:00.000Z', '2026-11-01T00:00:00.000Z');
    const tables = (old.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>).map(row => row.name);
    assert.ok(!tables.includes('opencode_servers'), 'the old database already has the table');
  } finally { old.close(); }
  const database = new WorkbenchDatabase({ dataDirectory: dir });
  try {
    assert.equal(database.projects.find('22222222-2222-4222-8222-222222222222')?.name, 'CMDB');
    assert.equal(database.opencodeServers.forProject('22222222-2222-4222-8222-222222222222'), null);
    const stored = database.opencodeServers.save({
      ...MANAGED, projectId: '22222222-2222-4222-8222-222222222222', directory: '/tmp/cmdb',
    });
    assert.equal(stored.state, 'running');
    // Opening it again changes nothing: the five migrations are the history it has.
    assert.equal(applyMigrations(database.connection), BASE_MIGRATIONS.length);
    // The table refuses a running server without an address.
    assert.throws(() => database.connection.prepare(`
      UPDATE opencode_servers SET base_url = NULL WHERE id = ?`).run(stored.id), /CHECK constraint/);
  } finally { database.close(); rmSync(dir, { recursive: true, force: true }); }
});

import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import Sqlite from 'better-sqlite3';
import {
  BASE_MIGRATIONS, EXPECTED_TABLES, PROJECT_TAG_LIMIT, WorkbenchDatabase, applyMigrations, type ProjectTags,
} from '../src/index.ts';

const directory = (prefix: string) => mkdtempSync(join(realpathSync(tmpdir()), prefix));
const none: ProjectTags = { capability: [], dependency: [] };
const fixture = (prefix: string) => {
  const dir = directory(prefix);
  const database = new WorkbenchDatabase({ dataDirectory: dir });
  return { dir, database, dispose: () => { database.close(); rmSync(dir, { recursive: true, force: true }); } };
};
/** Number of tags in the whole table, or of one project. */
const tagCount = (database: WorkbenchDatabase, id?: string) => (id
  ? database.connection.prepare('SELECT count(*) AS n FROM project_tags WHERE project_id = ?').get(id)
  : database.connection.prepare('SELECT count(*) AS n FROM project_tags').get()) as { n: number };
/** The tags a call must have stored. Null means there is no such project, which fails the case. */
function stored(tags: ProjectTags | null): ProjectTags {
  assert.ok(tags, 'the tags were not stored');
  return tags;
}

test('a project has two kinds of tags, stored once each, lowercase and sorted', () => {
  const { dir, database, dispose } = fixture('wb-tags-');
  let reopened: WorkbenchDatabase | undefined;
  try {
    // Every start checks that the table exists, so it belongs to the tables the schema must have.
    assert.ok(EXPECTED_TABLES.includes('project_tags'));
    const project = database.projects.create({ slug: 'cmdb', name: 'CMDB', repoRoot: '/tmp/cmdb' });
    assert.deepEqual(database.projects.tags(project.id), none);
    const saved = database.projects.updateTags(project.id, 1, {
      capability: [' CMDB ', 'asset-model', 'cmdb', 'API'], dependency: ['MySQL', 'redis'],
    });
    assert.deepEqual(saved, { capability: ['api', 'asset-model', 'cmdb'], dependency: ['mysql', 'redis'] });
    assert.deepEqual(database.projects.tags(project.id), saved);
    // A tag change is a change to the project, like a rename: the revision moves.
    assert.equal(database.projects.find(project.id)?.revision, 2);
    // There is no such project: no tags, and no write.
    assert.equal(database.projects.tags('11111111-1111-4111-8111-111111111111'), null);
    assert.equal(database.projects.updateTags('11111111-1111-4111-8111-111111111111', 1, none), null);

    database.close();
    const again = reopened = new WorkbenchDatabase({ dataDirectory: dir });
    assert.deepEqual(again.projects.tags(project.id), saved);
    assert.equal(again.projects.find(project.id)?.revision, 2);
    // A tag is looked up without regard to case, and the projects come in registry order.
    const monitoring = again.projects.create({ slug: 'monitoring', name: 'Monitoring', repoRoot: '/tmp/monitoring' });
    again.projects.updateTags(monitoring.id, 1, { capability: ['cmdb'], dependency: ['redis', 'CMDB'] });
    assert.deepEqual(again.projects.taggedWith('capability', ' Cmdb ').map(found => found.id), [project.id, monitoring.id]);
    assert.deepEqual(again.projects.taggedWith('dependency', 'cmdb').map(found => found.id), [monitoring.id]);
    assert.deepEqual(again.projects.taggedWith('capability', 'nothing'), []);
    assert.deepEqual(again.projects.taggedWith('dependency', '  '), []);
    assert.throws(() => again.projects.taggedWith('label' as never, 'cmdb'), /Invalid project tag kind/);
  } finally { reopened?.close(); dispose(); }
});

test('a value that is not one lowercase token is refused, and nothing is written', () => {
  const { database, dispose } = fixture('wb-tags-invalid-');
  try {
    const project = database.projects.create({ slug: 'cmdb', name: 'CMDB', repoRoot: '/tmp/cmdb' });
    const before = stored(database.projects.updateTags(project.id, 1, { capability: ['cmdb'], dependency: ['mysql'] }));
    const invalid: unknown[] = [
      '', '   ', 'two words', 'tab\tsep', 'line\nbreak', 'a:b', 'a;b', 'a,b', '-leading', '/leading', '.leading', '_leading',
      'has@at', '中文', 'a'.repeat(65), 42, null, undefined, {}, ['x'], Number.NaN,
    ];
    for (const value of invalid) {
      // The position of the offender is named, its text is not.
      for (const kind of ['capability', 'dependency'] as const) {
        const tags = { ...before, [kind]: [...before[kind], value] } as unknown as ProjectTags;
        assert.throws(() => database.projects.updateTags(project.id, 2, tags), /Invalid project tag at index 1 of/, String(value));
      }
    }
    // The longest tag is accepted, in both kinds.
    const longest = stored(database.projects.updateTags(project.id, 2, { capability: ['a'.repeat(64)], dependency: ['b'.repeat(64)] }));
    assert.deepEqual([longest.capability[0].length, longest.dependency[0].length], [64, 64]);
    assert.throws(() => database.projects.updateTags(project.id, 3, { capability: 'cmdb', dependency: [] } as unknown as ProjectTags),
      /Project tags of kind "capability" must be an array/);
    assert.throws(() => database.projects.updateTags(project.id, 3, undefined as unknown as ProjectTags), /Project tags must name both kinds/);
    assert.deepEqual(database.projects.tags(project.id), { capability: ['a'.repeat(64)], dependency: ['b'.repeat(64)] });
    assert.equal(database.projects.find(project.id)?.revision, 3);
    assert.equal(tagCount(database, project.id).n, 2);
  } finally { dispose(); }
});

test('a project has at most 64 tags per kind, repeats not counted', () => {
  const { database, dispose } = fixture('wb-tags-limit-');
  try {
    const project = database.projects.create({ slug: 'cmdb', name: 'CMDB', repoRoot: '/tmp/cmdb' });
    const sixtyFour = Array.from({ length: PROJECT_TAG_LIMIT }, (_, index) => `t${index}`);
    const saved = stored(database.projects.updateTags(project.id, 1, { capability: sixtyFour, dependency: sixtyFour }));
    assert.deepEqual([saved.capability.length, saved.dependency.length], [64, 64]);
    assert.deepEqual(database.projects.tags(project.id), saved);
    assert.equal(tagCount(database, project.id).n, 128);
    // One more is refused and the 64 stay as they were.
    assert.throws(() => database.projects.updateTags(project.id, 2, { capability: [...sixtyFour, 'one-too-many'], dependency: [] }),
      /A project has at most 64 "capability" tags/);
    assert.throws(() => database.projects.updateTags(project.id, 2, { capability: [], dependency: [...sixtyFour, 'T0', 't1', 'one-too-many'] }),
      /A project has at most 64 "dependency" tags/);
    assert.deepEqual(database.projects.tags(project.id), saved);
    assert.equal(database.projects.find(project.id)?.revision, 2);
    // Repeats collapse before they are counted.
    const fewer = database.projects.updateTags(project.id, 2, { capability: [...sixtyFour, 't0', 'T1', ' t2 '], dependency: [] });
    assert.deepEqual(fewer, { capability: saved.capability, dependency: [] });
  } finally { dispose(); }
});

test('saving the tags that are already stored changes nothing, and a stale revision writes nothing', () => {
  const { dir, database, dispose } = fixture('wb-tags-revision-');
  let other: WorkbenchDatabase | undefined;
  try {
    const project = database.projects.create({ slug: 'cmdb', name: 'CMDB', repoRoot: '/tmp/cmdb' });
    const first = database.projects.updateTags(project.id, 1, { capability: ['cmdb'], dependency: ['mysql'] });
    const afterFirst = database.projects.find(project.id);
    assert.equal(afterFirst?.revision, 2);
    // Not a change, whatever revision the caller quotes: revision and time stay as they are.
    assert.deepEqual(database.projects.updateTags(project.id, 1, { capability: [' Cmdb ', 'Cmdb', 'cmdb'], dependency: [' MYSQL ', 'mysql'] }), first);
    assert.deepEqual(database.projects.find(project.id), afterFirst);
    // A second change that quotes the revision from before the first one is refused.
    assert.equal(database.projects.updateTags(project.id, 1, { capability: ['cmdb', 'inventory'], dependency: [] }), null);
    assert.deepEqual(database.projects.tags(project.id), first);
    assert.deepEqual(database.projects.find(project.id), afterFirst);

    // The same from a second connection. A rename and a tag change share the revision, so neither can overwrite the other.
    other = new WorkbenchDatabase({ dataDirectory: dir, busyTimeoutMs: 50 });
    assert.equal(other.projects.updateTags(project.id, 1, none), null);
    assert.equal(other.projects.updateName(project.id, 1, 'Stale'), null);
    assert.equal(other.projects.updateName(project.id, 2, 'After the tag change')?.revision, 3);
    assert.equal(database.projects.updateTags(project.id, 2, none), null);
    assert.deepEqual(database.projects.updateTags(project.id, 3, none), none);
    assert.equal(database.projects.find(project.id)?.revision, 4);
    assert.equal(tagCount(database, project.id).n, 0);
  } finally { other?.close(); dispose(); }
});

test('unregistering a project deletes its tags and only its tags', () => {
  const { database, dispose } = fixture('wb-tags-delete-');
  try {
    const cmdb = database.projects.create({ slug: 'cmdb', name: 'CMDB', repoRoot: '/tmp/cmdb' });
    const monitoring = database.projects.create({ slug: 'monitoring', name: 'Monitoring', repoRoot: '/tmp/monitoring' });
    database.projects.updateTags(cmdb.id, 1, { capability: ['cmdb'], dependency: ['mysql'] });
    database.projects.updateTags(monitoring.id, 1, { capability: ['monitoring'], dependency: ['cmdb'] });
    assert.equal(tagCount(database).n, 4);
    assert.equal(database.projects.delete(cmdb.id), true);
    assert.equal(tagCount(database).n, 2);
    assert.equal(database.projects.tags(cmdb.id), null);
    assert.deepEqual(database.projects.taggedWith('dependency', 'cmdb').map(found => found.id), [monitoring.id]);
    // The database does the same when a registration row is removed without the repository method.
    database.connection.prepare('DELETE FROM projects WHERE id = ?').run(monitoring.id);
    assert.equal(tagCount(database).n, 0);
    assert.deepEqual(database.projects.list(), []);
  } finally { dispose(); }
});

test('the table itself refuses what the repository refuses', () => {
  const { database, dispose } = fixture('wb-tags-constraints-');
  try {
    const project = database.projects.create({ slug: 'cmdb', name: 'CMDB', repoRoot: '/tmp/cmdb' });
    const insert = database.connection.prepare('INSERT INTO project_tags(project_id, kind, value, created_at) VALUES (?, ?, ?, ?)');
    const at = '2026-11-25T00:00:00.000Z';
    insert.run(project.id, 'capability', 'cmdb', at);
    assert.throws(() => insert.run(project.id, 'capability', 'CMDB', at), /UNIQUE/);
    assert.throws(() => insert.run(project.id, 'label', 'cmdb', at), /CHECK/);
    assert.throws(() => insert.run(project.id, 'dependency', '', at), /CHECK/);
    assert.throws(() => insert.run(project.id, 'dependency', 'x'.repeat(65), at), /CHECK/);
    assert.throws(() => insert.run('11111111-1111-4111-8111-111111111111', 'dependency', 'mysql', at), /FOREIGN KEY/);
    assert.equal(tagCount(database, project.id).n, 1);
    assert.deepEqual(database.projects.tags(project.id), { capability: ['cmdb'], dependency: [] });
  } finally { dispose(); }
});

test('a database from the release before tags keeps its projects and gains the table on the next start', () => {
  const dir = directory('wb-tags-upgrade-');
  const file = join(dir, 'workbench.sqlite');
  const LEGACY_ID = '22222222-2222-4222-8222-222222222222';
  // A database as the release before this one left it: two migrations and a project with a remote.
  const old = new Sqlite(file);
  try {
    applyMigrations(old, BASE_MIGRATIONS.slice(0, 2));
    old.prepare(`INSERT INTO projects(id,slug,name,repo_root,default_branch,remote_url,created_at,updated_at)
      VALUES (?, 'legacy', 'Legacy', '/tmp/legacy', 'trunk', 'https://example.invalid/legacy.git',
        '2026-11-01T00:00:00Z', '2026-11-01T00:00:00Z')`).run(LEGACY_ID);
    assert.equal(old.pragma('user_version', { simple: true }), 2);
    assert.equal((old.prepare("SELECT count(*) AS n FROM sqlite_master WHERE name = 'project_tags'").get() as { n: number }).n, 0);
  } finally { old.close(); }

  const upgraded = new WorkbenchDatabase({ dataDirectory: dir });
  let again: WorkbenchDatabase | undefined;
  try {
    assert.equal(upgraded.connection.pragma('user_version', { simple: true }), BASE_MIGRATIONS.length);
    assert.equal(upgraded.projects.find(LEGACY_ID)?.remote_url, 'https://example.invalid/legacy.git');
    assert.deepEqual(upgraded.projects.tags(LEGACY_ID), none);
    const saved = upgraded.projects.updateTags(LEGACY_ID, 1, { capability: ['legacy'], dependency: [] });
    assert.equal(upgraded.projects.find(LEGACY_ID)?.revision, 2);
    upgraded.close();
    again = new WorkbenchDatabase({ dataDirectory: dir });
    assert.deepEqual(again.projects.tags(LEGACY_ID), saved);
  } finally { again?.close(); upgraded.close(); rmSync(dir, { recursive: true, force: true }); }
});

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, symlinkSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { WorkbenchDatabase, applyMigrations, BASE_MIGRATIONS, EXPECTED_TABLES } from '../src/index.ts';

function fixture() {
  const dir = mkdtempSync(join(realpathSync(tmpdir()), 'wb-sqlite-spec-'));
  const database = new WorkbenchDatabase({ dataDirectory: dir, busyTimeoutMs: 50 });
  return { dir, database, dispose: () => { database.close(); rmSync(dir, { recursive: true, force: true }); } };
}

test('fresh database enables WAL, foreign keys and required tables', () => {
  const x = fixture();
  try {
    assert.equal(x.database.connection.pragma('journal_mode', { simple: true }), 'wal');
    assert.equal(x.database.connection.pragma('foreign_keys', { simple: true }), 1);
    assert.equal(x.database.connection.pragma('busy_timeout', { simple: true }), 50);
    const tables = x.database.connection.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[];
    for (const name of EXPECTED_TABLES) assert.ok(tables.some(t => t.name === name), name);
    assert.equal(x.database.connection.pragma('user_version', { simple: true }), 1);
    assert.equal(applyMigrations(x.database.connection), 1);
  } finally { x.dispose(); }
});

test('persistent project survives close and reopen with revision control', () => {
  const x = fixture();
  try {
    const project = x.database.projects.create({ slug: 'cmdb', name: 'CMDB', repoRoot: '/tmp/cmdb' });
    assert.match(project.id, /^[0-9a-f-]{36}$/);
    assert.equal(project.revision, 1);
    x.database.close();
    const reopened = new WorkbenchDatabase({ dataDirectory: x.dir });
    try {
      assert.equal(reopened.projects.find(project.id)?.name, 'CMDB');
      assert.equal(reopened.projects.updateName(project.id, 1, 'CMDB v2')?.revision, 2);
      assert.equal(reopened.projects.updateName(project.id, 1, 'stale'), null);
      assert.equal(reopened.projects.find(project.id)?.name, 'CMDB v2');
    } finally { reopened.close(); }
  } finally { x.dispose(); }
});

test('unique constraint and foreign keys reject invalid records', () => {
  const x = fixture();
  try {
    x.database.projects.create({ slug: 'cmdb', name: 'CMDB', repoRoot: '/tmp/cmdb' });
    assert.throws(() => x.database.projects.create({ slug: 'cmdb', name: 'duplicate', repoRoot: '/tmp/other' }), /UNIQUE/);
    assert.throws(() => x.database.connection.prepare(`
      INSERT INTO requirement_versions(id, requirement_id, version, content_json, content_sha256, created_at)
      VALUES (?, ?, 1, '{}', 'sha256', ?)
    `).run(randomUUID(), randomUUID(), new Date().toISOString()), /FOREIGN KEY/);
    assert.throws(() => x.database.connection.prepare(`
      INSERT INTO requirements(id, requirement_key, title, created_at, updated_at, status)
      VALUES (?, 'REQ-1', 'x', ?, ?, 'invalid')
    `).run(randomUUID(), new Date().toISOString(), new Date().toISOString()), /CHECK/);
  } finally { x.dispose(); }
});

test('transaction rollback does not leak partial writes', () => {
  const x = fixture();
  try {
    assert.throws(() => x.database.transaction(() => {
      x.database.projects.create({ slug: 'cmdb', name: 'CMDB', repoRoot: '/tmp/cmdb' });
      throw new Error('failure injection');
    }), /failure injection/);
    assert.equal((x.database.connection.prepare('SELECT count(*) AS n FROM projects').get() as { n: number }).n, 0);
  } finally { x.dispose(); }
});

test('failed migration rolls back DDL and can retry corrected version', () => {
  const x = fixture();
  try {
    const invalid = [
      ...BASE_MIGRATIONS,
      { version: 2, name: 'second', sql: 'CREATE TABLE incomplete_table(id TEXT); INVALID SQL;' },
    ];
    assert.throws(() => applyMigrations(x.database.connection, invalid));
    assert.equal(x.database.connection.pragma('user_version', { simple: true }), 1);
    assert.equal((x.database.connection.prepare('SELECT count(*) AS n FROM schema_migrations').get() as { n: number }).n, 1);
    assert.equal((x.database.connection.prepare("SELECT count(*) AS n FROM sqlite_master WHERE name='incomplete_table'").get() as { n: number }).n, 0);
    assert.equal(applyMigrations(x.database.connection, [
      ...BASE_MIGRATIONS, { version: 2, name: 'second', sql: 'CREATE TABLE completed_table(id TEXT);' },
    ]), 2);
    assert.throws(() => applyMigrations(x.database.connection), /Unsafe database downgrade/);
  } finally { x.dispose(); }
});

test('separate connections honor compare-and-swap concurrency updates', () => {
  const x = fixture();
  try {
    const created = x.database.projects.create({ slug: 'monitor', name: 'Monitoring', repoRoot: '/tmp/monitor' });
    const other = new WorkbenchDatabase({ dataDirectory: x.dir, busyTimeoutMs: 50 });
    try {
      assert.equal(x.database.projects.updateName(created.id, 1, 'changed')?.revision, 2);
      assert.equal(other.projects.updateName(created.id, 1, 'overwritten'), null);
      assert.equal(other.projects.find(created.id)?.name, 'changed');
    } finally { other.close(); }
  } finally { x.dispose(); }
});

test('a second writer respects the busy timeout while another writer holds the lease', () => {
  const x = fixture();
  const second = new WorkbenchDatabase({ dataDirectory: x.dir, busyTimeoutMs: 50 });
  try {
    x.database.connection.exec('BEGIN IMMEDIATE');
    try {
      assert.throws(() => second.projects.create({
        slug: 'locked', name: 'Locked', repoRoot: '/tmp/locked',
      }), /database is locked/i);
    } finally {
      x.database.connection.exec('ROLLBACK');
    }
    assert.equal(second.projects.create({
      slug: 'released', name: 'Released', repoRoot: '/tmp/released',
    }).revision, 1);
  } finally {
    second.close();
    x.dispose();
  }
});

test('migration checksums prevent changing previously installed SQL', () => {
  const x = fixture();
  try {
    const altered = [{
      ...BASE_MIGRATIONS[0],
      sql: `${BASE_MIGRATIONS[0].sql}\n-- Unauthorized migration modification`,
    }];
    assert.throws(() => applyMigrations(x.database.connection, altered), /Migration history mismatch/);
    assert.equal(x.database.connection.pragma('user_version', { simple: true }), 1);
  } finally { x.dispose(); }
});

test('backup is an independent SQLite database with committed records', async () => {
  const x = fixture();
  try {
    x.database.projects.create({ slug: 'automation', name: 'Automation', repoRoot: '/tmp/automation' });
    const file = await x.database.backup();
    assert.ok(file.startsWith(join(x.dir, 'backups')));
    const Database = (await import('better-sqlite3')).default;
    const backup = new Database(file, { readonly: true });
    try {
      assert.equal((backup.prepare('SELECT count(*) AS n FROM projects').get() as { n: number }).n, 1);
    } finally { backup.close(); }
  } finally { x.dispose(); }
});

test('rejects symlinked database directories and relative paths', () => {
  const dir = mkdtempSync(join(realpathSync(tmpdir()), 'wb-path-spec-'));
  try {
    mkdirSync(join(dir, 'target'));
    symlinkSync(join(dir, 'target'), join(dir, 'link'));
    assert.throws(() => new WorkbenchDatabase({ dataDirectory: join(dir, 'link') }), /Symlink/);
    assert.throws(() => new WorkbenchDatabase({ dataDirectory: 'relative/path' }), /absolute/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

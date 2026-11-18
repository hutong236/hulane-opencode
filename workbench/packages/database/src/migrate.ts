import { createHash } from 'node:crypto';
import type Sqlite from 'better-sqlite3';
import { BASE_MIGRATIONS, type Migration } from './schema.js';

const HISTORY_SQL = `
CREATE TABLE IF NOT EXISTS schema_migrations (
  version INTEGER PRIMARY KEY CHECK(version >= 1),
  name TEXT NOT NULL,
  sha256 TEXT NOT NULL,
  applied_at TEXT NOT NULL
)`;

export function applyMigrations(
  database: Sqlite.Database,
  migrations: readonly Migration[] = BASE_MIGRATIONS,
): number {
  database.exec(HISTORY_SQL);
  const sorted = [...migrations].sort((a, b) => a.version - b.version);
  if (!sorted.length || sorted.some((m, index) => m.version !== index + 1)) {
    throw new Error('Migrations must contain a consecutive version history beginning at 1');
  }
  const existing = database.prepare('SELECT version, name, sha256 FROM schema_migrations ORDER BY version').all() as
    Array<{ version: number; name: string; sha256: string }>;
  if (existing.length > sorted.length) {
    throw new Error('Unsafe database downgrade: newer migrations are already present');
  }
  for (const applied of existing) {
    const migration = sorted[applied.version - 1];
    if (!migration || migration.version !== applied.version ||
        migration.name !== applied.name || hash(migration.sql) !== applied.sha256) {
      throw new Error(`Migration history mismatch at version ${applied.version}: refusing modification`);
    }
  }
  const installedVersion = Number(database.pragma('user_version', { simple: true }));
  if (installedVersion !== (existing.at(-1)?.version ?? 0)) {
    throw new Error('SQLite user_version does not match schema_migrations');
  }
  const insert = database.prepare(
    'INSERT INTO schema_migrations(version,name,sha256,applied_at) VALUES(?,?,?,?)',
  );
  for (const migration of sorted.slice(existing.length)) {
    const apply = database.transaction(() => {
      database.exec(migration.sql);
      insert.run(migration.version, migration.name, hash(migration.sql), new Date().toISOString());
      database.pragma(`user_version = ${migration.version}`);
    });
    // BEGIN IMMEDIATE prevents simultaneous workers from applying the same version.
    apply.immediate();
  }
  return sorted.length;
}

function hash(contents: string): string {
  return createHash('sha256').update(contents).digest('hex');
}

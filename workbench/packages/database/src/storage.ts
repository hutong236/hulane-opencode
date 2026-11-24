import { homedir, platform, tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import {
  existsSync, lstatSync, mkdirSync, realpathSync, rmSync, statSync,
} from 'node:fs';
import { isAbsolute, join, resolve, dirname } from 'node:path';
import Sqlite from 'better-sqlite3';
import { applyMigrations } from './migrate.js';
import { verifySchema } from './schema.js';
import { ProjectRepository } from './projects.js';
import { RequirementRepository } from './requirements.js';

export interface DatabaseOptions {
  dataDirectory?: string;
  busyTimeoutMs?: number;
}

export function defaultDataDirectory(): string {
  if (process.env.WORKBENCH_DATA_DIR) {
    if (!isAbsolute(process.env.WORKBENCH_DATA_DIR)) throw new Error('WORKBENCH_DATA_DIR must be absolute');
    return process.env.WORKBENCH_DATA_DIR;
  }
  if (platform() === 'win32') {
    return join(process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local'), 'hulane-workbench');
  }
  if (platform() === 'darwin') return join(homedir(), 'Library', 'Application Support', 'hulane-workbench');
  return join(process.env.XDG_DATA_HOME || join(homedir(), '.local', 'share'), 'hulane-workbench');
}

function ensureSafeDirectory(directory: string): string {
  if (!isAbsolute(directory)) throw new Error('Database directory must be absolute');
  const absolute = resolve(directory);
  // Check every existing path component before creating a directory.
  let cursor = absolute;
  while (cursor !== dirname(cursor)) {
    if (existsSync(cursor) && lstatSync(cursor).isSymbolicLink()) {
      throw new Error(`Symlink database directory is not allowed: ${cursor}`);
    }
    cursor = dirname(cursor);
  }
  mkdirSync(absolute, { recursive: true, mode: 0o700 });
  const canonical = realpathSync(absolute);
  if (canonical !== absolute) throw new Error('Database directory realpath mismatch');
  if (!statSync(canonical).isDirectory()) throw new Error('Database path is not a directory');
  return canonical;
}

export class WorkbenchDatabase {
  readonly path: string;
  readonly connection: Sqlite.Database;
  readonly projects: ProjectRepository;
  readonly requirements: RequirementRepository;

  constructor(options: DatabaseOptions = {}) {
    const directory = ensureSafeDirectory(options.dataDirectory || defaultDataDirectory());
    this.path = join(directory, 'workbench.sqlite');
    if (existsSync(this.path) && lstatSync(this.path).isSymbolicLink()) {
      throw new Error('Symlink database file is not allowed');
    }
    const timeout = options.busyTimeoutMs ?? 5_000;
    if (!Number.isInteger(timeout) || timeout < 0 || timeout > 60_000) throw new Error('Invalid busy timeout');
    this.connection = new Sqlite(this.path, { timeout });
    try {
      this.connection.pragma('foreign_keys = ON');
      this.connection.pragma('journal_mode = WAL');
      this.connection.pragma(`busy_timeout = ${timeout}`);
      applyMigrations(this.connection);
      verifySchema(this.connection);
    } catch (error) {
      this.connection.close();
      throw error;
    }
    this.projects = new ProjectRepository(this.connection);
    this.requirements = new RequirementRepository(this.connection);
  }

  transaction<T>(callback: () => T): T {
    return this.connection.transaction(callback).immediate();
  }

  async backup(): Promise<string> {
    const directory = ensureSafeDirectory(join(dirname(this.path), 'backups'));
    const destination = join(directory, `${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID()}.sqlite`);
    await this.connection.backup(destination);
    return destination;
  }

  close(): void {
    if (this.connection.open) this.connection.close();
  }
}

export function createIsolatedTestDatabase(): { database: WorkbenchDatabase; cleanup: () => void } {
  // Deliberately not used in production; callers should remove the temp directory after closing.
  const directory = join(realpathSync(tmpdir()), `hulane-workbench-test-${randomUUID()}`);
  const database = new WorkbenchDatabase({ dataDirectory: directory, busyTimeoutMs: 100 });
  return { database, cleanup: () => { database.close(); rmSync(directory, { recursive: true, force: true }); } };
}

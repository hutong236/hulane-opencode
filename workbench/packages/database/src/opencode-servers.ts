import { randomUUID } from 'node:crypto';
import type Sqlite from 'better-sqlite3';

/**
 * How a project's OpenCode server is, as far as the Workbench could tell when it last looked. After `running` come
 * the ways a server is no longer held (`stopped`: the Workbench ended it; `exited`: it ended on its own; `orphaned`:
 * left behind and not proved to be the recorded process; `detached`: someone else's, let go of and still running),
 * then the ways reaching or starting one fails.
 */
export const OPENCODE_SERVER_STATES = [
  'running', 'stopped', 'exited', 'orphaned', 'detached', 'unavailable', 'timeout', 'unauthorized',
  'incompatible_version', 'replaced', 'not_installed', 'directory_unavailable', 'pid_mismatch', 'readonly_agent',
  'refused', 'protocol',
] as const;
export type OpenCodeServerState = typeof OPENCODE_SERVER_STATES[number];

/** `managed`: the Workbench started it. `attached`: someone else did, and the Workbench was given its address. */
export type OpenCodeServerKind = 'managed' | 'attached';

export interface OpenCodeServerRecord {
  id: string;
  project_id: string;
  kind: OpenCodeServerKind;
  /** The project's registered root: where a managed server works, and the directory every request names. */
  directory: string;
  /** Where the server listens. Null for a start that failed before anything listened. */
  base_url: string | null;
  /** The process of a managed server. For an attached one, the number the server reports for itself. */
  pid: number | null;
  /** What the system said about a managed server's process when it was started. */
  pid_started: string | null;
  /** The Workbench process that started a managed server. */
  owner_pid: number | null;
  /** The OpenCode version the server reported. Null when no server reported one. */
  version: string | null;
  state: OpenCodeServerState;
  /** Whether the server has an agent that is proven read-only. Until it has, it gets no task from the Workbench. */
  readonly_agent: boolean;
  started_at: string | null;
  ended_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface NewOpenCodeServer {
  projectId: string;
  kind: OpenCodeServerKind;
  directory: string;
  baseUrl?: string | null;
  pid?: number | null;
  pidStarted?: string | null;
  ownerPid?: number | null;
  version?: string | null;
  state: OpenCodeServerState;
  readonlyAgent: boolean;
  startedAt?: string | null;
}

interface Row extends Omit<OpenCodeServerRecord, 'readonly_agent'> { readonly_agent: number }

const KINDS: readonly OpenCodeServerKind[] = ['managed', 'attached'];
const STATES: ReadonlySet<string> = new Set(OPENCODE_SERVER_STATES);
const positive = (value: number | null | undefined): boolean => value === null || value === undefined ||
  (Number.isSafeInteger(value) && value > 0);

function optional(value: number | null | undefined): number | null {
  return value === undefined ? null : value;
}

export class OpenCodeServerRepository {
  constructor(private readonly db: Sqlite.Database) {}

  find(id: string): OpenCodeServerRecord | null {
    return record((this.db.prepare('SELECT * FROM opencode_servers WHERE id = ?').get(id) ?? null) as Row | null);
  }

  forProject(projectId: string): OpenCodeServerRecord | null {
    return record((this.db.prepare('SELECT * FROM opencode_servers WHERE project_id = ?').get(projectId) ?? null) as Row | null);
  }

  /** In registry order of their projects. */
  list(): OpenCodeServerRecord[] {
    return records(this.db.prepare(`
      SELECT s.* FROM opencode_servers s JOIN projects p ON p.id = s.project_id ORDER BY p.created_at ASC, p.id ASC
    `).all() as Row[]);
  }

  /** The records in any of these states. */
  inStates(states: readonly OpenCodeServerState[]): OpenCodeServerRecord[] {
    const wanted = [...new Set(states)];
    if (wanted.some(state => !STATES.has(state))) throw new Error('Invalid OpenCode server state');
    if (wanted.length === 0) return [];
    return records(this.db.prepare(
      `SELECT * FROM opencode_servers WHERE state IN (${wanted.map(() => '?').join(', ')}) ORDER BY rowid`,
    ).all(...wanted) as Row[]);
  }

  /**
   * The server a project has. A project keeps one record: a new server replaces the one before it, under the same id.
   * Nothing in it is a password: that stays in the memory of the process that started or attached to the server.
   */
  save(input: NewOpenCodeServer): OpenCodeServerRecord {
    if (!KINDS.includes(input.kind)) throw new Error('Invalid OpenCode server kind');
    if (!STATES.has(input.state)) throw new Error('Invalid OpenCode server state');
    if (!input.directory.startsWith('/')) throw new Error('The project directory has to be absolute');
    const baseUrl = input.baseUrl ?? null;
    const version = input.version ?? null;
    if (baseUrl !== null && !/^https?:\/\/[^\s/@]+$/.test(baseUrl)) {
      throw new Error('The OpenCode server address has to be an origin');
    }
    // A server that is running said where it listens and which OpenCode it is.
    if (input.state === 'running' && (baseUrl === null || version === null)) {
      throw new Error('A running OpenCode server has an address and a version');
    }
    if ((version !== null && !version) || ![input.pid, input.ownerPid].every(positive)) {
      throw new Error('Invalid OpenCode server record');
    }
    return this.db.transaction((): OpenCodeServerRecord => {
      const id = this.forProject(input.projectId)?.id ?? randomUUID();
      const now = new Date().toISOString();
      this.db.prepare(`
        INSERT INTO opencode_servers(
          id, project_id, kind, directory, base_url, pid, pid_started, owner_pid, version, state, readonly_agent,
          started_at, ended_at, created_at, updated_at
        ) VALUES (
          @id, @projectId, @kind, @directory, @baseUrl, @pid, @pidStarted, @ownerPid, @version, @state, @readonlyAgent,
          @startedAt, NULL, @createdAt, @now
        )
        ON CONFLICT(project_id) DO UPDATE SET
          kind = excluded.kind, directory = excluded.directory, base_url = excluded.base_url, pid = excluded.pid,
          pid_started = excluded.pid_started, owner_pid = excluded.owner_pid, version = excluded.version,
          state = excluded.state, readonly_agent = excluded.readonly_agent, started_at = excluded.started_at,
          ended_at = excluded.ended_at, updated_at = excluded.updated_at
      `).run({
        id,
        projectId: input.projectId,
        kind: input.kind,
        directory: input.directory,
        baseUrl,
        pid: optional(input.pid),
        pidStarted: input.pidStarted ?? null,
        ownerPid: optional(input.ownerPid),
        version,
        state: input.state,
        readonlyAgent: input.readonlyAgent ? 1 : 0,
        startedAt: input.startedAt ?? null,
        createdAt: now,
        now,
      });
      const saved = this.find(id);
      if (!saved) throw new Error('The OpenCode server was not stored');
      return saved;
    }).immediate();
  }

  /** Notes how the server is now. `endedAt` is stored when given, and kept otherwise. */
  setState(id: string, state: OpenCodeServerState, endedAt: string | null = null): OpenCodeServerRecord | null {
    if (!STATES.has(state)) throw new Error('Invalid OpenCode server state');
    const changed = this.db.prepare(`
      UPDATE opencode_servers
      SET state = ?, ended_at = COALESCE(?, ended_at), updated_at = ?
      WHERE id = ?
    `).run(state, endedAt, new Date().toISOString(), id);
    return changed.changes === 1 ? this.find(id) : null;
  }

  /** Forgets the record. The server itself, if any, is not touched. */
  delete(id: string): boolean {
    return this.db.prepare('DELETE FROM opencode_servers WHERE id = ?').run(id).changes === 1;
  }
}

function records(rows: Row[]): OpenCodeServerRecord[] {
  return rows.flatMap(row => {
    const stored = record(row);
    return stored ? [stored] : [];
  });
}

function record(row: Row | null): OpenCodeServerRecord | null {
  if (!row) return null;
  const { readonly_agent, ...rest } = row;
  return { ...rest, readonly_agent: readonly_agent === 1 };
}

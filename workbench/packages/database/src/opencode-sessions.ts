import type Sqlite from 'better-sqlite3';

/** A session the Workbench knows a project has, by the id the OpenCode server gave it. */
export interface OpenCodeSessionRecord {
  project_id: string;
  session_id: string;
  title: string;
  /** When the server says the session was created. */
  created_at: string;
  /** When the server last listed it, or when the Workbench last created it. */
  last_seen_at: string;
  /** Whether the server listed it the last time the project's sessions were read. */
  on_server: boolean;
}

export interface SeenSession {
  id: string;
  title?: string;
  /** When the server created the session, in milliseconds since the epoch. */
  created?: number;
}

const SESSION = /^[\w-]{4,128}$/;

export class OpenCodeSessionRepository {
  constructor(private readonly db: Sqlite.Database) {}

  /** Notes that the project has these sessions, and when each was last seen. Ones not named are left as they are. */
  see(projectId: string, sessions: readonly SeenSession[]): void {
    if (sessions.some(session => !SESSION.test(session.id))) throw new Error('Invalid OpenCode session id');
    const now = new Date().toISOString();
    this.db.transaction((): void => {
      const write = this.db.prepare(`
        INSERT INTO opencode_sessions(project_id, session_id, title, created_at, last_seen_at, on_server)
        VALUES (?, ?, ?, ?, ?, 1)
        ON CONFLICT(project_id, session_id) DO UPDATE SET
          title = CASE WHEN excluded.title != '' THEN excluded.title ELSE opencode_sessions.title END,
          created_at = CASE WHEN excluded.created_at != '' THEN excluded.created_at ELSE opencode_sessions.created_at END,
          last_seen_at = excluded.last_seen_at, on_server = 1
      `);
      for (const session of sessions) {
        const created = Number.isSafeInteger(session.created) && (session.created as number) > 0
          ? new Date(session.created as number).toISOString() : '';
        write.run(projectId, session.id, session.title ?? '', created, now);
      }
    }).immediate();
  }

  /** Notes that the project has no session on the server but these. Returns how many were taken off the server. */
  onServer(projectId: string, present: readonly string[]): number {
    if (present.some(id => !SESSION.test(id))) throw new Error('Invalid OpenCode session id');
    const known = this.forProject(projectId).map(record => record.session_id);
    const gone = known.filter(id => !present.includes(id));
    if (gone.length === 0) return 0;
    const update = this.db.prepare(
      'UPDATE opencode_sessions SET on_server = 0 WHERE project_id = ? AND session_id = ? AND on_server = 1',
    );
    return this.db.transaction((): number => {
      let changed = 0;
      for (const id of gone) changed += update.run(projectId, id).changes;
      return changed;
    }).immediate();
  }

  /** What the Workbench knows of the project's sessions, the newest first. */
  forProject(projectId: string): OpenCodeSessionRecord[] {
    return (this.db.prepare(`
      SELECT * FROM opencode_sessions WHERE project_id = ?
      ORDER BY created_at DESC, session_id DESC
    `).all(projectId) as Array<Omit<OpenCodeSessionRecord, 'on_server'> & { on_server: number }>)
      .map(({ on_server, ...rest }) => ({ ...rest, on_server: on_server === 1 }));
  }
}

import { randomUUID } from 'node:crypto';
import type Sqlite from 'better-sqlite3';

export interface Project {
  id: string;
  slug: string;
  name: string;
  repo_root: string;
  default_branch: string;
  revision: number;
  created_at: string;
  updated_at: string;
}

export interface NewProject {
  slug: string;
  name: string;
  repoRoot: string;
  defaultBranch?: string;
}

export class ProjectRepository {
  constructor(private readonly db: Sqlite.Database) {}

  create(input: NewProject): Project {
    if (!/^[a-z0-9][a-z0-9-]{1,63}$/.test(input.slug)) throw new Error('Invalid project slug');
    if (!input.name.trim()) throw new Error('Project name is required');
    if (!input.repoRoot.startsWith('/')) throw new Error('Repository root must be absolute');
    const id = randomUUID();
    const now = new Date().toISOString();
    this.db.prepare(`
      INSERT INTO projects(id,slug,name,repo_root,default_branch,created_at,updated_at)
      VALUES (@id,@slug,@name,@repo_root,@default_branch,@created_at,@updated_at)
    `).run({
      id, slug: input.slug, name: input.name.trim(), repo_root: input.repoRoot,
      default_branch: input.defaultBranch || 'main', created_at: now, updated_at: now,
    });
    return this.find(id)!;
  }

  find(id: string): Project | null {
    return (this.db.prepare('SELECT * FROM projects WHERE id = ?').get(id) as Project | undefined) ?? null;
  }

  updateName(id: string, expectedRevision: number, name: string): Project | null {
    if (!name.trim()) throw new Error('Project name is required');
    const result = this.db.prepare(`
      UPDATE projects SET name = ?, revision = revision + 1, updated_at = ?
      WHERE id = ? AND revision = ?
    `).run(name.trim(), new Date().toISOString(), id, expectedRevision);
    return result.changes === 1 ? this.find(id) : null;
  }
}

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
  /** URL of the `origin` remote without any user name or password; null when the repository has none. */
  remote_url: string | null;
}

export interface NewProject {
  slug: string;
  name: string;
  repoRoot: string;
  defaultBranch?: string;
  remoteUrl?: string | null;
}

/** A capability tag says what a project provides; a dependency tag says what it depends on. */
export type ProjectTagKind = 'capability' | 'dependency';
export interface ProjectTags { capability: string[]; dependency: string[] }

/** The most distinct tags a project has per kind. */
export const PROJECT_TAG_LIMIT = 64;
const TAG_KINDS: readonly ProjectTagKind[] = ['capability', 'dependency'];

/**
 * A tag is one lowercase token of letters, digits, `.`, `_`, `/` and `-`, at most 64 characters long. Spaces around it
 * are removed and a repeat collapses. Anything else is refused with the position of the offender, not its text.
 */
function normalizeTags(tags: ProjectTags): ProjectTags {
  if (!tags || typeof tags !== 'object') throw new Error('Project tags must name both kinds');
  const normalized = { capability: [], dependency: [] } as ProjectTags;
  for (const kind of TAG_KINDS) {
    const values: unknown = tags[kind];
    if (!Array.isArray(values)) throw new Error(`Project tags of kind "${kind}" must be an array`);
    const unique = new Set<string>();
    values.forEach((value: unknown, index: number) => {
      const token = typeof value === 'string' ? value.trim().toLowerCase() : '';
      if (!/^[a-z0-9][a-z0-9._/-]{0,63}$/.test(token)) throw new Error(`Invalid project tag at index ${index} of "${kind}"`);
      unique.add(token);
    });
    if (unique.size > PROJECT_TAG_LIMIT) throw new Error(`A project has at most ${PROJECT_TAG_LIMIT} "${kind}" tags`);
    normalized[kind] = [...unique].sort();
  }
  return normalized;
}

const sameTags = (a: ProjectTags, b: ProjectTags) =>
  TAG_KINDS.every(kind => a[kind].length === b[kind].length && a[kind].every(value => b[kind].includes(value)));

export class ProjectRepository {
  constructor(private readonly db: Sqlite.Database) {}

  create(input: NewProject): Project {
    if (!/^[a-z0-9][a-z0-9-]{1,63}$/.test(input.slug)) throw new Error('Invalid project slug');
    if (!input.name.trim()) throw new Error('Project name is required');
    if (!input.repoRoot.startsWith('/')) throw new Error('Repository root must be absolute');
    const id = randomUUID();
    const now = new Date().toISOString();
    this.db.prepare(`
      INSERT INTO projects(id,slug,name,repo_root,default_branch,remote_url,created_at,updated_at)
      VALUES (@id,@slug,@name,@repo_root,@default_branch,@remote_url,@created_at,@updated_at)
    `).run({
      id, slug: input.slug, name: input.name.trim(), repo_root: input.repoRoot,
      default_branch: input.defaultBranch || 'main', remote_url: input.remoteUrl ?? null,
      created_at: now, updated_at: now,
    });
    return this.find(id)!;
  }

  find(id: string): Project | null {
    return (this.db.prepare('SELECT * FROM projects WHERE id = ?').get(id) as Project | undefined) ?? null;
  }

  /** Look up a canonical repository root before registration. The database UNIQUE constraint remains authoritative. */
  findByRoot(repoRoot: string): Project | null {
    return (this.db.prepare('SELECT * FROM projects WHERE repo_root = ?').get(repoRoot) as Project | undefined) ?? null;
  }

  /** Stable ordering for the project registry; no local repository is opened. */
  list(): Project[] {
    return this.db.prepare('SELECT * FROM projects ORDER BY created_at ASC, id ASC').all() as Project[];
  }

  /** Remove only the registration row; never access the repository filesystem. */
  delete(id: string): boolean {
    return this.db.prepare('DELETE FROM projects WHERE id = ?').run(id).changes === 1;
  }

  updateName(id: string, expectedRevision: number, name: string): Project | null {
    if (!name.trim()) throw new Error('Project name is required');
    const result = this.db.prepare(`
      UPDATE projects SET name = ?, revision = revision + 1, updated_at = ?
      WHERE id = ? AND revision = ?
    `).run(name.trim(), new Date().toISOString(), id, expectedRevision);
    return result.changes === 1 ? this.find(id) : null;
  }

  /** Both kinds of tags of a project, each sorted; null when there is no such project. */
  tags(id: string): ProjectTags | null {
    if (!this.find(id)) return null;
    const tags = { capability: [], dependency: [] } as ProjectTags;
    const rows = this.db.prepare('SELECT kind, value FROM project_tags WHERE project_id = ? ORDER BY kind, value').all(id) as
      Array<{ kind: ProjectTagKind; value: string }>;
    for (const row of rows) tags[row.kind].push(row.value);
    return tags;
  }

  /**
   * Replace both kinds of tags at once. Like a rename, this needs the revision the caller saw, so a stale list never
   * overwrites a newer change, and it raises the revision. Saving the tags that are already stored changes nothing.
   * Returns null when the project does not exist or the revision is stale; nothing is written then.
   */
  updateTags(id: string, expectedRevision: number, tags: ProjectTags): ProjectTags | null {
    const next = normalizeTags(tags);
    return this.db.transaction((): ProjectTags | null => {
      const current = this.tags(id);
      if (!current) return null;
      if (sameTags(current, next)) return current;
      const changed = this.db.prepare(`
        UPDATE projects SET revision = revision + 1, updated_at = ? WHERE id = ? AND revision = ?
      `).run(new Date().toISOString(), id, expectedRevision);
      if (changed.changes !== 1) return null;
      this.db.prepare('DELETE FROM project_tags WHERE project_id = ?').run(id);
      const insert = this.db.prepare('INSERT INTO project_tags(project_id, kind, value, created_at) VALUES (?, ?, ?, ?)');
      const now = new Date().toISOString();
      for (const kind of TAG_KINDS) for (const value of next[kind]) insert.run(id, kind, value, now);
      return next;
    }).immediate();
  }

  /** The projects carrying a tag, in registry order. A tag is looked up without regard to case. */
  taggedWith(kind: ProjectTagKind, value: string): Project[] {
    if (!TAG_KINDS.includes(kind)) throw new Error('Invalid project tag kind');
    return this.db.prepare(`
      SELECT p.* FROM projects p
      JOIN project_tags t ON t.project_id = p.id AND t.kind = ? AND t.value = ?
      ORDER BY p.created_at ASC, p.id ASC
    `).all(kind, value.trim().toLowerCase()) as Project[];
  }
}

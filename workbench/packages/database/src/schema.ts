import type Sqlite from 'better-sqlite3';

export interface Migration {
  readonly version: number;
  readonly name: string;
  readonly sql: string;
}

export const BASE_MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    name: 'workbench_initial_schema',
    sql: `
CREATE TABLE projects (
  id TEXT PRIMARY KEY NOT NULL,
  slug TEXT NOT NULL COLLATE NOCASE UNIQUE,
  name TEXT NOT NULL,
  repo_root TEXT NOT NULL UNIQUE,
  default_branch TEXT NOT NULL DEFAULT 'main',
  revision INTEGER NOT NULL DEFAULT 1 CHECK(revision >= 1),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK(length(id) = 36),
  CHECK(length(trim(name)) > 0)
);

CREATE TABLE requirements (
  id TEXT PRIMARY KEY NOT NULL,
  requirement_key TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft'
    CHECK(status IN ('draft','reviewed','approved','archived')),
  current_version INTEGER NOT NULL DEFAULT 0 CHECK(current_version >= 0),
  revision INTEGER NOT NULL DEFAULT 1 CHECK(revision >= 1),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK(length(id) = 36)
);

CREATE TABLE requirement_versions (
  id TEXT PRIMARY KEY NOT NULL,
  requirement_id TEXT NOT NULL REFERENCES requirements(id) ON DELETE RESTRICT,
  version INTEGER NOT NULL CHECK(version >= 1),
  content_json TEXT NOT NULL CHECK(json_valid(content_json)),
  content_sha256 TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(requirement_id, version),
  CHECK(length(id) = 36)
);

CREATE TABLE requirement_diffs (
  id TEXT PRIMARY KEY NOT NULL,
  base_version_id TEXT NOT NULL REFERENCES requirement_versions(id) ON DELETE RESTRICT,
  target_version_id TEXT NOT NULL REFERENCES requirement_versions(id) ON DELETE RESTRICT,
  diff_json TEXT NOT NULL CHECK(json_valid(diff_json)),
  diff_sha256 TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(base_version_id, target_version_id),
  CHECK(base_version_id != target_version_id),
  CHECK(length(id) = 36)
);

CREATE TABLE work_items (
  id TEXT PRIMARY KEY NOT NULL,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  requirement_version_id TEXT NOT NULL REFERENCES requirement_versions(id) ON DELETE RESTRICT,
  external_key TEXT,
  status TEXT NOT NULL DEFAULT 'draft'
    CHECK(status IN ('draft','confirmed','queued','running','completed','failed','cancelled','needs_attention')),
  payload_json TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(payload_json)),
  revision INTEGER NOT NULL DEFAULT 1 CHECK(revision >= 1),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(project_id, external_key),
  CHECK(length(id) = 36)
);

CREATE TABLE workflow_definitions (
  id TEXT PRIMARY KEY NOT NULL,
  name TEXT NOT NULL,
  version INTEGER NOT NULL CHECK(version >= 1),
  schema_json TEXT NOT NULL CHECK(json_valid(schema_json)),
  schema_sha256 TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(name, version),
  CHECK(length(id) = 36)
);

CREATE TABLE workflow_runs (
  id TEXT PRIMARY KEY NOT NULL,
  definition_id TEXT NOT NULL REFERENCES workflow_definitions(id) ON DELETE RESTRICT,
  work_item_id TEXT NOT NULL REFERENCES work_items(id) ON DELETE RESTRICT,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK(status IN ('pending','running','waiting_approval','succeeded','failed','cancelled','needs_attention')),
  revision INTEGER NOT NULL DEFAULT 1 CHECK(revision >= 1),
  started_at TEXT,
  finished_at TEXT,
  created_at TEXT NOT NULL,
  CHECK(length(id) = 36)
);

CREATE TABLE workflow_steps (
  id TEXT PRIMARY KEY NOT NULL,
  run_id TEXT NOT NULL REFERENCES workflow_runs(id) ON DELETE CASCADE,
  step_key TEXT NOT NULL,
  kind TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK(status IN ('pending','running','waiting_approval','succeeded','failed','cancelled','skipped')),
  attempt INTEGER NOT NULL DEFAULT 0 CHECK(attempt >= 0),
  revision INTEGER NOT NULL DEFAULT 1 CHECK(revision >= 1),
  payload_json TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(payload_json)),
  started_at TEXT,
  finished_at TEXT,
  UNIQUE(run_id, step_key),
  CHECK(length(id) = 36)
);

CREATE TABLE execution_events (
  id TEXT PRIMARY KEY NOT NULL,
  run_id TEXT NOT NULL REFERENCES workflow_runs(id) ON DELETE CASCADE,
  step_id TEXT REFERENCES workflow_steps(id) ON DELETE SET NULL,
  seq INTEGER NOT NULL CHECK(seq >= 1),
  source TEXT NOT NULL,
  event_type TEXT NOT NULL,
  payload_json TEXT NOT NULL CHECK(json_valid(payload_json)),
  occurred_at TEXT NOT NULL,
  UNIQUE(run_id, seq),
  CHECK(length(id) = 36)
);

CREATE TABLE approvals (
  id TEXT PRIMARY KEY NOT NULL,
  run_id TEXT NOT NULL REFERENCES workflow_runs(id) ON DELETE RESTRICT,
  step_id TEXT REFERENCES workflow_steps(id) ON DELETE RESTRICT,
  decision TEXT NOT NULL CHECK(decision IN ('requested','approved','rejected','revoked')),
  actor TEXT NOT NULL,
  reason TEXT,
  evidence_sha TEXT,
  created_at TEXT NOT NULL,
  CHECK(length(id) = 36)
);

CREATE INDEX ix_requirement_versions_requirement ON requirement_versions(requirement_id, version);
CREATE INDEX ix_work_items_requirement ON work_items(requirement_version_id);
CREATE INDEX ix_work_items_project_status ON work_items(project_id, status);
CREATE INDEX ix_workflow_runs_work_item ON workflow_runs(work_item_id, status);
CREATE INDEX ix_workflow_steps_run_status ON workflow_steps(run_id, status);
CREATE INDEX ix_events_run_seq ON execution_events(run_id, seq);
CREATE INDEX ix_approvals_run ON approvals(run_id, created_at);
`,
  },
  {
    version: 2,
    name: 'requirement_version_authors_and_immutability',
    sql: `
ALTER TABLE requirement_versions ADD COLUMN actor TEXT NOT NULL DEFAULT 'system';
ALTER TABLE requirement_versions ADD COLUMN summary TEXT NOT NULL DEFAULT '';

CREATE TRIGGER requirement_versions_no_update
BEFORE UPDATE ON requirement_versions
BEGIN
  SELECT RAISE(ABORT, 'requirement_versions rows are immutable');
END;

CREATE TRIGGER requirement_versions_no_delete
BEFORE DELETE ON requirement_versions
BEGIN
  SELECT RAISE(ABORT, 'requirement_versions rows are immutable');
END;
`,
  },
] as const;

export const EXPECTED_TABLES = [
  'projects', 'requirements', 'requirement_versions', 'requirement_diffs',
  'work_items', 'workflow_definitions', 'workflow_runs', 'workflow_steps',
  'execution_events', 'approvals',
] as const;

export function verifySchema(db: Sqlite.Database): void {
  const integrity = db.pragma('quick_check', { simple: true });
  if (integrity !== 'ok') throw new Error('SQLite integrity check failed');
  const foreignKeyProblems = db.pragma('foreign_key_check');
  if (Array.isArray(foreignKeyProblems) && foreignKeyProblems.length > 0) {
    throw new Error('SQLite foreign key validation failed');
  }
  const rows = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>;
  const existing = new Set(rows.map(row => row.name));
  for (const table of EXPECTED_TABLES) {
    if (!existing.has(table)) throw new Error(`Required database table missing: ${table}`);
  }
}

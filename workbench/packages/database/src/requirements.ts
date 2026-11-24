import { createHash, randomUUID } from 'node:crypto';
import type Sqlite from 'better-sqlite3';

export const REQUIREMENT_STATUSES = ['draft', 'reviewed', 'approved', 'archived'] as const;
export type RequirementStatus = (typeof REQUIREMENT_STATUSES)[number];

export const REQUIREMENT_PRIORITIES = ['low', 'medium', 'high', 'critical'] as const;
export type RequirementPriority = (typeof REQUIREMENT_PRIORITIES)[number];

export interface RequirementAcceptanceCriterion {
  id: string;
  text: string;
}

export interface RequirementContent {
  title: string;
  background: string;
  goal: string;
  scope: string;
  acceptanceCriteria: RequirementAcceptanceCriterion[];
  priority: RequirementPriority;
  risk: string;
}

export interface Requirement {
  id: string;
  requirement_key: string;
  title: string;
  status: RequirementStatus;
  current_version: number;
  revision: number;
  created_at: string;
  updated_at: string;
  content: RequirementContent;
  content_sha256: string;
}

export interface RequirementVersion {
  id: string;
  requirement_id: string;
  version: number;
  content: RequirementContent;
  content_sha256: string;
  actor: string;
  summary: string;
  created_at: string;
}

export interface NewRequirement {
  requirementKey: string;
  content: unknown;
  actor: string;
  summary: string;
}

/** Invalid input that must never reach SQLite. */
export class RequirementValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RequirementValidationError';
  }
}

/** A stale revision or an illegal state transition; the caller must reload before retrying. */
export class RequirementConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RequirementConflictError';
  }
}

/** Not found is distinct from a conflict so the API can answer 404 without exposing storage details. */
export class RequirementNotFoundError extends Error {
  constructor() {
    super('Requirement not found');
    this.name = 'RequirementNotFoundError';
  }
}

interface RequirementRow {
  id: string;
  requirement_key: string;
  title: string;
  status: RequirementStatus;
  current_version: number;
  revision: number;
  created_at: string;
  updated_at: string;
  content_json: string;
  content_sha256: string;
}

interface VersionRow {
  id: string;
  requirement_id: string;
  version: number;
  content_json: string;
  content_sha256: string;
  actor: string;
  summary: string;
  created_at: string;
}

const REQUIREMENT_SELECT = `
  SELECT r.id, r.requirement_key, r.title, r.status, r.current_version, r.revision,
         r.created_at, r.updated_at, v.content_json, v.content_sha256
  FROM requirements r
  JOIN requirement_versions v
    ON v.requirement_id = r.id AND v.version = r.current_version
`;

const VERSION_SELECT = `
  SELECT id, requirement_id, version, content_json, content_sha256, actor, summary, created_at
  FROM requirement_versions
`;

const ALLOWED_TRANSITIONS: Readonly<Record<RequirementStatus, readonly RequirementStatus[]>> = {
  draft: ['reviewed'],
  reviewed: ['approved'],
  approved: ['archived'],
  archived: [],
};

export class RequirementRepository {
  constructor(private readonly db: Sqlite.Database) {}

  create(input: NewRequirement): Requirement {
    const requirementKey = normalizeKey(input.requirementKey);
    const content = normalizeContent(input.content);
    const actor = normalizeActor(input.actor);
    const summary = normalizeSummary(input.summary);
    const id = randomUUID();
    const now = new Date().toISOString();
    return this.write(() => {
      if (this.findByKey(requirementKey)) throw new RequirementConflictError('Requirement key already exists');
      this.db.prepare(`
        INSERT INTO requirements(id, requirement_key, title, status, current_version, revision, created_at, updated_at)
        VALUES (@id, @requirement_key, @title, 'draft', 1, 1, @created_at, @updated_at)
      `).run({ id, requirement_key: requirementKey, title: content.title, created_at: now, updated_at: now });
      this.insertVersion(id, 1, content, actor, summary, now);
      return this.find(id)!;
    });
  }

  find(id: string): Requirement | null {
    const row = this.findRow(id);
    return row ? mapRequirement(row) : null;
  }

  findByKey(requirementKey: string): Requirement | null {
    const row = this.db.prepare(`${REQUIREMENT_SELECT} WHERE r.requirement_key = ?`).get(requirementKey) as
      RequirementRow | undefined;
    return row ? mapRequirement(row) : null;
  }

  list(): Requirement[] {
    const rows = this.db.prepare(`${REQUIREMENT_SELECT} ORDER BY r.created_at ASC, r.id ASC`).all() as RequirementRow[];
    return rows.map(mapRequirement);
  }

  update(id: string, expectedRevision: number, contentInput: unknown, actorInput: string, summaryInput: string): Requirement {
    const revision = normalizeExpectedRevision(expectedRevision);
    const content = normalizeContent(contentInput);
    const actor = normalizeActor(actorInput);
    const summary = normalizeSummary(summaryInput);
    return this.write(() => {
      const current = this.findRow(id);
      if (!current) throw new RequirementNotFoundError();
      assertRevision(current, revision);
      if (current.status !== 'draft' && current.status !== 'reviewed') {
        throw new RequirementConflictError('Only draft or reviewed requirements can be edited');
      }
      const nextVersion = current.current_version + 1;
      const now = new Date().toISOString();
      const result = this.db.prepare(`
        UPDATE requirements
        SET title = @title, current_version = @current_version, revision = revision + 1, updated_at = @updated_at
        WHERE id = @id AND revision = @revision
      `).run({
        title: content.title, current_version: nextVersion, updated_at: now, id, revision,
      });
      if (result.changes !== 1) throw new RequirementConflictError('Requirement revision conflict');
      this.insertVersion(id, nextVersion, content, actor, summary, now);
      return this.find(id)!;
    });
  }

  transition(
    id: string, expectedRevision: number, targetInput: string, actorInput: string, summaryInput: string,
  ): Requirement {
    const revision = normalizeExpectedRevision(expectedRevision);
    const target = normalizeStatus(targetInput);
    // Validate the operator and summary even though a status change appends no content version.
    normalizeActor(actorInput);
    normalizeSummary(summaryInput);
    return this.write(() => {
      const current = this.findRow(id);
      if (!current) throw new RequirementNotFoundError();
      assertRevision(current, revision);
      if (!ALLOWED_TRANSITIONS[current.status].includes(target)) {
        throw new RequirementConflictError(`Cannot transition from ${current.status} to ${target}`);
      }
      // A status change is metadata only; it never rewrites an existing content snapshot.
      this.db.prepare(`
        UPDATE requirements SET status = @status, revision = revision + 1, updated_at = @updated_at
        WHERE id = @id AND revision = @revision
      `).run({ status: target, updated_at: new Date().toISOString(), id, revision });
      return this.find(id)!;
    });
  }

  /** Restore an earlier snapshot as a new draft version; the source version stays untouched. */
  restore(
    id: string, versionInput: number, expectedRevision: number, actorInput: string, summaryInput: string,
  ): Requirement {
    const version = normalizeVersionNumber(versionInput);
    const revision = normalizeExpectedRevision(expectedRevision);
    const actor = normalizeActor(actorInput);
    const summary = normalizeSummary(summaryInput);
    return this.write(() => {
      const current = this.findRow(id);
      if (!current) throw new RequirementNotFoundError();
      assertRevision(current, revision);
      const source = this.versionRow(id, version);
      if (!source) throw new RequirementNotFoundError();
      const content = normalizeContent(JSON.parse(source.content_json) as unknown);
      const nextVersion = current.current_version + 1;
      const now = new Date().toISOString();
      this.db.prepare(`
        UPDATE requirements
        SET title = @title, status = 'draft', current_version = @current_version,
            revision = revision + 1, updated_at = @updated_at
        WHERE id = @id AND revision = @revision
      `).run({ title: content.title, current_version: nextVersion, updated_at: now, id, revision });
      this.insertVersion(id, nextVersion, content, actor, summary, now);
      return this.find(id)!;
    });
  }

  versions(id: string): RequirementVersion[] {
    const rows = this.db.prepare(`${VERSION_SELECT} WHERE requirement_id = ? ORDER BY version ASC`).all(id) as VersionRow[];
    return rows.map(mapVersion);
  }

  version(id: string, version: number): RequirementVersion | null {
    if (!Number.isSafeInteger(version) || version < 1) return null;
    const row = this.versionRow(id, version);
    return row ? mapVersion(row) : null;
  }

  private findRow(id: string): RequirementRow | null {
    return (this.db.prepare(`${REQUIREMENT_SELECT} WHERE r.id = ?`).get(id) as RequirementRow | undefined) ?? null;
  }

  private versionRow(id: string, version: number): VersionRow | null {
    return (this.db.prepare(`${VERSION_SELECT} WHERE requirement_id = ? AND version = ?`).get(id, version) as
      VersionRow | undefined) ?? null;
  }

  private insertVersion(
    requirementId: string, version: number, content: RequirementContent, actor: string, summary: string, now: string,
  ): void {
    const contentJson = canonicalJson(content);
    this.db.prepare(`
      INSERT INTO requirement_versions(
        id, requirement_id, version, content_json, content_sha256, actor, summary, created_at
      ) VALUES (@id, @requirement_id, @version, @content_json, @content_sha256, @actor, @summary, @created_at)
    `).run({
      id: randomUUID(), requirement_id: requirementId, version, content_json: contentJson,
      content_sha256: sha256(contentJson), actor, summary, created_at: now,
    });
  }

  private write<T>(callback: () => T): T {
    return this.db.transaction(callback).immediate();
  }
}

/** A stale revision means the caller's draft is based on an older snapshot. */
function assertRevision(row: RequirementRow, expectedRevision: number): void {
  if (row.revision !== expectedRevision) throw new RequirementConflictError('Requirement revision conflict');
}

function mapRequirement(row: RequirementRow): Requirement {
  return {
    id: row.id,
    requirement_key: row.requirement_key,
    title: row.title,
    status: row.status,
    current_version: row.current_version,
    revision: row.revision,
    created_at: row.created_at,
    updated_at: row.updated_at,
    content: normalizeContent(JSON.parse(row.content_json) as unknown),
    content_sha256: row.content_sha256,
  };
}

function mapVersion(row: VersionRow): RequirementVersion {
  return {
    id: row.id,
    requirement_id: row.requirement_id,
    version: row.version,
    content: normalizeContent(JSON.parse(row.content_json) as unknown),
    content_sha256: row.content_sha256,
    actor: row.actor,
    summary: row.summary,
    created_at: row.created_at,
  };
}

function normalizeKey(value: unknown): string {
  const key = readText(value, 'requirementKey', 10, true).toUpperCase();
  if (!/^REQ-[0-9]{3,6}$/.test(key)) {
    throw new RequirementValidationError('requirementKey must match REQ-000');
  }
  return key;
}

function normalizeStatus(value: unknown): RequirementStatus {
  if (typeof value !== 'string' || !(REQUIREMENT_STATUSES as readonly string[]).includes(value)) {
    throw new RequirementValidationError('Invalid requirement status');
  }
  return value as RequirementStatus;
}

function normalizePriority(value: unknown): RequirementPriority {
  if (typeof value !== 'string' || !(REQUIREMENT_PRIORITIES as readonly string[]).includes(value)) {
    throw new RequirementValidationError('Invalid requirement priority');
  }
  return value as RequirementPriority;
}

function normalizeExpectedRevision(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw new RequirementValidationError('expectedRevision must be a positive integer');
  }
  return value as number;
}

function normalizeVersionNumber(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw new RequirementValidationError('Version must be a positive integer');
  }
  return value as number;
}

function normalizeActor(value: unknown): string {
  return readText(value, 'actor', 120, true);
}

function normalizeSummary(value: unknown): string {
  return readText(value, 'summary', 500, true);
}

function normalizeContent(value: unknown): RequirementContent {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new RequirementValidationError('Requirement content must be an object');
  }
  const row = value as Record<string, unknown>;
  const title = readText(row.title, 'title', 200, true);
  const background = readText(row.background, 'background', 20_000);
  const goal = readText(row.goal, 'goal', 20_000);
  const scope = readText(row.scope, 'scope', 20_000);
  const risk = readText(row.risk, 'risk', 5_000);
  const criteriaInput = row.acceptanceCriteria ?? [];
  if (!Array.isArray(criteriaInput) || criteriaInput.length > 50) {
    throw new RequirementValidationError('acceptanceCriteria must contain at most 50 entries');
  }
  const seen = new Set<string>();
  const entries: unknown[] = criteriaInput;
  const acceptanceCriteria = entries.map((item, index) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      throw new RequirementValidationError(`acceptanceCriteria[${index}] must be an object`);
    }
    const entry = item as Record<string, unknown>;
    const id = readText(entry.id, `acceptanceCriteria[${index}].id`, 40, true);
    const text = readText(entry.text, `acceptanceCriteria[${index}].text`, 2_000, true);
    if (seen.has(id)) throw new RequirementValidationError('acceptanceCriteria ids must be unique');
    seen.add(id);
    return { id, text };
  });
  return {
    title,
    background,
    goal,
    scope,
    acceptanceCriteria,
    priority: normalizePriority(row.priority),
    risk,
  };
}

function readText(value: unknown, field: string, max: number, required = false): string {
  if (value === undefined && !required) return '';
  if (typeof value !== 'string') throw new RequirementValidationError(`${field} must be text`);
  if (value.length > max) throw new RequirementValidationError(`${field} exceeds ${max} characters`);
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value)) {
    throw new RequirementValidationError(`${field} contains control characters`);
  }
  const trimmed = value.trim();
  if (required && !trimmed) throw new RequirementValidationError(`${field} is required`);
  return required ? trimmed : value;
}

function canonicalJson(content: RequirementContent): string {
  return JSON.stringify({
    title: content.title,
    background: content.background,
    goal: content.goal,
    scope: content.scope,
    acceptanceCriteria: content.acceptanceCriteria.map(item => ({ id: item.id, text: item.text })),
    priority: content.priority,
    risk: content.risk,
  });
}

function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

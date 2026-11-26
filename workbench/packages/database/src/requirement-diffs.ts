import { createHash, randomUUID } from 'node:crypto';
import type Sqlite from 'better-sqlite3';
import {
  canonicalJson, diffRequirementVersions, diffSha256,
  type RequirementDiff, type RequirementDiffSummary,
} from './requirement-diff.js';
import { RequirementNotFoundError, RequirementValidationError, type RequirementRepository } from './requirements.js';

/** A stored comparison without its changes: what a list of comparisons needs. */
export interface RequirementDiffRecord {
  id: string;
  requirement_id: string;
  base_version: number;
  target_version: number;
  base_version_id: string;
  target_version_id: string;
  /** Content hash of the two versions that were compared. */
  base_sha256: string;
  target_sha256: string;
  /** SHA-256 of the diff's canonical JSON text. */
  diff_sha256: string;
  summary: RequirementDiffSummary;
  created_at: string;
}
export interface StoredRequirementDiff extends RequirementDiffRecord {
  diff: RequirementDiff;
}

interface DiffRow {
  id: string;
  requirement_id: string;
  base_version: number;
  target_version: number;
  base_version_id: string;
  target_version_id: string;
  base_sha256: string;
  target_sha256: string;
  diff_json: string;
  diff_sha256: string;
  created_at: string;
}

const SELECT = `
  SELECT d.id, b.requirement_id, b.version AS base_version, t.version AS target_version,
         d.base_version_id, d.target_version_id, b.content_sha256 AS base_sha256, t.content_sha256 AS target_sha256,
         d.diff_json, d.diff_sha256, d.created_at
  FROM requirement_diffs d
  JOIN requirement_versions b ON b.id = d.base_version_id
  JOIN requirement_versions t ON t.id = d.target_version_id
`;

/**
 * Comparisons of two versions of one requirement, kept in `requirement_diffs`.
 *
 * A version never changes, so a comparison of two versions is always the same result. The same pair is therefore
 * stored once: asking for it again gives the stored result, and a stored result that would differ from what the
 * engine computes now is refused as damaged.
 */
export class RequirementDiffRepository {
  constructor(private readonly db: Sqlite.Database, private readonly requirements: RequirementRepository) {}

  create(
    requirementId: string, baseVersionInput: number, targetVersionInput: number,
  ): { record: StoredRequirementDiff; created: boolean } {
    const baseVersion = readVersion(baseVersionInput, 'baseVersion');
    const targetVersion = readVersion(targetVersionInput, 'targetVersion');
    if (baseVersion === targetVersion) {
      throw new RequirementValidationError('baseVersion and targetVersion must differ');
    }
    // Both versions must belong to this requirement; a version of another one is not found here.
    const base = this.requirements.version(requirementId, baseVersion);
    const target = this.requirements.version(requirementId, targetVersion);
    if (!base || !target) throw new RequirementNotFoundError();
    const diff = diffRequirementVersions(base, target);
    const text = canonicalJson(diff);
    const sha256 = diffSha256(diff);
    return this.write(() => {
      const existing = this.row(`${SELECT} WHERE d.base_version_id = ? AND d.target_version_id = ?`, base.id, target.id);
      if (existing) {
        if (existing.diff_json !== text || existing.diff_sha256 !== sha256) {
          throw new Error('A stored requirement diff does not match its snapshots');
        }
        return { record: toStored(existing), created: false };
      }
      const id = randomUUID();
      this.db.prepare(`
        INSERT INTO requirement_diffs(id, base_version_id, target_version_id, diff_json, diff_sha256, created_at)
        VALUES (@id, @base_version_id, @target_version_id, @diff_json, @diff_sha256, @created_at)
      `).run({
        id, base_version_id: base.id, target_version_id: target.id,
        diff_json: text, diff_sha256: sha256, created_at: new Date().toISOString(),
      });
      return { record: toStored(this.row(`${SELECT} WHERE d.id = ?`, id)!), created: true };
    });
  }

  /**
   * Every comparison of one requirement, the newest first, without the changes. Two comparisons made in the same
   * millisecond would sort by their random ids, so the order is the order in which the rows were inserted.
   */
  list(requirementId: string): RequirementDiffRecord[] {
    const rows = this.db.prepare(`${SELECT} WHERE b.requirement_id = ? ORDER BY d.rowid DESC`).all(requirementId) as DiffRow[];
    return rows.map(toRecord);
  }

  /** One comparison of one requirement with its changes; null when there is none. */
  find(requirementId: string, diffId: string): StoredRequirementDiff | null {
    const row = this.row(`${SELECT} WHERE d.id = ? AND b.requirement_id = ?`, diffId, requirementId);
    return row ? toStored(row) : null;
  }

  private row(sql: string, ...parameters: unknown[]): DiffRow | null {
    return (this.db.prepare(sql).get(...parameters) as DiffRow | undefined) ?? null;
  }

  private write<T>(callback: () => T): T {
    return this.db.transaction(callback).immediate();
  }
}

function readVersion(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw new RequirementValidationError(`${field} must be a positive integer`);
  }
  return value as number;
}

function toRecord(row: DiffRow): RequirementDiffRecord {
  const { diff: _diff, ...record } = toStored(row);
  return record;
}

function toStored(row: DiffRow): StoredRequirementDiff {
  // The row has to be the result it claims to be: its text hashes to its hash, and the diff names the two versions
  // it is stored under.
  if (sha256(row.diff_json) !== row.diff_sha256) throw new Error('A stored requirement diff does not match its hash');
  let diff: unknown;
  try { diff = JSON.parse(row.diff_json); } catch { throw new Error('A stored requirement diff is not valid JSON'); }
  if (!isDiff(diff)) throw new Error('A stored requirement diff has an unknown shape');
  if (diff.base_sha256 !== row.base_sha256 || diff.target_sha256 !== row.target_sha256) {
    throw new Error('A stored requirement diff does not name the versions it is stored under');
  }
  return {
    id: row.id, requirement_id: row.requirement_id, base_version: row.base_version, target_version: row.target_version,
    base_version_id: row.base_version_id, target_version_id: row.target_version_id,
    base_sha256: row.base_sha256, target_sha256: row.target_sha256, diff_sha256: row.diff_sha256,
    summary: diff.summary, created_at: row.created_at, diff,
  };
}

const sha256 = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex');
const HASH = /^[0-9a-f]{64}$/;

/** The outline of a diff of this engine; the changes themselves are trusted only after the hash check above. */
function isDiff(value: unknown): value is RequirementDiff {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const diff = value as Record<string, unknown>;
  if (diff.schema !== 1 || typeof diff.base_sha256 !== 'string' || !HASH.test(diff.base_sha256)) return false;
  if (typeof diff.target_sha256 !== 'string' || !HASH.test(diff.target_sha256)) return false;
  const summary = diff.summary;
  if (!summary || typeof summary !== 'object' || Array.isArray(summary)) return false;
  if (!(Object.values(summary) as unknown[]).every(count => Number.isSafeInteger(count) && (count as number) >= 0)) return false;
  if (!Array.isArray(diff.unchanged) || !diff.unchanged.every(pointer => typeof pointer === 'string')) return false;
  return Array.isArray(diff.changes) && diff.changes.every(change => Boolean(change) && typeof change === 'object' &&
    typeof (change as { pointer?: unknown }).pointer === 'string');
}

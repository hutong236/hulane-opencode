import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  RequirementNotFoundError, RequirementValidationError, WorkbenchDatabase,
  canonicalJson, diffRequirementVersions, diffSha256, type RequirementContent,
} from '../src/index.ts';

function fixture() {
  const dir = mkdtempSync(join(realpathSync(tmpdir()), 'wb-requirement-diff-spec-'));
  const database = new WorkbenchDatabase({ dataDirectory: dir, busyTimeoutMs: 50 });
  return { dir, database, dispose: () => { database.close(); rmSync(dir, { recursive: true, force: true }); } };
}

function content(title: string, overrides: Partial<RequirementContent> = {}): RequirementContent {
  return {
    title, background: 'A background', goal: 'Ship it', scope: 'Workbench only',
    acceptanceCriteria: [{ id: 'AC-1', text: 'The first criterion holds' }], priority: 'high', risk: 'Low', ...overrides,
  };
}
const sha256 = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex');
const storedCount = (database: WorkbenchDatabase): number =>
  (database.connection.prepare('SELECT count(*) AS n FROM requirement_diffs').get() as { n: number }).n;

/** A requirement with three versions, the third one with another title and one criterion fewer. */
function threeVersions(database: WorkbenchDatabase): string {
  const created = database.requirements.create({
    requirementKey: 'REQ-001', content: content('V1', {
      acceptanceCriteria: [{ id: 'AC-1', text: 'first' }, { id: 'AC-2', text: 'second' }],
    }), actor: 'alice', summary: 'Create',
  });
  database.requirements.update(created.id, 1, content('V2'), 'alice', 'Second');
  database.requirements.update(created.id, 2, content('V3', { risk: 'A little' }), 'alice', 'Third');
  return created.id;
}

test('a comparison is computed from the two versions, stored once and given back unchanged', () => {
  const x = fixture();
  try {
    const id = threeVersions(x.database);
    const versions = x.database.requirements.versions(id);
    const first = x.database.requirementDiffs.create(id, 1, 3);
    assert.equal(first.created, true);
    const record = first.record;
    assert.match(record.id, /^[0-9a-f-]{36}$/);
    assert.equal(record.requirement_id, id);
    assert.deepEqual([record.base_version, record.target_version], [1, 3]);
    assert.equal(record.base_version_id, versions[0].id);
    assert.equal(record.target_version_id, versions[2].id);
    assert.equal(record.base_sha256, versions[0].content_sha256);
    assert.equal(record.target_sha256, versions[2].content_sha256);
    // The diff is what the engine says for these two snapshots, and its hash is the hash of that diff.
    assert.deepEqual(record.diff, diffRequirementVersions(versions[0], versions[2]));
    assert.equal(record.diff_sha256, diffSha256(record.diff));
    // Another title, another risk, another text for AC-1 and AC-2 gone; four fields are the same.
    assert.deepEqual(record.summary, { added: 0, modified: 3, deleted: 1, needs_review: 0, unchanged: 4 });
    assert.deepEqual(record.diff.changes.map(change => change.pointer), [
      '/acceptanceCriteria[id=AC-1]/text', '/acceptanceCriteria[id=AC-2]', '/risk', '/title',
    ]);

    // The same pair again is the stored result, not a second row.
    const again = x.database.requirementDiffs.create(id, 1, 3);
    assert.equal(again.created, false);
    assert.deepEqual(again.record, record);
    assert.equal(storedCount(x.database), 1);

    // The other way round is another comparison.
    const reverse = x.database.requirementDiffs.create(id, 3, 1);
    assert.equal(reverse.created, true);
    assert.notEqual(reverse.record.id, record.id);
    assert.deepEqual(reverse.record.summary, { added: 1, modified: 3, deleted: 0, needs_review: 0, unchanged: 4 });

    // The list has no changes and the newest first; one comparison is read with its changes.
    const listed = x.database.requirementDiffs.list(id);
    assert.deepEqual(listed.map(entry => [entry.id, entry.base_version, entry.target_version]),
      [[reverse.record.id, 3, 1], [record.id, 1, 3]]);
    assert.equal('diff' in listed[1], false);
    assert.deepEqual(listed[1].summary, record.summary);
    assert.deepEqual(x.database.requirementDiffs.find(id, record.id), record);
    assert.equal(x.database.requirementDiffs.find(id, '11111111-1111-4111-8111-111111111111'), null);

    // Closing and opening the database again changes nothing.
    x.database.close();
    const reopened = new WorkbenchDatabase({ dataDirectory: x.dir });
    try {
      assert.deepEqual(reopened.requirementDiffs.find(id, record.id), record);
      assert.equal(reopened.requirementDiffs.list(id).length, 2);
    } finally { reopened.close(); x.database.close(); }
  } finally { x.dispose(); }
});

test('the stored text is what its hash says, and later versions do not touch a stored comparison', () => {
  const x = fixture();
  try {
    const id = threeVersions(x.database);
    const { record } = x.database.requirementDiffs.create(id, 1, 2);
    const row = x.database.connection.prepare('SELECT diff_json, diff_sha256, created_at FROM requirement_diffs WHERE id = ?')
      .get(record.id) as { diff_json: string; diff_sha256: string; created_at: string };
    assert.equal(sha256(row.diff_json), row.diff_sha256);
    assert.equal(row.diff_json, canonicalJson(record.diff));
    assert.equal((JSON.parse(row.diff_json) as { schema: number }).schema, 1);

    // A fourth version, and a restore: the comparison of V1 and V2 is still the same text with the same hash.
    x.database.requirements.update(id, 3, content('V4'), 'alice', 'Fourth');
    x.database.requirements.restore(id, 1, 4, 'alice', 'Back to the first text');
    assert.equal(x.database.requirements.versions(id).length, 5);
    const after = x.database.connection.prepare('SELECT diff_json, diff_sha256, created_at FROM requirement_diffs WHERE id = ?')
      .get(record.id) as { diff_json: string; diff_sha256: string; created_at: string };
    assert.deepEqual(after, row);
    // Asking for the same pair after all that gives the stored row, not a new one.
    assert.equal(x.database.requirementDiffs.create(id, 1, 2).created, false);
  } finally { x.dispose(); }
});

test('what cannot be compared is refused, with the kind of mistake', () => {
  const x = fixture();
  try {
    const id = threeVersions(x.database);
    const other = x.database.requirements.create({
      requirementKey: 'REQ-002', content: content('Other'), actor: 'alice', summary: 'Create',
    }).id;
    const notFound = (error: unknown): boolean => error instanceof RequirementNotFoundError;
    const invalid = (error: unknown): boolean => error instanceof RequirementValidationError;

    // Versions are looked up under this requirement only.
    assert.throws(() => x.database.requirementDiffs.create(id, 1, 99), notFound);
    assert.throws(() => x.database.requirementDiffs.create('11111111-1111-4111-8111-111111111111', 1, 2), notFound);
    assert.equal(storedCount(x.database), 0);

    for (const [base, target] of [[1, 1], [3, 3], [0, 1], [1, -1], [1.5, 2], ['1', 2], [undefined, 2], [1, null]]) {
      assert.throws(() => x.database.requirementDiffs.create(id, base as number, target as number), invalid,
        `${String(base)} to ${String(target)}`);
    }
    // The other requirement has one version, so its second version is not found under it.
    assert.throws(() => x.database.requirementDiffs.create(other, 1, 2), notFound);
    // A valid pair of this requirement is not refused.
    assert.equal(x.database.requirementDiffs.create(id, 1, 2).created, true);
    assert.equal(storedCount(x.database), 1);
  } finally { x.dispose(); }
});

test('a stored comparison that was changed is refused, not shown as the result', () => {
  const x = fixture();
  try {
    const id = threeVersions(x.database);
    const { record } = x.database.requirementDiffs.create(id, 1, 3);
    const tamper = (diff_json: string, diff_sha256: string) => {
      x.database.connection.prepare('UPDATE requirement_diffs SET diff_json = ?, diff_sha256 = ? WHERE id = ?')
        .run(diff_json, diff_sha256, record.id);
    };
    // The text no longer hashes to its hash.
    const row = x.database.connection.prepare('SELECT diff_json FROM requirement_diffs WHERE id = ?').get(record.id) as
      { diff_json: string };
    tamper(row.diff_json.replace('"modified"', '"MODIFIED"'), record.diff_sha256);
    assert.throws(() => x.database.requirementDiffs.find(id, record.id), /does not match its hash/);
    assert.throws(() => x.database.requirementDiffs.list(id), /does not match its hash/);
    // Asking for the same pair compares the stored text with what the engine computes and refuses the row.
    assert.throws(() => x.database.requirementDiffs.create(id, 1, 3), /does not match its snapshots/);

    // A text that hashes to its hash but is not a diff of this engine.
    const foreign = '{"schema":9}';
    tamper(foreign, sha256(foreign));
    assert.throws(() => x.database.requirementDiffs.find(id, record.id), /unknown shape/);

    // A genuine diff of another pair, put under this row with its own hash: it names other snapshots.
    const swap = x.database.connection.prepare('SELECT diff_json, diff_sha256 FROM requirement_diffs WHERE id = ?')
      .get(x.database.requirementDiffs.create(id, 2, 3).record.id) as { diff_json: string; diff_sha256: string };
    tamper(swap.diff_json, swap.diff_sha256);
    assert.throws(() => x.database.requirementDiffs.find(id, record.id), /does not name the versions/);
    assert.throws(() => x.database.requirementDiffs.create(id, 1, 3), /does not match its snapshots/);
  } finally { x.dispose(); }
});

test('a comparison that has to be asked about is stored as such', () => {
  const x = fixture();
  try {
    const created = x.database.requirements.create({
      requirementKey: 'REQ-009', content: content('Renamed', {
        acceptanceCriteria: [{ id: 'AC-1', text: 'the same text' }, { id: 'AC-2', text: 'kept' }],
      }), actor: 'alice', summary: 'Create',
    });
    x.database.requirements.update(created.id, 1, content('Renamed', {
      acceptanceCriteria: [{ id: 'AC-9', text: 'the same text' }, { id: 'AC-2', text: 'kept' }],
    }), 'alice', 'Another id for the first criterion');
    const { record } = x.database.requirementDiffs.create(created.id, 1, 2);
    assert.equal(record.summary.needs_review, 1);
    assert.equal(record.diff.changes.length, 1);
    const change = record.diff.changes[0];
    assert.ok(change.op === 'needs_review' && change.reason === 'possible_rename');
    assert.equal(x.database.requirementDiffs.list(created.id)[0].summary.needs_review, 1);
  } finally { x.dispose(); }
});

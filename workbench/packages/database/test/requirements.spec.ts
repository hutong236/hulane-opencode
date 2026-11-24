import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  RequirementConflictError, RequirementValidationError, WorkbenchDatabase,
  type RequirementContent,
} from '../src/index.ts';

function fixture() {
  const dir = mkdtempSync(join(realpathSync(tmpdir()), 'wb-requirement-spec-'));
  const database = new WorkbenchDatabase({ dataDirectory: dir, busyTimeoutMs: 50 });
  return { dir, database, dispose: () => { database.close(); rmSync(dir, { recursive: true, force: true }); } };
}

function content(title: string, overrides: Partial<RequirementContent> = {}): RequirementContent {
  return {
    title,
    background: 'A reproducible background',
    goal: 'Ship the requirement',
    scope: 'Workbench only',
    acceptanceCriteria: [{ id: 'AC-1', text: 'The first criterion holds' }],
    priority: 'high',
    risk: 'Low risk',
    ...overrides,
  };
}

test('requirement saves produce append-only versions with author, summary and stable content hash', () => {
  const x = fixture();
  try {
    const created = x.database.requirements.create({
      requirementKey: 'req-001', content: content('V1 title'), actor: 'alice', summary: 'Create REQ-001',
    });
    assert.equal(created.requirement_key, 'REQ-001');
    assert.equal(created.status, 'draft');
    assert.equal(created.current_version, 1);
    assert.equal(created.revision, 1);
    assert.match(created.content_sha256, /^[0-9a-f]{64}$/);

    const second = x.database.requirements.update(
      created.id, 1, content('V2 title'), 'bob', 'Clarify the scope',
    );
    const third = x.database.requirements.update(
      second.id, 2, content('V3 title'), 'carol', 'Final wording',
    );
    assert.equal(third.current_version, 3);
    assert.equal(third.revision, 3);
    assert.equal(x.database.requirements.list().length, 1);

    const versions = x.database.requirements.versions(created.id);
    assert.deepEqual(versions.map(version => version.version), [1, 2, 3]);
    assert.deepEqual(versions.map(version => version.content.title), ['V1 title', 'V2 title', 'V3 title']);
    assert.deepEqual(versions.map(version => version.actor), ['alice', 'bob', 'carol']);
    assert.deepEqual(versions.map(version => version.summary), ['Create REQ-001', 'Clarify the scope', 'Final wording']);
    assert.equal(new Set(versions.map(version => version.content_sha256)).size, 3);

    // Reading and comparing snapshots never modifies the stored bytes.
    const firstSnapshot = x.database.requirements.version(created.id, 1);
    assert.deepEqual(firstSnapshot?.content, content('V1 title'));
    assert.equal(x.database.requirements.version(created.id, 1)?.content_sha256, versions[0]?.content_sha256);
    assert.throws(() => x.database.connection.prepare(
      'UPDATE requirement_versions SET content_json = ? WHERE id = ?',
    ).run(JSON.stringify(content('Tampered')), versions[0]!.id), /immutable/);
    assert.throws(() => x.database.connection.prepare(
      'DELETE FROM requirement_versions WHERE id = ?',
    ).run(versions[0]!.id), /immutable/);
    assert.deepEqual(x.database.requirements.versions(created.id).map(version => version.content.title),
      ['V1 title', 'V2 title', 'V3 title']);
  } finally { x.dispose(); }
});

test('revision CAS rejects stale saves without losing the winning update', () => {
  const x = fixture();
  const second = new WorkbenchDatabase({ dataDirectory: x.dir, busyTimeoutMs: 50 });
  try {
    const created = x.database.requirements.create({
      requirementKey: 'REQ-002', content: content('Original'), actor: 'alice', summary: 'Create',
    });
    assert.equal(x.database.requirements.update(created.id, 1, content('Winner'), 'alice', 'First save').revision, 2);
    assert.throws(
      () => second.requirements.update(created.id, 1, content('Loser'), 'bob', 'Stale save'),
      RequirementConflictError,
    );
    const current = second.requirements.find(created.id);
    assert.equal(current?.content.title, 'Winner');
    assert.equal(current?.revision, 2);
    assert.equal(second.requirements.versions(created.id).length, 2);
  } finally {
    second.close();
    x.dispose();
  }
});

test('requirement status follows draft to reviewed to approved with CAS', () => {
  const x = fixture();
  try {
    const created = x.database.requirements.create({
      requirementKey: 'REQ-003', content: content('Status'),
      actor: 'alice', summary: 'Create',
    });
    assert.throws(
      () => x.database.requirements.transition(created.id, 1, 'approved', 'alice', 'Skip review'),
      RequirementConflictError,
    );
    assert.throws(
      () => x.database.requirements.transition(created.id, 99, 'reviewed', 'alice', 'Stale'),
      RequirementConflictError,
    );
    assert.equal(x.database.requirements.transition(
      created.id, 1, 'reviewed', 'alice', 'Ready for review',
    ).status, 'reviewed');
    assert.equal(x.database.requirements.transition(
      created.id, 2, 'approved', 'bob', 'Approved',
    ).status, 'approved');
    assert.throws(
      () => x.database.requirements.update(created.id, 3, content('Approved edit'), 'alice', 'Edit'),
      RequirementConflictError,
    );
    assert.equal(x.database.requirements.transition(
      created.id, 3, 'archived', 'bob', 'Archive',
    ).status, 'archived');
    assert.throws(
      () => x.database.requirements.transition(created.id, 4, 'draft', 'bob', 'Back to draft'),
      RequirementConflictError,
    );
    assert.equal(x.database.requirements.versions(created.id).length, 1);
  } finally { x.dispose(); }
});

test('restoring a history snapshot creates a new draft version and keeps the source read-only', () => {
  const x = fixture();
  try {
    const created = x.database.requirements.create({
      requirementKey: 'REQ-004', content: content('V1'), actor: 'alice', summary: 'Create',
    });
    x.database.requirements.update(created.id, 1, content('V2'), 'alice', 'Second');
    x.database.requirements.update(created.id, 2, content('V3'), 'alice', 'Third');
    const restored = x.database.requirements.restore(created.id, 1, 3, 'bob', 'Restore V1 as draft');
    assert.equal(restored.status, 'draft');
    assert.equal(restored.current_version, 4);
    assert.equal(restored.revision, 4);
    assert.deepEqual(restored.content, content('V1'));
    const versions = x.database.requirements.versions(created.id);
    assert.deepEqual(versions.map(version => version.version), [1, 2, 3, 4]);
    assert.deepEqual(versions.map(version => version.content.title), ['V1', 'V2', 'V3', 'V1']);
    assert.equal(versions[0]?.summary, 'Create');
    assert.equal(versions[3]?.summary, 'Restore V1 as draft');
    assert.throws(
      () => x.database.requirements.restore(created.id, 99, 4, 'bob', 'Missing source'),
      /not found/i,
    );
  } finally { x.dispose(); }
});

test('requirement input validation and duplicate keys fail before writing partial rows', () => {
  const x = fixture();
  try {
    x.database.requirements.create({
      requirementKey: 'REQ-005', content: content('Unique'), actor: 'alice', summary: 'Create',
    });
    assert.throws(() => x.database.requirements.create({
      requirementKey: 'REQ-005', content: content('Duplicate'), actor: 'alice', summary: 'Create',
    }), RequirementConflictError);
    assert.throws(() => x.database.requirements.create({
      requirementKey: 'BAD-KEY', content: content('Invalid key'), actor: 'alice', summary: 'Create',
    }), RequirementValidationError);
    assert.throws(() => x.database.requirements.create({
      requirementKey: 'REQ-006', content: content(''), actor: 'alice', summary: 'Create',
    }), RequirementValidationError);
    assert.throws(() => x.database.requirements.create({
      requirementKey: 'REQ-007',
      content: content('Bad priority', { priority: 'urgent' as RequirementContent['priority'] }),
      actor: 'alice', summary: 'Create',
    }), RequirementValidationError);
    assert.throws(() => x.database.requirements.create({
      requirementKey: 'REQ-008',
      content: content('Duplicate criteria', {
        acceptanceCriteria: [{ id: 'AC-1', text: 'one' }, { id: 'AC-1', text: 'two' }],
      }),
      actor: 'alice', summary: 'Create',
    }), RequirementValidationError);
    assert.throws(() => x.database.requirements.create({
      requirementKey: 'REQ-009',
      content: content('Too many criteria', {
        acceptanceCriteria: Array.from({ length: 51 }, (_, index) => ({ id: `AC-${index}`, text: 'x' })),
      }),
      actor: 'alice', summary: 'Create',
    }), RequirementValidationError);
    assert.throws(() => x.database.requirements.create({
      requirementKey: 'REQ-010', content: content('No actor'), actor: ' ', summary: 'Create',
    }), RequirementValidationError);
    assert.equal(x.database.requirements.list().length, 1);
    assert.equal(x.database.requirements.versions(
      x.database.requirements.findByKey('REQ-005')!.id,
    ).length, 1);
  } finally { x.dispose(); }
});

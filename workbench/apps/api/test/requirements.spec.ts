import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { WorkbenchDatabase } from '@hulane/workbench-database';
import { buildApp } from '../src/app.js';
import { fixturePrefix } from './fixture-prefix.js';

const unknownId = '00000000-0000-4000-8000-000000000000';

function requirement(title: string, overrides: Record<string, unknown> = {}) {
  return {
    requirementKey: 'REQ-001',
    title,
    background: 'Background',
    goal: 'Goal',
    scope: 'Scope',
    acceptanceCriteria: [{ id: 'AC-1', text: 'Criterion one' }],
    priority: 'high',
    risk: 'Risk',
    actor: 'alice',
    summary: 'Create REQ-001',
    ...overrides,
  };
}

test('requirement API creates, lists and keeps V1/V2/V3 history immutable', async () => {
  const temp = mkdtempSync(fixturePrefix('wb-requirement-api-'));
  const db = new WorkbenchDatabase({ dataDirectory: join(temp, 'data') });
  const app = buildApp({ database: db });
  try {
    const invalid = await app.inject({
      method: 'POST', url: '/api/requirements', payload: requirement('V1', { title: ' ' }),
    });
    assert.equal(invalid.statusCode, 400);

    const created = await app.inject({
      method: 'POST', url: '/api/requirements', payload: requirement('V1 title'),
    });
    assert.equal(created.statusCode, 201);
    const first = created.json();
    assert.equal(first.requirement_key, 'REQ-001');
    assert.equal(first.status, 'draft');
    assert.equal(first.current_version, 1);
    assert.equal(first.revision, 1);
    assert.match(first.content_sha256, /^[0-9a-f]{64}$/);

    const list = await app.inject({ method: 'GET', url: '/api/requirements' });
    assert.equal(list.statusCode, 200);
    assert.equal(list.json().requirements.length, 1);
    const detail = await app.inject({ method: 'GET', url: `/api/requirements/${first.id}` });
    assert.equal(detail.statusCode, 200);
    assert.equal(detail.json().content.title, 'V1 title');

    const second = await app.inject({
      method: 'PUT', url: `/api/requirements/${first.id}`,
      payload: requirement('V2 title', { expectedRevision: 1, actor: 'bob', summary: 'Clarify scope' }),
    });
    assert.equal(second.statusCode, 200);
    assert.equal(second.json().current_version, 2);
    assert.equal(second.json().revision, 2);
    const third = await app.inject({
      method: 'PUT', url: `/api/requirements/${first.id}`,
      payload: requirement('V3 title', { expectedRevision: 2, actor: 'carol', summary: 'Final wording' }),
    });
    assert.equal(third.statusCode, 200);
    assert.equal(third.json().current_version, 3);
    assert.equal(third.json().revision, 3);

    const history = await app.inject({ method: 'GET', url: `/api/requirements/${first.id}/versions` });
    assert.equal(history.statusCode, 200);
    const versions = history.json().versions as Array<Record<string, unknown>>;
    assert.deepEqual(versions.map(version => version.version), [1, 2, 3]);
    assert.deepEqual(versions.map(version => (version.content as { title: string }).title),
      ['V1 title', 'V2 title', 'V3 title']);
    assert.deepEqual(versions.map(version => version.actor), ['alice', 'bob', 'carol']);
    assert.equal(new Set(versions.map(version => version.content_sha256)).size, 3);

    const snapshot = await app.inject({ method: 'GET', url: `/api/requirements/${first.id}/versions/1` });
    assert.equal(snapshot.statusCode, 200);
    assert.equal(snapshot.json().content.title, 'V1 title');
    assert.equal(snapshot.json().summary, 'Create REQ-001');
    assert.equal(snapshot.json().content_sha256, versions[0]?.content_sha256);
    assert.equal((await app.inject({
      method: 'GET', url: `/api/requirements/${first.id}/versions/99`,
    })).statusCode, 404);
    assert.equal((await app.inject({
      method: 'GET', url: `/api/requirements/${first.id}/versions/0`,
    })).statusCode, 400);
    // There is deliberately no route that rewrites a stored version.
    assert.equal((await app.inject({
      method: 'PUT', url: `/api/requirements/${first.id}/versions/1`,
      payload: requirement('Tampered', { expectedRevision: 3 }),
    })).statusCode, 404);
  } finally {
    await app.close();
    db.close();
    rmSync(temp, { recursive: true, force: true });
  }
});

test('requirement API rejects stale CAS saves and illegal status transitions without data loss', async () => {
  const temp = mkdtempSync(fixturePrefix('wb-requirement-cas-'));
  const db = new WorkbenchDatabase({ dataDirectory: join(temp, 'data') });
  const app = buildApp({ database: db });
  try {
    const created = (await app.inject({
      method: 'POST', url: '/api/requirements', payload: requirement('Original', { requirementKey: 'REQ-002' }),
    })).json();
    const staleSave = await app.inject({
      method: 'PUT', url: `/api/requirements/${created.id}`,
      payload: requirement('Stale', { requirementKey: 'REQ-002', expectedRevision: 99, summary: 'Stale save' }),
    });
    assert.equal(staleSave.statusCode, 409);
    assert.ok(!staleSave.body.includes('SQLITE'));
    const staleTransition = await app.inject({
      method: 'POST', url: `/api/requirements/${created.id}/transitions`,
      payload: { expectedRevision: 99, status: 'reviewed', actor: 'bob', summary: 'Stale review' },
    });
    assert.equal(staleTransition.statusCode, 409);

    const reviewed = await app.inject({
      method: 'POST', url: `/api/requirements/${created.id}/transitions`,
      payload: { expectedRevision: 1, status: 'reviewed', actor: 'bob', summary: 'Ready for review' },
    });
    assert.equal(reviewed.statusCode, 200);
    assert.equal(reviewed.json().status, 'reviewed');
    const backwards = await app.inject({
      method: 'POST', url: `/api/requirements/${created.id}/transitions`,
      payload: { expectedRevision: 2, status: 'draft', actor: 'bob', summary: 'Back to draft' },
    });
    assert.equal(backwards.statusCode, 409);
    const approved = await app.inject({
      method: 'POST', url: `/api/requirements/${created.id}/transitions`,
      payload: { expectedRevision: 2, status: 'approved', actor: 'carol', summary: 'Approved' },
    });
    assert.equal(approved.statusCode, 200);
    assert.equal(approved.json().status, 'approved');
    const approvedEdit = await app.inject({
      method: 'PUT', url: `/api/requirements/${created.id}`,
      payload: requirement('Edit after approval', { requirementKey: 'REQ-002', expectedRevision: 3 }),
    });
    assert.equal(approvedEdit.statusCode, 409);

    const current = (await app.inject({ method: 'GET', url: `/api/requirements/${created.id}` })).json();
    assert.equal(current.content.title, 'Original');
    assert.equal(current.revision, 3);
    const versions = (await app.inject({ method: 'GET', url: `/api/requirements/${created.id}/versions` })).json();
    assert.equal(versions.versions.length, 1);
    assert.equal(versions.versions[0].content.title, 'Original');
  } finally {
    await app.close();
    db.close();
    rmSync(temp, { recursive: true, force: true });
  }
});

test('requirement restore copies an old snapshot into a new draft and leaves history unchanged', async () => {
  const temp = mkdtempSync(fixturePrefix('wb-requirement-restore-'));
  const db = new WorkbenchDatabase({ dataDirectory: join(temp, 'data') });
  const app = buildApp({ database: db });
  try {
    const created = (await app.inject({
      method: 'POST', url: '/api/requirements', payload: requirement('V1', { requirementKey: 'REQ-003' }),
    })).json();
    await app.inject({
      method: 'PUT', url: `/api/requirements/${created.id}`,
      payload: requirement('V2', { requirementKey: 'REQ-003', expectedRevision: 1, summary: 'Second' }),
    });
    await app.inject({
      method: 'PUT', url: `/api/requirements/${created.id}`,
      payload: requirement('V3', { requirementKey: 'REQ-003', expectedRevision: 2, summary: 'Third' }),
    });
    const restored = await app.inject({
      method: 'POST', url: `/api/requirements/${created.id}/restore`,
      payload: { version: 1, expectedRevision: 3, actor: 'bob', summary: 'Restore V1 as draft' },
    });
    assert.equal(restored.statusCode, 200);
    assert.equal(restored.json().status, 'draft');
    assert.equal(restored.json().current_version, 4);
    assert.equal(restored.json().content.title, 'V1');

    const history = (await app.inject({ method: 'GET', url: `/api/requirements/${created.id}/versions` })).json();
    assert.deepEqual(history.versions.map((version: { version: number }) => version.version), [1, 2, 3, 4]);
    assert.deepEqual(history.versions.map((version: { content: { title: string } }) => version.content.title),
      ['V1', 'V2', 'V3', 'V1']);
    assert.equal(history.versions[0].summary, 'Create REQ-001');
    const staleRestore = await app.inject({
      method: 'POST', url: `/api/requirements/${created.id}/restore`,
      payload: { version: 2, expectedRevision: 3, actor: 'bob', summary: 'Stale restore' },
    });
    assert.equal(staleRestore.statusCode, 409);
    const missingSource = await app.inject({
      method: 'POST', url: `/api/requirements/${created.id}/restore`,
      payload: { version: 99, expectedRevision: 4, actor: 'bob', summary: 'Missing source' },
    });
    assert.equal(missingSource.statusCode, 404);
  } finally {
    await app.close();
    db.close();
    rmSync(temp, { recursive: true, force: true });
  }
});

test('requirement API validates IDs, duplicate keys and unsafe or oversized fields', async () => {
  const temp = mkdtempSync(fixturePrefix('wb-requirement-validation-'));
  const db = new WorkbenchDatabase({ dataDirectory: join(temp, 'data') });
  const app = buildApp({ database: db });
  try {
    const created = await app.inject({
      method: 'POST', url: '/api/requirements', payload: requirement('Valid', { requirementKey: 'REQ-004' }),
    });
    assert.equal(created.statusCode, 201);
    const id = created.json().id as string;

    for (const [url, expected] of [
      ['/api/requirements/not-a-uuid', 400],
      [`/api/requirements/${unknownId}`, 404],
      [`/api/requirements/${unknownId}/versions`, 404],
    ] as const) {
      assert.equal((await app.inject({ method: 'GET', url })).statusCode, expected);
    }

    for (const payload of [
      requirement('Bad key', { requirementKey: 'REQ-4' }),
      requirement('x'.repeat(201), { requirementKey: 'REQ-005' }),
      requirement('Bad priority', { requirementKey: 'REQ-006', priority: 'urgent' }),
      requirement('Bad criteria', { requirementKey: 'REQ-007', acceptanceCriteria: 'not-an-array' }),
      requirement('Too many', {
        requirementKey: 'REQ-008',
        acceptanceCriteria: Array.from({ length: 51 }, (_, index) => ({ id: `AC-${index}`, text: 'x' })),
      }),
      requirement('Duplicate criteria', {
        requirementKey: 'REQ-009',
        acceptanceCriteria: [{ id: 'AC-1', text: 'one' }, { id: 'AC-1', text: 'two' }],
      }),
      requirement('Missing actor', { requirementKey: 'REQ-010', actor: ' ' }),
      requirement('Missing summary', { requirementKey: 'REQ-011', summary: '' }),
      requirement('Control character', { requirementKey: 'REQ-012', title: 'bad\u0000title' }),
    ]) {
      const response = await app.inject({ method: 'POST', url: '/api/requirements', payload });
      assert.equal(response.statusCode, 400);
    }
    assert.equal((await app.inject({
      method: 'POST', url: '/api/requirements',
      payload: requirement('Duplicate', { requirementKey: 'REQ-004' }),
    })).statusCode, 409);
    assert.equal((await app.inject({
      method: 'PUT', url: `/api/requirements/${id}`,
      payload: requirement('Missing revision', { requirementKey: 'REQ-004' }),
    })).statusCode, 400);
    assert.equal((await app.inject({
      method: 'POST', url: `/api/requirements/${id}/transitions`,
      payload: { expectedRevision: 1, status: 'done', actor: 'alice', summary: 'Invalid status' },
    })).statusCode, 400);
    assert.equal((await app.inject({
      method: 'POST', url: `/api/requirements/${id}/restore`,
      payload: { version: 0, expectedRevision: 1, actor: 'alice', summary: 'Invalid version' },
    })).statusCode, 400);

    const list = (await app.inject({ method: 'GET', url: '/api/requirements' })).json();
    assert.equal(list.requirements.length, 1);
    assert.equal(list.requirements[0].requirement_key, 'REQ-004');
  } finally {
    await app.close();
    db.close();
    rmSync(temp, { recursive: true, force: true });
  }
});

test('requirement API rejects duplicate keys in any letter case without replacing the stored version', async () => {
  const temp = mkdtempSync(fixturePrefix('wb-requirement-duplicate-'));
  const db = new WorkbenchDatabase({ dataDirectory: join(temp, 'data') });
  const app = buildApp({ database: db });
  try {
    const created = await app.inject({
      method: 'POST', url: '/api/requirements', payload: requirement('Original', { requirementKey: 'REQ-012' }),
    });
    assert.equal(created.statusCode, 201);
    for (const requirementKey of ['REQ-012', 'req-012']) {
      const duplicate = await app.inject({
        method: 'POST', url: '/api/requirements',
        payload: requirement('Replacement', { requirementKey, summary: 'Duplicate create' }),
      });
      assert.equal(duplicate.statusCode, 409);
      assert.ok(!duplicate.body.includes('SQLITE'));
    }
    const list = (await app.inject({ method: 'GET', url: '/api/requirements' })).json();
    assert.equal(list.requirements.length, 1);
    assert.equal(list.requirements[0].requirement_key, 'REQ-012');
    assert.equal(list.requirements[0].content.title, 'Original');
    const history = (await app.inject({
      method: 'GET', url: `/api/requirements/${created.json().id}/versions`,
    })).json();
    assert.equal(history.versions.length, 1);
    assert.equal(history.versions[0].content.title, 'Original');
  } finally {
    await app.close();
    db.close();
    rmSync(temp, { recursive: true, force: true });
  }
});

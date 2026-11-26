import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { WorkbenchDatabase, canonicalJson, diffRequirementVersions, type RequirementContent, type RequirementVersion } from '@hulane/workbench-database';
import { buildApp } from '../src/app.js';

interface DiffRecord {
  id: string;
  requirement_id: string;
  base_version: number;
  target_version: number;
  base_version_id: string;
  target_version_id: string;
  base_sha256: string;
  target_sha256: string;
  diff_sha256: string;
  summary: Record<string, number>;
  created_at: string;
  diff: { changes: { pointer: string }[] };
}

const content = (title: string, overrides: Partial<RequirementContent> = {}): RequirementContent => ({
  title, background: 'A background', goal: 'Ship it', scope: 'Workbench only', risk: 'Low', priority: 'high',
  acceptanceCriteria: [{ id: 'AC-1', text: 'first' }, { id: 'AC-2', text: 'second' }], ...overrides,
});
const sha256 = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex');
const NO_REQUIREMENT = '99999999-9999-4999-8999-999999999999';
const NO_DIFF = '88888888-8888-4888-8888-888888888888';

async function setup() {
  const temp = mkdtempSync(join(realpathSync(tmpdir()), 'wb-requirement-diff-api-'));
  const db = new WorkbenchDatabase({ dataDirectory: join(temp, 'data') });
  const app = buildApp({ database: db });
  const create = async (requirementKey: string, body: RequirementContent) => {
    const response = await app.inject({ method: 'POST', url: '/api/requirements',
      payload: { ...body, requirementKey, actor: 'alice', summary: 'Create' } });
    assert.equal(response.statusCode, 201, response.body);
    return (response.json() as { id: string }).id;
  };
  const revise = async (id: string, expectedRevision: number, body: RequirementContent) => {
    const response = await app.inject({ method: 'PUT', url: `/api/requirements/${id}`,
      payload: { ...body, expectedRevision, actor: 'alice', summary: 'Revise' } });
    assert.equal(response.statusCode, 200, response.body);
  };
  const compare = (id: string, payload: unknown) =>
    app.inject({ method: 'POST', url: `/api/requirements/${id}/diffs`, payload: payload as object });
  const versions = async (id: string): Promise<RequirementVersion[]> =>
    (await app.inject({ method: 'GET', url: `/api/requirements/${id}/versions` })).json().versions;
  return {
    temp, app, create, revise, compare, versions,
    dispose: async () => { await app.close(); db.close(); rmSync(temp, { recursive: true, force: true }); },
  };
}

/** A requirement with three versions: V2 has another title, V3 another risk and one criterion more. */
async function threeVersions() {
  const x = await setup();
  const id = await x.create('REQ-001', content('V1'));
  await x.revise(id, 1, content('V2'));
  await x.revise(id, 2, content('V2', {
    risk: 'A little', acceptanceCriteria: [...content('V2').acceptanceCriteria, { id: 'AC-3', text: 'third' }],
  }));
  return { ...x, id };
}

test('comparing two versions keeps the result once and gives it back', async () => {
  const { app, compare, versions, id, dispose } = await threeVersions();
  try {
    const [v1, , v3] = await versions(id);
    const first = await compare(id, { baseVersion: 1, targetVersion: 3 });
    assert.equal(first.statusCode, 201, first.body);
    const record = first.json() as DiffRecord;
    assert.match(record.id, /^[0-9a-f-]{36}$/);
    assert.equal(record.requirement_id, id);
    assert.deepEqual([record.base_version, record.target_version], [1, 3]);
    assert.equal(record.base_version_id, v1.id);
    assert.equal(record.target_version_id, v3.id);
    assert.equal(record.base_sha256, v1.content_sha256);
    assert.equal(record.target_sha256, v3.content_sha256);
    // Another title, another risk and one criterion more; six fields and items are the same.
    assert.deepEqual(record.summary, { added: 1, modified: 2, deleted: 0, needs_review: 0, unchanged: 6 });
    assert.deepEqual(record.diff.changes.map(change => change.pointer), [
      '/acceptanceCriteria[id=AC-3]', '/risk', '/title',
    ]);
    assert.equal(record.diff_sha256, sha256(canonicalJson(record.diff)));

    // The same pair again answers 200 with the stored result.
    const again = await compare(id, { baseVersion: 1, targetVersion: 3 });
    assert.equal(again.statusCode, 200, again.body);
    assert.deepEqual(again.json(), record);

    // The list has no changes; one comparison is read with them.
    const list = await app.inject({ method: 'GET', url: `/api/requirements/${id}/diffs` });
    assert.equal(list.statusCode, 200, list.body);
    const { diffs } = list.json() as { diffs: Record<string, unknown>[] };
    assert.equal(diffs.length, 1);
    assert.equal('diff' in diffs[0], false);
    assert.equal(diffs[0].id, record.id);
    assert.equal(diffs[0].diff_sha256, record.diff_sha256);
    const one = await app.inject({ method: 'GET', url: `/api/requirements/${id}/diffs/${record.id}` });
    assert.equal(one.statusCode, 200, one.body);
    assert.deepEqual(one.json(), record);
  } finally { await dispose(); }
});

test('the stored result is what the engine says for the two stored snapshots', async () => {
  const { app, compare, versions, id, dispose } = await threeVersions();
  try {
    const all = await versions(id);
    const response = await compare(id, { baseVersion: 2, targetVersion: 3 });
    assert.equal(response.statusCode, 201, response.body);
    assert.deepEqual(response.json().diff, diffRequirementVersions(all[1], all[2]));
    // The other way round is another stored comparison, and the list has the newest first. V2 and V3 share the
    // title, so going back only drops a criterion and changes the risk.
    const reverse = await compare(id, { baseVersion: 3, targetVersion: 2 });
    assert.equal(reverse.statusCode, 201, reverse.body);
    assert.deepEqual(reverse.json().summary, { added: 0, modified: 1, deleted: 1, needs_review: 0, unchanged: 7 });
    const list = (await app.inject({ method: 'GET', url: `/api/requirements/${id}/diffs` })).json().diffs as { id: string }[];
    assert.deepEqual(list.map(entry => entry.id), [reverse.json().id, response.json().id]);
  } finally { await dispose(); }
});

test('what cannot be compared is refused with a stable status and no storage detail', async () => {
  const { app, compare, create, revise, dispose } = await setup();
  try {
    const id = await create('REQ-001', content('V1'));
    await revise(id, 1, content('V2'));
    // The other requirement has one version only.
    const other = await create('REQ-002', content('Other'));
    const refused = async (method: 'GET' | 'POST', url: string, status: number, error: string, payload?: object) => {
      const response = await app.inject({ method, url, payload });
      assert.deepEqual({ status: response.statusCode, body: response.json() }, { status, body: { error } },
        `${method} ${url} ${JSON.stringify(payload ?? '')}`);
    };
    await refused('POST', '/api/requirements/not-an-id/diffs', 400, 'Invalid requirement ID', {});
    for (const payload of [{}, { baseVersion: 1, targetVersion: 1 }, { baseVersion: 0, targetVersion: 1 },
      { baseVersion: 1, targetVersion: 1.5 }, { baseVersion: '1', targetVersion: 2 }, { baseVersion: 1 }]) {
      await refused('POST', `/api/requirements/${id}/diffs`, 400, 'Invalid requirement input', payload);
    }
    await refused('POST', `/api/requirements/${NO_REQUIREMENT}/diffs`, 404, 'Requirement not found', { baseVersion: 1, targetVersion: 2 });
    await refused('POST', `/api/requirements/${id}/diffs`, 404, 'Requirement not found', { baseVersion: 1, targetVersion: 9 });
    await refused('POST', `/api/requirements/${other}/diffs`, 404, 'Requirement not found', { baseVersion: 1, targetVersion: 2 });
    await refused('GET', `/api/requirements/${NO_REQUIREMENT}/diffs`, 404, 'Requirement not found');
    await refused('GET', `/api/requirements/${id}/diffs/not-a-diff`, 400, 'Invalid requirement diff ID');
    await refused('GET', `/api/requirements/${id}/diffs/${NO_DIFF}`, 404, 'Requirement diff not found');
    // Nothing was stored by a refused request.
    assert.deepEqual((await app.inject({ method: 'GET', url: `/api/requirements/${id}/diffs` })).json(), { diffs: [] });

    // A comparison of one requirement is not found under another one.
    const stored = (await compare(id, { baseVersion: 1, targetVersion: 2 })).json() as DiffRecord;
    assert.match(stored.id, /^[0-9a-f-]{36}$/);
    await refused('GET', `/api/requirements/${other}/diffs/${stored.id}`, 404, 'Requirement diff not found');
    assert.deepEqual((await app.inject({ method: 'GET', url: `/api/requirements/${other}/diffs` })).json(), { diffs: [] });
  } finally { await dispose(); }
});

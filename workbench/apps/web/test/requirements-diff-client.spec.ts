import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  ApiError, compareRequirementVersions, getRequirementDiff, getRequirementDiffs,
} from '../src/api/client.js';

const ID = '12345678-1234-4234-8234-123456789abc';
const DIFF_ID = '22345678-1234-4234-8234-123456789abc';
const BASE = 'a'.repeat(64);
const TARGET = 'b'.repeat(64);
const HASH = 'c'.repeat(64);
const change = (op: string, pointer: string, extra: Record<string, unknown> = {}) => ({ op, pointer, ...extra });
const stored = (overrides: Record<string, unknown> = {}, diff: Record<string, unknown> = {}) => ({
  id: DIFF_ID, requirement_id: ID, base_version: 1, target_version: 2,
  base_version_id: '33333333-1234-4234-8234-123456789abc', target_version_id: '44444444-1234-4234-8234-123456789abc',
  base_sha256: BASE, target_sha256: TARGET, diff_sha256: HASH, created_at: '2026-11-25T10:00:00Z',
  summary: { added: 1, modified: 1, deleted: 1, needs_review: 1, unchanged: 1 },
  ...overrides,
  diff: {
    schema: 1, base_sha256: BASE, target_sha256: TARGET,
    summary: { added: 1, modified: 1, deleted: 1, needs_review: 1, unchanged: 1 },
    changes: [
      change('added', '/title', { value: 'T' }),
      change('modified', '/goal', { old_value: 'a', new_value: 'b' }),
      change('deleted', '/risk', { old_value: 'r' }),
      change('needs_review', '/list[id=AC-9]', {
        old_value: { id: 'AC-1', text: 'same' }, new_value: { id: 'AC-9', text: 'same' },
        reason: 'possible_rename', related: ['/list[id=AC-1]'],
      }),
    ],
    unchanged: ['/background'],
    ...diff,
  },
});

async function stub(body: unknown, status = 200): Promise<() => void> {
  const original = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify(body), { status });
  return () => { globalThis.fetch = original; }
}

test('comparing two versions posts the pair and gives the stored comparison', async () => {
  const original = globalThis.fetch;
  try {
    const calls: [string, string, unknown][] = [];
    globalThis.fetch = async (url, init) => {
      calls.push([String(url), String(init?.method), JSON.parse(String(init?.body))]);
      return new Response(JSON.stringify(stored()), { status: 201 });
    };
    const record = await compareRequirementVersions(ID, { baseVersion: 1, targetVersion: 2 });
    assert.deepEqual(calls, [[`/api/requirements/${ID}/diffs`, 'POST', { baseVersion: 1, targetVersion: 2 }]]);
    assert.equal(record.diff.changes[3].op, 'needs_review');
    assert.deepEqual((record.diff.changes[3].related), ['/list[id=AC-1]']);
    assert.equal(record.requirement_id, ID);
  } finally { globalThis.fetch = original; }
});

test('a comparison whose summary does not agree with its entries is refused as a whole', async () => {
  const broken: [string, unknown][] = [
    ['a count that does not match', stored({}, { summary: { added: 2, modified: 1, deleted: 1, needs_review: 1, unchanged: 1 } })],
    ['a change left out of the count', stored({}, { changes: [change('added', '/title', { value: 'T' })] })],
    ['an unknown kind of change', stored({}, { changes: [change('renamed', '/title')] })],
    ['an addition without a value', stored({}, {
      summary: { added: 1, modified: 0, deleted: 0, needs_review: 0, unchanged: 0 }, changes: [change('added', '/title')], unchanged: [],
    })],
    ['a modification without the old value', stored({}, {
      summary: { added: 0, modified: 1, deleted: 0, needs_review: 0, unchanged: 0 }, changes: [change('modified', '/title', { new_value: 'b' })], unchanged: [],
    })],
    ['a question without a reason', stored({}, { changes: [
      change('added', '/title', { value: 'T' }), change('modified', '/goal', { old_value: 'a', new_value: 'b' }),
      change('deleted', '/risk', { old_value: 'r' }),
      change('needs_review', '/list[id=AC-9]', { old_value: 1, new_value: 2, related: [] }),
    ] })],
    ['a negative count', stored({}, { summary: { added: -1, modified: 1, deleted: 1, needs_review: 1, unchanged: 3 } })],
    ['another schema', stored({}, { schema: 2 })],
    ['a hash that is not one', stored({}, { base_sha256: 'abc' })],
    ['a diff that names other snapshots', stored({}, { target_sha256: 'd'.repeat(64) })],
    ['the same version twice', stored({ base_version: 2, target_version: 2 })],
    ['a version that is not a number', stored({ base_version: '1' })],
    ['a diff without a hash', stored({ diff_sha256: '' })],
  ];
  for (const [name, body] of broken) {
    const restore = await stub(body, 201);
    try {
      await assert.rejects(compareRequirementVersions(ID, { baseVersion: 1, targetVersion: 2 }),
        (error: unknown) => error instanceof ApiError && error.message === 'API 返回的数据结构不正确', name);
    } finally { restore(); }
  }
});

test('a list of comparisons and one comparison are decoded, and answers to another question are refused', async () => {
  const record = stored();
  delete (record as Record<string, unknown>).diff;
  let restore = await stub({ diffs: [record] });
  try {
    assert.deepEqual(await getRequirementDiffs(ID), [record]);
    await assert.rejects(getRequirementDiffs('22345678-1234-4234-8234-123456789abc'),
      (error: unknown) => error instanceof ApiError, 'a record of another requirement');
  } finally { restore(); }
  restore = await stub({ diffs: [record, record] });
  try { await assert.rejects(getRequirementDiffs(ID), (error: unknown) => error instanceof ApiError, 'the same comparison twice'); }
  finally { restore(); }
  restore = await stub(stored());
  try {
    assert.deepEqual(await getRequirementDiff(ID, DIFF_ID), stored());
    await assert.rejects(getRequirementDiff('55555555-1234-4234-8234-123456789abc', DIFF_ID),
      (error: unknown) => error instanceof ApiError, 'a comparison under another requirement');
    await assert.rejects(getRequirementDiff(ID, '66666666-1234-4234-8234-123456789abc'),
      (error: unknown) => error instanceof ApiError, 'another comparison than the one asked for');
  } finally { restore(); }
  restore = await stub({ error: 'Requirement diff not found' }, 404);
  try {
    await assert.rejects(getRequirementDiff(ID, DIFF_ID),
      (error: unknown) => error instanceof ApiError && error.status === 404 && error.message === '这个差分不存在');
  } finally { restore(); }
});

test('a refused comparison says what to do and never leaks the server body; bad ids make no request', async () => {
  const original = globalThis.fetch;
  try {
    for (const [status, message] of [[404, '需求或版本不存在'], [400, '请选择两个不同的版本进行比较']] as const) {
      globalThis.fetch = async () => new Response('SECRET=/private/path', { status });
      await assert.rejects(compareRequirementVersions(ID, { baseVersion: 1, targetVersion: 1 }),
        (error: unknown) => error instanceof ApiError && error.status === status && error.message === message);
    }
    globalThis.fetch = async () => { throw new Error('unexpected network request'); };
    for (const call of [
      () => compareRequirementVersions('nope', { baseVersion: 1, targetVersion: 2 }),
      () => getRequirementDiffs('nope'),
      () => getRequirementDiff(ID, 'nope'),
    ]) {
      await assert.rejects(call(), (error: unknown) => error instanceof ApiError && error.status === 400);
    }
  } finally { globalThis.fetch = original; }
});

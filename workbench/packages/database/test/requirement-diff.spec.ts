import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  canonicalJson, diffRequirementVersions, diffSha256, type RequirementDiff, type RequirementDiffChange,
} from '../src/index.ts';

const snapshot = (content: unknown, content_sha256: string) => ({ content_sha256, content });
const diffOf = (base: unknown, target: unknown): RequirementDiff =>
  diffRequirementVersions(snapshot(base, 'b'.repeat(64)), snapshot(target, 'c'.repeat(64)));
const content = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  title: 'T', background: 'B', goal: 'G', scope: 'S', risk: 'R', priority: 'high',
  acceptanceCriteria: [{ id: 'AC-1', text: 'first' }], ...overrides,
});

test('a new field is added, a changed one shows both values, a removed one its old value', () => {
  const target = content({ environment: 'production', title: 'T2' });
  delete target.risk;
  const diff = diffOf(content(), target);
  assert.deepEqual(diff.changes, [
    { op: 'added', pointer: '/environment', value: 'production' },
    { op: 'deleted', pointer: '/risk', old_value: 'R' },
    { op: 'modified', pointer: '/title', old_value: 'T', new_value: 'T2' },
  ]);
  assert.deepEqual(diff.unchanged, ['/acceptanceCriteria', '/background', '/goal', '/priority', '/scope']);
  assert.deepEqual(diff.summary, { added: 1, modified: 1, deleted: 1, needs_review: 0, unchanged: 5 });
  assert.deepEqual([diff.schema, diff.base_sha256, diff.target_sha256], [1, 'b'.repeat(64), 'c'.repeat(64)]);
});

test('items are matched by id whatever their order, and compared field by field', () => {
  const base = content({ acceptanceCriteria: [
    { id: 'AC-1', text: 'first' }, { id: 'AC-2', text: 'second' }, { id: 'AC-3', text: 'third' },
  ] });
  // The same three items in another order: nothing changed.
  const reordered = diffOf(base, { ...base, acceptanceCriteria: [...base.acceptanceCriteria as unknown[]].reverse() });
  // Nothing differs, so the whole content is the one unchanged pointer.
  assert.deepEqual(reordered.changes, []);
  assert.deepEqual(reordered.unchanged, ['']);

  // AC-1 is gone, AC-2 has another text, AC-4 is new, AC-3 only moved.
  const changed = diffOf(base, { ...base, acceptanceCriteria: [
    { id: 'AC-3', text: 'third' }, { id: 'AC-4', text: 'fourth' }, { id: 'AC-2', text: 'second, revised' },
  ] });
  assert.deepEqual(changed.changes, [
    { op: 'deleted', pointer: '/acceptanceCriteria[id=AC-1]', old_value: { id: 'AC-1', text: 'first' } },
    { op: 'modified', pointer: '/acceptanceCriteria[id=AC-2]/text', old_value: 'second', new_value: 'second, revised' },
    { op: 'added', pointer: '/acceptanceCriteria[id=AC-4]', value: { id: 'AC-4', text: 'fourth' } },
  ]);
  // Six fields and the one item that only moved.
  assert.deepEqual(changed.summary, { added: 1, modified: 1, deleted: 1, needs_review: 0, unchanged: 7 });
});

test('texts that differ only in normalization form or line endings are equal; spaces are a change', () => {
  const base = content({ title: 'caf\u00e9\r\nline', background: 'x' });
  const same = diffOf(base, { ...base, title: 'cafe\u0301\nline' });
  assert.deepEqual(same.changes, []);
  // Leading and trailing spaces are kept as they were stored, so they are a visible change and reported.
  for (const [before, after] of [['x', ' x'], ['x', 'x '], ['a  b', 'a b']] as const) {
    const diff = diffOf(content({ background: before }), content({ background: after }));
    assert.deepEqual(diff.changes, [{
      op: 'modified', pointer: '/background', old_value: before, new_value: after,
    }], `${JSON.stringify(before)} to ${JSON.stringify(after)}`);
  }
  // A lone carriage return is a line ending too.
  assert.deepEqual(diffOf(content({ background: 'x\ry' }), content({ background: 'x\ny' })).changes, []);
});

test('missing, null and empty text are three different values', () => {
  const diff = diffOf({ a: null, b: '', c: 1 }, { a: '', b: null });
  assert.deepEqual(diff.changes, [
    { op: 'modified', pointer: '/a', old_value: null, new_value: '' },
    { op: 'modified', pointer: '/b', old_value: '', new_value: null },
    { op: 'deleted', pointer: '/c', old_value: 1 },
  ]);
  assert.deepEqual(diffOf({ a: null }, { a: null }).changes, []);
  assert.deepEqual(diffOf({ a: null }, { b: null }).changes, [
    { op: 'deleted', pointer: '/a', old_value: null },
    { op: 'added', pointer: '/b', value: null },
  ]);
  // A value that stops being an object is one change with the whole old and new value.
  assert.deepEqual(diffOf({ a: { x: 1 } }, { a: 5 }).changes, [
    { op: 'modified', pointer: '/a', old_value: { x: 1 }, new_value: 5 },
  ]);
});

test('a list of plain values compares by counts, and a list that only moved is asked about', () => {
  assert.deepEqual(diffOf({ tags: ['prod', 'dev'] }, { tags: ['prod', 'dev', 'stage'] }).changes, [
    { op: 'added', pointer: '/tags[="stage"]', value: 'stage' },
  ]);
  assert.deepEqual(diffOf({ tags: ['a', 'a', 'b'] }, { tags: ['a', 'b', 'b'] }).changes, [
    { op: 'deleted', pointer: '/tags[="a"]', old_value: 'a' },
    { op: 'added', pointer: '/tags[="b"]', value: 'b' },
  ]);
  const moved = diffOf({ tags: ['a', 'b'] }, { tags: ['b', 'a'] });
  assert.deepEqual(moved.changes, [{
    op: 'needs_review', pointer: '/tags', reason: 'reordered', old_value: ['a', 'b'], new_value: ['b', 'a'], related: [],
  }]);
  assert.deepEqual(moved.unchanged, ['/tags[="a"]', '/tags[="b"]']);
  // The same list is unchanged as a whole.
  assert.deepEqual(diffOf({ tags: ['a', 'b'] }, { tags: ['a', 'b'] }), {
    schema: 1, base_sha256: 'b'.repeat(64), target_sha256: 'c'.repeat(64),
    summary: { added: 0, modified: 0, deleted: 0, needs_review: 0, unchanged: 1 }, changes: [], unchanged: [''],
  });
  // Numbers, booleans and null are addressed by their JSON text, so "1" and 1 are two values. `null` is gone and
  // the three others changed places.
  assert.deepEqual(diffOf({ tags: [1, '1', null, true] }, { tags: [true, '1', 1] }).changes, [
    { op: 'needs_review', pointer: '/tags', reason: 'reordered', old_value: [1, '1', null, true], new_value: [true, '1', 1], related: [] },
    { op: 'deleted', pointer: '/tags[=null]', old_value: null },
  ]);
});

test('an array whose items carry no stable id is one value', () => {
  const base = { steps: [{ x: 1 }, { x: 2 }] };
  assert.deepEqual(diffOf(base, { steps: [{ x: 2 }, { x: 1 }] }).changes, [{
    op: 'needs_review', pointer: '/steps', reason: 'unkeyed_array_changed',
    old_value: [{ x: 1 }, { x: 2 }], new_value: [{ x: 2 }, { x: 1 }], related: [],
  }]);
  assert.deepEqual(diffOf(base, { steps: [{ x: 2 }, { x: 1 }] }).unchanged, []);
  assert.deepEqual(diffOf(base, { steps: [{ x: 1 }, { x: 2 }] }).changes, []);
  assert.deepEqual(diffOf({}, { steps: [{ x: 1 }] }).changes, [{ op: 'added', pointer: '/steps', value: [{ x: 1 }] }]);
  assert.deepEqual(diffOf(base, { steps: [] }).changes, [{ op: 'deleted', pointer: '/steps', old_value: [{ x: 1 }, { x: 2 }] }]);
  // An id has to be a non-empty text: a number, an empty text or a missing id makes the array one value.
  for (const steps of [[{ id: 1, x: 1 }], [{ id: '', x: 1 }], [{ text: 'no id' }], [{ id: 'AC-1' }, { text: 'mixed' }]]) {
    const diff = diffOf({ steps: [{ id: 1, x: 1 }] }, { steps });
    assert.equal(diff.changes.length <= 1 && diff.changes.every(change => change.op !== 'modified'), true, JSON.stringify(steps));
  }
});

test('the id of a matched item is its address and is never reported, and equal copies stay unchanged', () => {
  const diff = diffOf({ list: [{ id: 'AC-1', text: 'a' }] }, { list: [{ id: 'AC-1', text: 'b' }] });
  assert.deepEqual(diff.changes, [{ op: 'modified', pointer: '/list[id=AC-1]/text', old_value: 'a', new_value: 'b' }]);
  assert.deepEqual(diff.unchanged, []);
  // The same item twice on both sides, in another order: nothing changed, so nothing is asked.
  const copies = [{ id: 'X', n: 1 }, { id: 'X', n: 2 }];
  assert.deepEqual(diffOf({ list: copies }, { list: [...copies].reverse() }), {
    schema: 1, base_sha256: 'b'.repeat(64), target_sha256: 'c'.repeat(64),
    summary: { added: 0, modified: 0, deleted: 0, needs_review: 0, unchanged: 1 },
    changes: [], unchanged: [''],
  });
});

test('an id used twice is reported with every copy, not resolved', () => {
  const diff = diffOf(
    { acceptanceCriteria: [{ id: 'AC-1', text: 'a' }, { id: 'AC-2', text: 'b' }] },
    { acceptanceCriteria: [{ id: 'AC-1', text: "a'" }, { id: 'AC-1', text: "a''" }, { id: 'AC-2', text: 'b' }] },
  );
  assert.deepEqual(diff.changes, [{
    op: 'needs_review', pointer: '/acceptanceCriteria[id=AC-1]', reason: 'duplicate_id',
    old_value: { id: 'AC-1', text: 'a' },
    new_value: [{ id: 'AC-1', text: "a'" }, { id: 'AC-1', text: "a''" }], related: [],
  }]);
  assert.deepEqual(diff.unchanged, ['/acceptanceCriteria[id=AC-2]']);
  // The same id twice on both sides: both sets are shown.
  const both = diffOf({ list: [{ id: 'X', n: 1 }, { id: 'X', n: 2 }] }, { list: [{ id: 'X', n: 3 }, { id: 'X', n: 1 }] });
  assert.equal(both.changes.length, 1);
  const change = both.changes[0];
  assert.ok(change.op === 'needs_review' && change.reason === 'duplicate_id');
  assert.ok(change.op === 'needs_review' && Array.isArray(change.old_value) && Array.isArray(change.new_value));
  // An id used twice only in the new version is just as unusable.
  const grown = diffOf({ list: [{ id: 'X', n: 1 }] }, { list: [{ id: 'X', n: 1 }, { id: 'X', n: 2 }] });
  assert.deepEqual(grown.changes, [{
    op: 'needs_review', pointer: '/list[id=X]', reason: 'duplicate_id',
    old_value: { id: 'X', n: 1 }, new_value: [{ id: 'X', n: 1 }, { id: 'X', n: 2 }], related: [],
  }]);
});

test('an item that may have been renamed is asked about, not reported as an addition and a deletion', () => {
  const diff = diffOf(
    { acceptanceCriteria: [{ id: 'AC-1', text: 'same' }, { id: 'AC-2', text: 'keep' }] },
    { acceptanceCriteria: [{ id: 'AC-9', text: 'same' }, { id: 'AC-2', text: 'keep' }] },
  );
  assert.deepEqual(diff.changes, [{
    op: 'needs_review', pointer: '/acceptanceCriteria[id=AC-9]', reason: 'possible_rename',
    old_value: { id: 'AC-1', text: 'same' }, new_value: { id: 'AC-9', text: 'same' },
    related: ['/acceptanceCriteria[id=AC-1]'],
  }]);
  assert.deepEqual(diff.summary, { added: 0, modified: 0, deleted: 0, needs_review: 1, unchanged: 1 });
  assert.deepEqual(diff.unchanged, ['/acceptanceCriteria[id=AC-2]']);

  // A renamed item whose text also changed cannot be told from a removal and an addition: those are the facts.
  const edited = diffOf({ list: [{ id: 'AC-1', text: 'same' }] }, { list: [{ id: 'AC-9', text: 'changed' }] });
  assert.deepEqual(edited.changes.map(change => change.op), ['deleted', 'added']);

  // Two old items and one new one with the same text: a merge, copies or two changes cannot be told apart.
  const ambiguous = diffOf(
    { list: [{ id: 'AC-1', text: 'same' }, { id: 'AC-2', text: 'same' }] },
    { list: [{ id: 'AC-9', text: 'same' }] },
  );
  assert.deepEqual(ambiguous.changes.map(change => [change.pointer, change.op === 'needs_review' && change.reason]), [
    ['/list[id=AC-1]', 'ambiguous_match'], ['/list[id=AC-2]', 'ambiguous_match'], ['/list[id=AC-9]', 'ambiguous_match'],
  ]);
  assert.deepEqual(ambiguous.changes.map(change => change.op === 'needs_review' && change.related), [
    ['/list[id=AC-2]', '/list[id=AC-9]'], ['/list[id=AC-1]', '/list[id=AC-9]'], ['/list[id=AC-1]', '/list[id=AC-2]'],
  ]);
});

test('the same input gives the same text and hash, whatever the key order and the order of keyed items', () => {
  const base = content({ acceptanceCriteria: [{ id: 'AC-1', text: 'one' }, { id: 'AC-2', text: 'two' }] });
  const target = content({ title: 'T2', acceptanceCriteria: [{ id: 'AC-2', text: 'two' }, { id: 'AC-3', text: 'three' }] });
  const first = diffOf(base, target);
  const again = diffOf(structuredClone(base), structuredClone(target));
  assert.equal(canonicalJson(again), canonicalJson(first));
  assert.equal(diffSha256(again), diffSha256(first));
  assert.match(diffSha256(first), /^[0-9a-f]{64}$/);

  // Keys in another insertion order and the keyed list in another order: the same text and the same hash.
  const shuffled = { acceptanceCriteria: target.acceptanceCriteria, priority: 'high', title: 'T2', risk: 'R', scope: 'S', goal: 'G', background: 'B' };
  assert.equal(canonicalJson(diffOf({ ...base, acceptanceCriteria: [...base.acceptanceCriteria as unknown[]].reverse() }, shuffled)),
    canonicalJson(first));

  // The hash is of the stored text, so the text can be read back and hashed again with the same result.
  const stored = JSON.parse(canonicalJson(first)) as RequirementDiff;
  assert.equal(diffSha256(stored), diffSha256(first));
  // The diff is bound to the two snapshots it compared: another base gives the same changes and another hash.
  const otherBase = diffRequirementVersions(snapshot(base, 'd'.repeat(64)), snapshot(target, 'c'.repeat(64)));
  assert.deepEqual(otherBase.changes, first.changes);
  assert.notEqual(diffSha256(otherBase), diffSha256(first));
  // The result is ordered by pointer, not by the order in which it was built. The key "a" comes before "a!", but
  // "/a!" sorts before "/a/n"; a change inside "a" makes its other field be listed on its own.
  const ordered = diffOf({ a: { m: 1, n: 1 }, 'a!': 2 }, { a: { m: 2, n: 1 }, 'a!': 2 });
  assert.deepEqual(ordered.changes.map(change => change.pointer), ['/a/m']);
  assert.deepEqual(ordered.unchanged, ['/a!', '/a/n']);
  // Names are escaped the JSON Pointer way.
  const escaped = diffOf({ 'x/y': 1, 'x~y': 2, list: [{ id: 'a/b', text: 't' }, { id: 'a~b', text: 't' }] },
    { 'x/y': 2, 'x~y': 1, list: [{ id: 'a/b', text: 'u' }, { id: 'a~b', text: 't' }] });
  assert.deepEqual(escaped.changes.map(change => change.pointer), ['/list[id=a~1b]/text', '/x~0y', '/x~1y']);
});

test('empty versions', () => {
  assert.deepEqual(diffOf({}, {}), {
    schema: 1, base_sha256: 'b'.repeat(64), target_sha256: 'c'.repeat(64),
    summary: { added: 0, modified: 0, deleted: 0, needs_review: 0, unchanged: 1 }, changes: [], unchanged: [''],
  });
  const filled = diffOf({}, content());
  assert.deepEqual(filled.changes.map(change => change.pointer), [
    '/acceptanceCriteria', '/background', '/goal', '/priority', '/risk', '/scope', '/title',
  ]);
  assert.ok(filled.changes.every(change => change.op === 'added'));
  assert.deepEqual(diffOf({}, { list: [] }).changes, [{ op: 'added', pointer: '/list', value: [] }]);
  assert.deepEqual(diffOf({ list: [] }, {}).changes, [{ op: 'deleted', pointer: '/list', old_value: [] }]);
});

test('the text and the hash of one fixed diff are pinned, so a change of format is a deliberate decision', () => {
  const diff = diffOf(
    { title: 'T', background: 'B', acceptanceCriteria: [{ id: 'AC-1', text: 'one' }, { id: 'AC-2', text: 'two' }] },
    { title: 'T2', background: 'B', tags: ['b', 'a'], acceptanceCriteria: [{ id: 'AC-2', text: 'two' }, { id: 'AC-3', text: 'three' }] },
  );
  assert.equal(canonicalJson(diff), [
    '{"base_sha256":"', 'b'.repeat(64), '","changes":[',
    '{"old_value":{"id":"AC-1","text":"one"},"op":"deleted","pointer":"/acceptanceCriteria[id=AC-1]"},',
    '{"op":"added","pointer":"/acceptanceCriteria[id=AC-3]","value":{"id":"AC-3","text":"three"}},',
    '{"op":"added","pointer":"/tags","value":["b","a"]},',
    '{"new_value":"T2","old_value":"T","op":"modified","pointer":"/title"}],',
    '"schema":1,"summary":{"added":2,"deleted":1,"modified":1,"needs_review":0,"unchanged":2},',
    '"target_sha256":"', 'c'.repeat(64), '","unchanged":["/acceptanceCriteria[id=AC-2]","/background"]}',
  ].join(''));
  assert.equal(diffSha256(diff), '5a851b85a2a9c82e9a226a471930bb113065e3ec5c245e134c84d6143e3f1cee');
});

/* --------------------------------- properties over random inputs ---------------------------------- */

/** Pointer first, then the kind of change: the order the engine promises, written out here apart from it. */
const OP_ORDER: Record<string, number> = { added: 0, deleted: 1, modified: 2, needs_review: 3 };
const byPointerThenOp = (left: RequirementDiffChange, right: RequirementDiffChange): number =>
  left.pointer !== right.pointer ? (left.pointer < right.pointer ? -1 : 1) : OP_ORDER[left.op] - OP_ORDER[right.op];


type Counts = Map<string, number>;
type Random = () => number;

/** A small seeded generator, so a failure can be reproduced from the seed it reports. */
function prng(seed: number): Random {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6D2B79F5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const pick = <T>(random: Random, items: readonly T[]): T => items[Math.floor(random() * items.length)];
const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const isScalar = (value: unknown): boolean => !isObject(value) && !Array.isArray(value);

const TEXTS = ['a', 'b', 'c', '', ' ', 'same text', ' same text', 'same text ', 'x\r\ny', 'x\ny', 'x\ry', 'é', 'e\u0301', '中文', 'a/b', 'a~b'];
const SCALARS: unknown[] = [null, true, false, 0, 1, 2, -1, 1.5, ...TEXTS];
const KEYS = ['title', 'goal', 'environment', 'a', 'b', 'c', 'x/y', 'x~y', 'id', '', 'acceptanceCriteria', 'tags', 'steps'];
const IDS = ['AC-1', 'AC-2', 'AC-3', 'a/b', 'a~b', 'AC-1 ', ''];
let freshId = 0;

function randomValue(random: Random, depth: number, keyedOnly: boolean): unknown {
  const roll = random();
  if (depth <= 0 || roll < 0.3) return pick(random, SCALARS);
  if (roll < 0.6) {
    const out: Record<string, unknown> = {};
    for (let index = 0; index < Math.floor(random() * 5); index++) out[pick(random, KEYS)] = randomValue(random, depth - 1, keyedOnly);
    return out;
  }
  if (roll < 0.85) {
    return Array.from({ length: Math.floor(random() * 5) }, () => {
      const item: Record<string, unknown> = { id: keyedOnly ? `N${freshId++}` : pick(random, IDS) };
      if (!keyedOnly && random() < 0.1) item.id = pick(random, [1, null, undefined]);
      if (random() < 0.8) item.text = pick(random, TEXTS);
      if (random() < 0.3) item.note = randomValue(random, 1, keyedOnly);
      return item;
    });
  }
  if (keyedOnly || roll < 0.95) {
    return Array.from({ length: Math.floor(random() * 5) }, () => pick(random, SCALARS));
  }
  return Array.from({ length: Math.floor(random() * 4) }, () => ({ x: pick(random, SCALARS), y: pick(random, SCALARS) }));
}

/** A copy with a few edits of the kind people make, so that base and target are close but not equal. */
function mutated(random: Random, value: unknown, keyedOnly: boolean): unknown {
  const copy = structuredClone(value);
  for (let round = 0; round < 1 + Math.floor(random() * 4); round++) {
    const spots: { node: unknown; set: (next: unknown) => void }[] = [];
    const walk = (node: unknown, set: (next: unknown) => void): void => {
      spots.push({ node, set });
      if (isObject(node)) for (const key of Object.keys(node)) walk(node[key], next => { node[key] = next; });
      else if (Array.isArray(node)) for (let index = 0; index < node.length; index++) {
        walk(node[index], next => { node[index] = next; });
      }
    };
    walk(copy, () => {});
    const { node, set } = pick(random, spots);
    const roll = random();
    if (isObject(node)) {
      const keys = Object.keys(node);
      if (roll < 0.3 && keys.length) delete node[pick(random, keys)];
      else if (roll < 0.6 && !(keyedOnly && 'id' in node && node.id !== undefined && pick(random, KEYS) === 'id')) {
        node[pick(random, KEYS)] = randomValue(random, 1, keyedOnly);
      } else set(randomValue(random, 2, keyedOnly));
    } else if (Array.isArray(node)) {
      const item = (): Record<string, unknown> => {
        const entry: Record<string, unknown> = { id: keyedOnly ? `N${freshId++}` : pick(random, IDS) };
        if (random() < 0.8) entry.text = pick(random, TEXTS);
        return entry;
      };
      if (roll < 0.25 && node.length) node.splice(Math.floor(random() * node.length), 1);
      else if (roll < 0.5) node.push(item());
      else if (roll < 0.65) node.sort(() => random() - 0.5);
      else if (roll < 0.8 && node.length) {
        const index = Math.floor(random() * node.length);
        if (isObject(node[index])) node[index] = { ...node[index], text: pick(random, TEXTS) };
        else node[index] = pick(random, SCALARS);
      } else if (!keyedOnly) set(randomValue(random, 2, false));
    } else {
      // The same text in another normalization form or with other line endings is the same text.
      const variant = typeof node === 'string' ? [node.normalize('NFD'), node.normalize('NFC'), node.replace(/\n/g, '\r\n')]
        .find(text => text !== node) : undefined;
      set(roll < 0.2 && variant !== undefined ? variant : randomValue(random, 1, keyedOnly));
    }
  }
  return copy;
}

/** Object keys in another insertion order, deep down. */
function keysShuffled(value: unknown, random: Random): unknown {
  if (Array.isArray(value)) return value.map(item => keysShuffled(item, random));
  if (!isObject(value)) return value;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(value).sort(() => random() - 0.5)) out[key] = keysShuffled(value[key], random);
  return out;
}

/** Keyed lists in another order, deep down. */
function keyedListsShuffled(value: unknown, random: Random): unknown {
  if (Array.isArray(value)) {
    const items = value.map(item => keyedListsShuffled(item, random));
    return items.every(item => isObject(item) && typeof item.id === 'string' && item.id.trim() !== '')
      ? items.sort(() => random() - 0.5) : items;
  }
  if (!isObject(value)) return value;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(value)) out[key] = keyedListsShuffled(value[key], random);
  return out;
}

const escapeToken = (token: string): string => token.replace(/~/g, '~0').replace(/\//g, '~1');
const scalarKey = (value: unknown): string =>
  JSON.stringify(typeof value === 'string' ? value.normalize('NFC').replace(/\r\n?/g, '\n') : value);
const isKeyed = (list: unknown[]): boolean => list.every(item => isObject(item) && typeof item.id === 'string' && item.id.trim() !== '');

/**
 * Every leaf of a value and how often it is there, addressed the way the engine documents its pointers. Written
 * apart from the engine on purpose: it is the independent measure of whether anything was dropped.
 */
function leaves(value: unknown, pointer = '', out: Counts = new Map()): Counts {
  const bump = (key: string) => out.set(key, (out.get(key) ?? 0) + 1);
  // The `id` of an item is its address and is never a leaf of its own, whether the item is in a list or a value
  // of its own in an entry.
  const addressed = /\[id=[^/]*\]$/.test(pointer);
  if (Array.isArray(value)) {
    if (isKeyed(value)) {
      for (const item of value) leaves(item, `${pointer}[id=${escapeToken(item.id)}]`, out);
    } else if (value.every(isScalar)) for (const item of value) bump(`${pointer}[=${scalarKey(item)}]`);
    else value.forEach((item, index) => leaves(item, `${pointer}/${index}`, out));
  } else if (isObject(value)) {
    for (const [name, item] of Object.entries(value)) {
      if (item !== undefined && !(addressed && name === 'id')) leaves(item, `${pointer}/${escapeToken(name)}`, out);
    }
  } else {
    bump(pointer);
  }
  return out;
}

/** Every leaf of both versions is accounted for exactly once: reported, unchanged, or inside a question. */
function assertNothingIsLost(base: unknown, target: unknown, diff: RequirementDiff, context: string): void {
  const baseLeaves = leaves(base);
  const targetLeaves = leaves(target);
  const coveredBase: Counts = new Map();
  const coveredTarget: Counts = new Map();
  const covers = (root: string, leaf: string): boolean =>
    root === '' || root === leaf || leaf.startsWith(`${root}/`) || leaf.startsWith(`${root}[`);
  const addSubtree = (value: unknown, pointer: string, into: Counts): void => {
    for (const [leaf, count] of leaves(value, pointer)) into.set(leaf, (into.get(leaf) ?? 0) + count);
  };
  const coverUnder = (root: string, leavesOf: Counts, into: Counts): void => {
    for (const [leaf, count] of leavesOf) if (covers(root, leaf)) into.set(leaf, (into.get(leaf) ?? 0) + count);
  };
  for (const pointer of diff.unchanged) {
    coverUnder(pointer, baseLeaves, coveredBase);
    coverUnder(pointer, targetLeaves, coveredTarget);
  }
  for (const change of diff.changes) {
    if (change.op === 'added') addSubtree(change.value, change.pointer, coveredTarget);
    else if (change.op === 'deleted') addSubtree(change.old_value, change.pointer, coveredBase);
    else if (change.op === 'modified') {
      addSubtree(change.old_value, change.pointer, coveredBase);
      addSubtree(change.new_value, change.pointer, coveredTarget);
    } else if (change.reason === 'possible_rename') {
      addSubtree(change.old_value, change.related[0], coveredBase);
      addSubtree(change.new_value, change.pointer, coveredTarget);
    } else if (change.reason === 'duplicate_id') {
      // The entry stands for every copy of that id on its side.
      if (change.old_value !== null) coverUnder(change.pointer, baseLeaves, coveredBase);
      if (change.new_value !== null) coverUnder(change.pointer, targetLeaves, coveredTarget);
    } else {
      if (change.old_value !== null) addSubtree(change.old_value, change.pointer, coveredBase);
      if (change.new_value !== null) addSubtree(change.new_value, change.pointer, coveredTarget);
    }
  }
  const sorted = (counts: Counts): string[] => [...counts.keys()].sort();
  assert.deepEqual(sorted(coveredBase), sorted(baseLeaves), `${context}: a leaf of the base is dropped or counted twice`);
  assert.deepEqual(sorted(coveredTarget), sorted(targetLeaves), `${context}: a leaf of the target is dropped or counted twice`);
}

/** The additions and deletions of a diff, each with its pointer and value; swapped, addition becomes deletion. */
const additionsAndDeletions = (diff: RequirementDiff, swap = false): string[] => diff.changes
  .filter(change => change.op === 'added' || change.op === 'deleted')
  .map(change => canonicalJson([
    change.pointer,
    (swap ? change.op === 'added' : change.op === 'deleted') ? 'deleted' : 'added',
    change.op === 'added' ? change.value : change.old_value,
  ]))
  .sort();

test('over random inputs nothing is dropped, the result is deterministic, and reversing swaps addition and deletion', () => {
  const random = prng(20261125);
  const reasons = new Set<string>();
  const check = (base: unknown, target: unknown, context: string): void => {
    const diff = diffOf(base, target);
    assert.equal(canonicalJson(diffOf(structuredClone(base), structuredClone(target))), canonicalJson(diff), `${context}: not deterministic`);
    assert.equal(canonicalJson(diffOf(keysShuffled(base, random), keysShuffled(target, random))), canonicalJson(diff),
      `${context}: the order of object keys changed the result`);
    assert.equal(diffOf(base, base).changes.length, 0, `${context}: a value differs from itself`);
    assert.deepEqual(diff.unchanged, [...diff.unchanged].sort(), `${context}: the unchanged pointers are not in order`);
    assert.deepEqual(diff.changes, [...diff.changes].sort(byPointerThenOp), `${context}: the changes are not in order`);
    assertNothingIsLost(base, target, diff, context);

    const reverse = diffOf(target, base);
    assertNothingIsLost(target, base, reverse, `${context}, reversed`);
    assert.deepEqual(additionsAndDeletions(reverse), additionsAndDeletions(diff, true),
      `${context}: reversing did not swap addition and deletion`);
    // Reversing swaps addition and deletion and changes nothing else.
    assert.deepEqual(reverse.summary, {
      ...diff.summary, added: diff.summary.deleted, deleted: diff.summary.added,
    }, `${context}: reversing changed the summary`);
    for (const change of diff.changes) if (change.op === 'needs_review') reasons.add(change.reason);
  };

  // Inputs built to reach every kind of question, so that each property is checked for each of them. Random
  // edits alone rarely produce a merge or a list that only moved.
  const item = (id: string, text = 'same'): Record<string, unknown> => ({ id, text });
  const built: [unknown, unknown, string][] = [
    [[item('AC-1'), item('AC-2')], [item('AC-9')], 'a merge or copies'],
    [{ tags: ['a', 'b'] }, { tags: ['b', 'a'] }, 'a list that only moved'],
    [[item('AC-1')], [item('AC-9')], 'a renamed item'],
    [[item('AC-1', 'x'), item('AC-1', 'y')], [item('AC-1', 'x')], 'an id used twice'],
    [[{ x: 1 }], [{ x: 2 }], 'a list without ids'],
  ];
  for (const [base, target, name] of built) check(base, target, name);

  for (let round = 0; round < 2000; round++) {
    const base = randomValue(random, 4, false);
    const target = random() < 0.6 ? mutated(random, base, false) : randomValue(random, 4, false);
    check(base, target, `round ${round}: ${canonicalJson(base)} -> ${canonicalJson(target)}`);
  }
  // Every kind of question the engine can ask was reached.
  assert.deepEqual([...reasons].sort(), ['ambiguous_match', 'duplicate_id', 'possible_rename', 'reordered', 'unkeyed_array_changed']);
});

test('over random keyed lists the order of items never changes the result', () => {
  const random = prng(20261126);
  for (let round = 0; round < 1000; round++) {
    const base = randomValue(random, 4, true);
    const target = random() < 0.6 ? mutated(random, base, true) : randomValue(random, 4, true);
    const diff = diffOf(base, target);
    const context = `round ${round}`;
    // A whole added or removed subtree is copied as it was stored, so its inner order is sorted out here.
    assert.equal(canonicalJson(sortedForm(diffOf(keyedListsShuffled(base, random), keyedListsShuffled(target, random)))),
      canonicalJson(sortedForm(diff)), `${context}: the order of keyed items changed the result`);
    assert.equal(diffOf(base, keysShuffled(keyedListsShuffled(base, random), random)).changes.length, 0,
      `${context}: a reordered value differs from the original`);
    assertNothingIsLost(base, target, diff, context);
  }
});

/** Keyed lists by id and object keys sorted, deep down: the order a value was stored in is not its meaning. */
function sortedForm(value: unknown): unknown {
  if (Array.isArray(value)) {
    const items = value.map(sortedForm);
    const idOf = (item: unknown): string => (isObject(item) && typeof item.id === 'string' ? item.id : '');
    return items.every(item => idOf(item) !== '') ? items.sort((a, b) => (idOf(a) < idOf(b) ? -1 : 1)) : items;
  }
  if (!isObject(value)) return value;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(value).sort()) out[key] = sortedForm(value[key]);
  return out;
}

/* ------------------------------------------ stress ------------------------------------------- */

test('a large list of items compares in one pass', () => {
  const items = (from: number, to: number): Record<string, unknown>[] =>
    Array.from({ length: to - from }, (_, index) => ({ id: `AC-${from + index}`, text: `text ${from + index}` }));
  const base = { acceptanceCriteria: items(0, 60_000) };
  const target = { acceptanceCriteria: [
    ...items(0, 10_000).map(item => ({ ...item, text: `${item.text} revised` })), ...items(15_000, 60_000), ...items(60_000, 65_000),
  ] };
  const started = performance.now();
  const diff = diffOf(base, target);
  const elapsed = performance.now() - started;
  assert.deepEqual(diff.summary, { added: 5000, modified: 10_000, deleted: 5000, needs_review: 0, unchanged: 45_000 });
  assert.ok(elapsed < 8000, `${Math.round(elapsed)} ms`);
});

test('one id used thousands of times is one report, not thousands of pairs', () => {
  const list = (suffix: string): Record<string, unknown>[] =>
    Array.from({ length: 5000 }, (_, index) => ({ id: 'AC-1', text: `text ${index}${suffix}` }));
  const started = performance.now();
  const diff = diffOf({ list: list('') }, { list: list(' revised') });
  const elapsed = performance.now() - started;
  assert.equal(diff.changes.length, 1);
  assert.deepEqual(diff.summary, { added: 0, modified: 0, deleted: 0, needs_review: 1, unchanged: 0 });
  assert.ok(elapsed < 8000, `${Math.round(elapsed)} ms`);
});

test('thousands of equal plain values and a long text are handled', () => {
  const many = (value: string, times: number): string[] => Array.from({ length: times }, () => value);
  const diff = diffOf({ tags: many('a', 50_000) }, { tags: [...many('a', 49_999), 'b'] });
  // One "a" fewer and one "b" more.
  assert.deepEqual(diff.summary, { added: 1, modified: 0, deleted: 1, needs_review: 0, unchanged: 49_999 });
  const text = 'x'.repeat(200_000);
  const long = diffOf({ background: text }, { background: `${text}y` });
  assert.deepEqual(long.changes, [{ op: 'modified', pointer: '/background', old_value: text, new_value: `${text}y` }]);
});

test('deeply nested values compare without running out of stack', () => {
  const nest = (depth: number, leaf: unknown): unknown => {
    let value = leaf;
    for (let index = 0; index < depth; index++) value = { level: value };
    return value;
  };
  const diff = diffOf(nest(300, 'leaf'), nest(300, 'other'));
  assert.deepEqual(diff.summary, { added: 0, modified: 1, deleted: 0, needs_review: 0, unchanged: 0 });
  assert.equal(diff.changes[0].pointer, '/level'.repeat(300));
  // A list without ids deep down is still one value that changed as a whole.
  const listed = diffOf({ a: { b: [{ x: 1 }] } }, { a: { b: [{ x: 2 }] } });
  assert.deepEqual(listed.changes.map(change => change.op === 'needs_review' && [change.pointer, change.reason]), [
    ['/a/b', 'unkeyed_array_changed'],
  ]);
  assert.deepEqual(diffOf(nest(300, 'leaf'), nest(300, 'leaf')).unchanged, ['']);
});

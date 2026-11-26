import { createHash } from 'node:crypto';

/** One immutable snapshot to compare, with the hash its version row stores for it. */
export interface DiffSnapshot {
  content_sha256: string;
  content: unknown;
}

export type DiffOp = 'added' | 'modified' | 'deleted' | 'needs_review';

/**
 * Why the engine refused to decide:
 * - `duplicate_id`: one version uses the same item id more than once;
 * - `unkeyed_array_changed`: an array whose items carry no stable id changed as a whole;
 * - `reordered`: a list of plain values kept its values but not their order;
 * - `possible_rename`: an item vanished and another with the same content but another id appeared;
 * - `ambiguous_match`: several such items at once; a split, a merge or copies cannot be told apart.
 */
export type NeedsReviewReason =
  | 'duplicate_id' | 'unkeyed_array_changed' | 'reordered' | 'possible_rename' | 'ambiguous_match';

export interface AddedChange { op: 'added'; pointer: string; value: unknown }
export interface DeletedChange { op: 'deleted'; pointer: string; old_value: unknown }
export interface ModifiedChange { op: 'modified'; pointer: string; old_value: unknown; new_value: unknown }
export interface NeedsReviewChange {
  op: 'needs_review';
  pointer: string;
  reason: NeedsReviewReason;
  /** `null` on a side means there is nothing on that side. */
  old_value: unknown;
  new_value: unknown;
  /** Pointers of the other entries this one cannot be told apart from. */
  related: string[];
}
export type RequirementDiffChange = AddedChange | DeletedChange | ModifiedChange | NeedsReviewChange;

export interface RequirementDiffSummary {
  added: number;
  modified: number;
  deleted: number;
  needs_review: number;
  unchanged: number;
}

/**
 * The result of comparing two snapshots. It is plain data in a fixed order, so the same two snapshots always
 * produce the same text and the same `diff_sha256`.
 */
export interface RequirementDiff {
  schema: 1;
  base_sha256: string;
  target_sha256: string;
  summary: RequirementDiffSummary;
  changes: RequirementDiffChange[];
  /** Pointers of what is equal, each one the root of an equal subtree. */
  unchanged: string[];
}

/**
 * Deterministic comparison of two requirement snapshots. It is an algorithm: nothing here asks a model, and
 * nothing is matched by guesswork.
 *
 * Pointers follow JSON Pointer (`/goal`, `/acceptanceCriteria/…`) with one addition for array items, because an
 * index would move whenever a list is reordered:
 * - `/list[id=AC-2]/text` is a field of the item whose `id` is `AC-2`;
 * - `/tags[="prod"]` is the plain value `"prod"` of a list.
 * `~` and `/` inside a name are written `~0` and `~1`.
 *
 * The rules:
 * - Objects compare key by key; the order of keys never matters.
 * - An array whose every item is an object with a non-empty string `id` compares item by item, by id, whatever
 *   the order. A new id is `added`, a gone id is `deleted`, and a kept id compares field by field, its `id` aside.
 *   An id that appears more than once in a version is `needs_review` with every copy, unless the copies are the
 *   same on both sides.
 * - A list of plain values compares as counts: more copies are `added`, fewer are `deleted`. When the values
   that remain changed places it is also asked about, because whether their order means anything is not for
   the engine to know.
 * - Any other array is one value: equal, or `added`, or `deleted`, or `needs_review`.
 * - Two texts are equal when they differ only in Unicode normalization form or in line endings. Everything
 *   else, leading and trailing spaces included, is a `modified` value; missing, `null` and `""` are three
 *   different values.
 * - What cannot be told apart is `needs_review` with both sides shown, never dropped and never guessed.
 */
export function diffRequirementVersions(base: DiffSnapshot, target: DiffSnapshot): RequirementDiff {
  const out: Collector = { changes: [], unchanged: [] };
  diffValue(base.content, target.content, '', out);
  const changes = out.changes.sort(compareChanges);
  const unchanged = [...out.unchanged].sort();
  const summary: RequirementDiffSummary = { added: 0, modified: 0, deleted: 0, needs_review: 0, unchanged: unchanged.length };
  for (const change of changes) summary[change.op] += 1;
  return {
    schema: 1, base_sha256: base.content_sha256, target_sha256: target.content_sha256, summary, changes, unchanged,
  };
}

/** Canonical JSON text of any JSON value: object keys sorted, no whitespace, texts as they are. */
export function canonicalJson(value: unknown): string {
  return serialize(value, false);
}

/** The hash stored with a diff: the SHA-256 of its canonical JSON text. */
export function diffSha256(diff: RequirementDiff): string {
  return createHash('sha256').update(canonicalJson(diff), 'utf8').digest('hex');
}

interface Collector { changes: RequirementDiffChange[]; unchanged: string[] }

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const isScalar = (value: unknown): boolean => !isObject(value) && !Array.isArray(value);

/** Two texts are the same when they differ only in Unicode normalization form or in line endings. */
const normalizeText = (text: string): string => text.normalize('NFC').replace(/\r\n?/g, '\n');
const escapeToken = (token: string): string => token.replace(/~/g, '~0').replace(/\//g, '~1');

/** One text for one value. With `normalize`, texts that mean the same get the same text; that form is never stored. */
function serialize(value: unknown, normalize: boolean): string {
  if (value === null) return 'null';
  if (typeof value === 'string') return JSON.stringify(normalize ? normalizeText(value) : value);
  if (typeof value !== 'object') return JSON.stringify(value) ?? 'undefined';
  if (Array.isArray(value)) {
    return `[${value.map(item => (item === undefined ? 'null' : serialize(item, normalize))).join(',')}]`;
  }
  const record = value as Record<string, unknown>;
  const entries = Object.keys(record)
    .filter(key => record[key] !== undefined)
    .sort()
    .map(key => `${JSON.stringify(key)}:${serialize(record[key], normalize)}`);
  return `{${entries.join(',')}}`;
}

const equal = (left: unknown, right: unknown): boolean => serialize(left, true) === serialize(right, true);

function compareChanges(left: RequirementDiffChange, right: RequirementDiffChange): number {
  if (left.pointer !== right.pointer) return left.pointer < right.pointer ? -1 : 1;
  if (left.op !== right.op) return ORDER[left.op] - ORDER[right.op];
  const leftText = canonicalJson(left);
  const rightText = canonicalJson(right);
  return leftText === rightText ? 0 : leftText < rightText ? -1 : 1;
}
const ORDER: Record<DiffOp, number> = { added: 0, deleted: 1, modified: 2, needs_review: 3 };

function diffValue(base: unknown, target: unknown, pointer: string, out: Collector): void {
  if (isObject(base) && isObject(target)) return diffObject(base, target, pointer, out);
  if (Array.isArray(base) && Array.isArray(target)) return diffArray(base, target, pointer, out);
  if (!isScalar(base) || !isScalar(target) || !equal(base, target)) {
    out.changes.push({ op: 'modified', pointer, old_value: base, new_value: target });
    return;
  }
  out.unchanged.push(pointer);
}

function sortedUnion<T>(left: Map<string, T>, right: Map<string, T>): string[] {
  return [...new Set([...left.keys(), ...right.keys()])].sort();
}

/** `skip` leaves out a key: the `id` of a matched item is its address, not a field to report. */
function diffObject(
  base: Record<string, unknown>, target: Record<string, unknown>, pointer: string, out: Collector, skip?: string,
): void {
  const inner: Collector = { changes: [], unchanged: [] };
  const keys = [...new Set([...Object.keys(base), ...Object.keys(target)])].sort();
  for (const key of keys) {
    if (key === skip) continue;
    const child = `${pointer}/${escapeToken(key)}`;
    const before = base[key];
    const after = target[key];
    if (before === undefined) {
      if (after !== undefined) inner.changes.push({ op: 'added', pointer: child, value: after });
    } else if (after === undefined) {
      inner.changes.push({ op: 'deleted', pointer: child, old_value: before });
    } else {
      diffValue(before, after, child, inner);
    }
  }
  collect(inner, pointer, out);
}

/** A container with no change inside is one unchanged pointer; otherwise its parts are passed on as they are. */
function collect(inner: Collector, pointer: string, out: Collector): void {
  if (inner.changes.length === 0) { out.unchanged.push(pointer); return; }
  out.changes.push(...inner.changes);
  out.unchanged.push(...inner.unchanged);
}

const validId = (item: unknown): item is Record<string, unknown> & { id: string } =>
  isObject(item) && typeof item.id === 'string' && item.id.trim() !== '';
const isKeyed = (list: unknown[]): boolean => list.every(validId);
const isPlainList = (list: unknown[]): boolean => list.every(isScalar);

function diffArray(base: unknown[], target: unknown[], pointer: string, out: Collector): void {
  if (isKeyed(base) && isKeyed(target)) return diffKeyedArray(base, target, pointer, out);
  if (equal(base, target)) { out.unchanged.push(pointer); return; }
  if (base.length === 0) { out.changes.push({ op: 'added', pointer, value: target }); return; }
  if (target.length === 0) { out.changes.push({ op: 'deleted', pointer, old_value: base }); return; }
  if (isPlainList(base) && isPlainList(target)) return diffPlainList(base, target, pointer, out);
  out.changes.push({
    op: 'needs_review', pointer, reason: 'unkeyed_array_changed', old_value: base, new_value: target, related: [],
  });
}

interface Item { pointer: string; value: Record<string, unknown>; matched: boolean }

/** Items by id, whatever their order. An id used twice is the version's mistake and is reported, not resolved. */
function diffKeyedArray(base: unknown[], target: unknown[], pointer: string, out: Collector): void {
  const inner: Collector = { changes: [], unchanged: [] };
  const before = groupById(base);
  const after = groupById(target);
  const appeared: Item[] = [];
  const vanished: Item[] = [];
  for (const id of sortedUnion(before, after)) {
    const itemPointer = `${pointer}[id=${escapeToken(id)}]`;
    const oldItems = before.get(id) ?? [];
    const newItems = after.get(id) ?? [];
    if (oldItems.length > 1 || newItems.length > 1) {
      // The same copies in another order are still the same. A change among them cannot be matched to one copy.
      if (oldItems.length === newItems.length && equal(sortByKey(oldItems), sortByKey(newItems))) {
        inner.unchanged.push(itemPointer);
      } else {
        inner.changes.push({
          op: 'needs_review', pointer: itemPointer, reason: 'duplicate_id',
          old_value: oneOrMany(oldItems), new_value: oneOrMany(newItems), related: [],
        });
      }
    } else if (oldItems.length === 1 && newItems.length === 1) {
      diffObject(oldItems[0], newItems[0], itemPointer, inner, 'id');
    } else if (newItems.length === 1) {
      appeared.push({ pointer: itemPointer, value: newItems[0], matched: false });
    } else {
      vanished.push({ pointer: itemPointer, value: oldItems[0], matched: false });
    }
  }
  matchRenamed(appeared, vanished, inner);
  for (const item of appeared) {
    if (!item.matched) inner.changes.push({ op: 'added', pointer: item.pointer, value: item.value });
  }
  for (const item of vanished) {
    if (!item.matched) inner.changes.push({ op: 'deleted', pointer: item.pointer, old_value: item.value });
  }
  collect(inner, pointer, out);
}

function groupById(list: unknown[]): Map<string, Record<string, unknown>[]> {
  const groups = new Map<string, Record<string, unknown>[]>();
  for (const item of list) {
    if (!validId(item)) continue;
    const items = groups.get(item.id) ?? [];
    items.push(item);
    groups.set(item.id, items);
  }
  return groups;
}

const oneOrMany = (items: unknown[]): unknown => (items.length === 0 ? null : items.length === 1 ? items[0] : items);
const sortByKey = (items: unknown[]): unknown[] =>
  [...items].sort((left, right) => (serialize(left, true) < serialize(right, true) ? -1 : 1));

/**
 * An item that disappeared and an item that appeared with the same content but another id may be one requirement
 * whose id was renamed, or two unrelated changes. The engine cannot know, so it asks instead of reporting an
 * addition and a deletion as facts.
 */
function matchRenamed(appeared: Item[], vanished: Item[], inner: Collector): void {
  const body = (item: Item): string => serialize({ ...item.value, id: undefined }, true);
  const grouped = (items: Item[]): Map<string, Item[]> => {
    const groups = new Map<string, Item[]>();
    for (const item of items) {
      const key = body(item);
      const group = groups.get(key) ?? [];
      group.push(item);
      groups.set(key, group);
    }
    return groups;
  };
  const news = grouped(appeared);
  const olds = grouped(vanished);
  for (const key of sortedUnion(news, olds)) {
    const added = news.get(key) ?? [];
    const removed = olds.get(key) ?? [];
    if (added.length === 0 || removed.length === 0) continue;
    if (added.length === 1 && removed.length === 1) {
      added[0].matched = removed[0].matched = true;
      inner.changes.push({
        op: 'needs_review', pointer: added[0].pointer, reason: 'possible_rename',
        old_value: removed[0].value, new_value: added[0].value, related: [removed[0].pointer],
      });
      continue;
    }
    for (const item of [...added, ...removed]) {
      item.matched = true;
      inner.changes.push({
        op: 'needs_review', pointer: item.pointer, reason: 'ambiguous_match',
        old_value: removed.includes(item) ? item.value : null,
        new_value: added.includes(item) ? item.value : null,
        related: [...added, ...removed].filter(other => other !== item).map(other => other.pointer).sort(),
      });
    }
  }
}

function diffPlainList(base: unknown[], target: unknown[], pointer: string, out: Collector): void {
  const inner: Collector = { changes: [], unchanged: [] };
  const before = countBy(base);
  const after = countBy(target);
  for (const key of sortedUnion(before, after)) {
    const itemPointer = `${pointer}[=${key}]`;
    const from = before.get(key);
    const to = after.get(key);
    const kept = Math.min(from?.count ?? 0, to?.count ?? 0);
    for (let index = 0; index < kept; index++) inner.unchanged.push(itemPointer);
    for (let index = kept; index < (to?.count ?? 0); index++) {
      inner.changes.push({ op: 'added', pointer: itemPointer, value: to?.value });
    }
    for (let index = kept; index < (from?.count ?? 0); index++) {
      inner.changes.push({ op: 'deleted', pointer: itemPointer, old_value: from?.value });
    }
  }
  // The values may all still be there and only their order have moved. Whether order means anything is not for
  // the engine to know, so that is asked about too.
  if (orderMoved(base, target, before, after)) {
    inner.changes.push({ op: 'needs_review', pointer, reason: 'reordered', old_value: base, new_value: target, related: [] });
  }
  collect(inner, pointer, out);
}

function countBy(list: unknown[]): Map<string, { value: unknown; count: number }> {
  const counts = new Map<string, { value: unknown; count: number }>();
  for (const item of list) {
    const key = serialize(item, true);
    const entry = counts.get(key);
    if (entry) entry.count++;
    else counts.set(key, { value: item, count: 1 });
  }
  return counts;
}

/** Whether the values that both lists keep follow each other in the same order. */
function orderMoved(
  base: unknown[], target: unknown[], before: Map<string, { count: number }>, after: Map<string, { count: number }>,
): boolean {
  const kept = (list: unknown[], own: Map<string, { count: number }>, other: Map<string, { count: number }>): string[] => {
    const taken = new Map<string, number>();
    const keys: string[] = [];
    for (const item of list) {
      const key = serialize(item, true);
      const used = taken.get(key) ?? 0;
      if (used < Math.min(own.get(key)?.count ?? 0, other.get(key)?.count ?? 0)) {
        keys.push(key);
        taken.set(key, used + 1);
      }
    }
    return keys;
  };
  const first = kept(base, before, after);
  const second = kept(target, after, before);
  return first.length !== second.length || first.some((key, index) => key !== second[index]);
}

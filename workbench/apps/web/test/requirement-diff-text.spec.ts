import assert from 'node:assert/strict';
import { test } from 'node:test';
import { describePointer, formatDiffValue } from '../src/components/requirement-diff-text.js';

test('a pointer is said in words', () => {
  assert.equal(describePointer(''), '整份内容');
  assert.equal(describePointer('/title'), '标题');
  assert.equal(describePointer('/acceptanceCriteria'), '验收条目');
  assert.equal(describePointer('/acceptanceCriteria[id=AC-2]'), '验收条目 AC-2');
  assert.equal(describePointer('/acceptanceCriteria[id=AC-2]/text'), '验收条目 AC-2 / 内容');
  assert.equal(describePointer('/tags[="prod"]'), 'tags 中的 "prod"');
  // A name is shown as it is when there is no word for it, and an escaped name is unescaped.
  assert.equal(describePointer('/environment'), 'environment');
  assert.equal(describePointer('/x~1y/x~0z'), 'x/y / x~z');
  assert.equal(describePointer('/list[id=a~1b]/note'), 'list a/b / 备注');
});

test('a value is shown as it was stored', () => {
  assert.equal(formatDiffValue('text\nline'), 'text\nline');
  assert.equal(formatDiffValue(null), 'null');
  assert.equal(formatDiffValue(1.5), '1.5');
  assert.equal(formatDiffValue({ id: 'AC-3', text: 'third' }), '{\n  "id": "AC-3",\n  "text": "third"\n}');
  assert.equal(formatDiffValue(['a', 'b']), '[\n  "a",\n  "b"\n]');
});

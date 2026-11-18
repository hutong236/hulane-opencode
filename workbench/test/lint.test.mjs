import test from 'node:test';
import assert from 'node:assert/strict';
import { lintText } from '../scripts/lint.mjs';

test('accepts clean source', () => assert.deepEqual(lintText('const ok = true;\n'), []));
test('rejects conflict markers', () => {
  const errors = lintText('<<<<<<< HEAD\n=======\n>>>>>>> topic\n');
  assert.equal(errors.filter(message => message.includes('merge conflict')).length, 3);
});
test('rejects trailing whitespace and missing final newline', () => {
  const errors = lintText('const x = 1;  \nconst y = 2;');
  assert.ok(errors.some(message => message.includes('trailing whitespace')));
  assert.ok(errors.some(message => message.includes('missing final newline')));
});
test('rejects CRLF', () => assert.ok(lintText('x\r\n').some(message => message.includes('CRLF'))));

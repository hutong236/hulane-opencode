import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { lintDirectory, lintText } from '../scripts/lint.mjs';

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

test('skips dependencies, build output and the reports Playwright generates', () => {
  const root = mkdtempSync(join(realpathSync(tmpdir()), 'wb-lint-'));
  try {
    for (const directory of ['node_modules', 'dist', 'test-results', 'playwright-report', 'blob-report']) {
      mkdirSync(join(root, directory));
      // Without the exclusion each of these would be reported for its missing final newline.
      writeFileSync(join(root, directory, 'generated.json'), '{}');
    }
    mkdirSync(join(root, 'apps', 'web', 'src'), { recursive: true });
    writeFileSync(join(root, 'apps', 'web', 'src', 'ok.ts'), 'export const ok = true;\n');
    writeFileSync(join(root, 'apps', 'web', 'src', 'bad.ts'), 'export const bad = true;  \n');
    assert.deepEqual(lintDirectory(root), ['apps/web/src/bad.ts:1: trailing whitespace']);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

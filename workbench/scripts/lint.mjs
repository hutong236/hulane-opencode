#!/usr/bin/env node
import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const include = /\.(?:ts|tsx|js|mjs|json)$/;
// Dependencies, build output and the reports Playwright writes after a run are not source.
const ignored = new Set(['node_modules', 'dist', 'build', 'coverage', '.git',
  'test-results', 'playwright-report', 'blob-report']);

export function lintText(text, name = '<input>') {
  const errors = [];
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^(?:<{7}|={7}|>{7})(?:\s|$)/.test(line)) errors.push(`${name}:${i + 1}: unresolved merge conflict marker`);
    if (/[ \t]+$/.test(line)) errors.push(`${name}:${i + 1}: trailing whitespace`);
    if (line.includes('\r')) errors.push(`${name}:${i + 1}: CRLF line ending`);
  }
  if (text && !text.endsWith('\n')) errors.push(`${name}: missing final newline`);
  return errors;
}

function walk(dir) {
  const files = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (ignored.has(entry.name)) continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...walk(path));
    else if (entry.isFile() && include.test(entry.name) && entry.name !== 'package-lock.json') files.push(path);
  }
  return files;
}

/** Lint every source file below `dir`; returns one message per violation. */
export function lintDirectory(dir) {
  return walk(dir).flatMap(path => lintText(readFileSync(path, 'utf8'), relative(dir, path)));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === fileURLToPath(new URL(`file://${process.argv[1]}`))) {
  const errors = lintDirectory(root);
  if (errors.length) {
    console.error(errors.join('\n'));
    process.exitCode = 1;
  } else {
    console.log('Workbench source lint passed (merge markers, trailing whitespace, CRLF, final newline).');
  }
}

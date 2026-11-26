#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';

/**
 * Initializes copies of each sandbox example as separate Git repositories with one commit. A second run changes
 * nothing and reports `already initialized`, so the demo can be rebuilt in place. `--root` is required and must
 * point at a copy containing `cmdb/`, `automation/` and `monitoring/`; never initialize the templates inside the
 * Workbench checkout.
 */
const EXAMPLE_NAMES = ['cmdb', 'automation', 'monitoring'];
const rootFlag = process.argv.indexOf('--root');
const root = rootFlag === -1 ? undefined : process.argv[rootFlag + 1];

if (!root) {
  console.error('init-example-repos: usage: node init-example-repos.mjs --root <directory>');
  console.error('The directory must contain copies of cmdb/, automation/ and monitoring/.');
  process.exit(1);
}

const base = resolve(root);
for (const name of EXAMPLE_NAMES) {
  const repo = join(base, name);
  if (!existsSync(join(repo, 'package.json'))) {
    console.error(`init-example-repos: ${name} is not an example directory below ${base}`);
    process.exitCode = 1;
    continue;
  }
  if (existsSync(join(repo, '.git'))) {
    console.log(`${name}: already initialized`);
    continue;
  }
  execFileSync('git', ['init', '-q', '-b', 'main', repo], { stdio: 'ignore' });
  execFileSync('git', ['-C', repo, 'add', '-A']);
  execFileSync('git', [
    '-C', repo,
    '-c', 'user.name=Workbench Example',
    '-c', 'user.email=example@example.invalid',
    '-c', 'commit.gpgsign=false',
    'commit', '-qm', 'example: initialize sandbox project',
  ], { stdio: 'ignore' });
  console.log(`${name}: initialized`);
}

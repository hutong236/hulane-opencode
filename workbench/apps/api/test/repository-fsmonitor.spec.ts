import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { readRepositoryStatus } from '../src/repository-status.js';
import { fixturePrefix } from './fixture-prefix.js';

test('Git status does not execute repository-configured fsmonitor command', async () => {
  const directory = await mkdtemp(fixturePrefix('wb-fsmonitor-'));
  try {
    const repo = join(directory, 'repo');
    const marker = join(directory, 'fsmonitor-executed');
    const hook = join(directory, 'fsmonitor.sh');
    await mkdir(repo);
    execFileSync('git', ['init', '-q', repo]);
    execFileSync('git', ['-C', repo, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid',
      'commit', '--allow-empty', '-qm', 'initial']);
    await writeFile(hook, '#!/bin/sh\nprintf "executed" > "' + marker + '"\n', { mode: 0o755 });
    execFileSync('git', ['-C', repo, 'config', 'core.fsmonitor', hook]);
    const status = await readRepositoryStatus(repo);
    assert.equal(status.repoRoot, repo);
    assert.equal(status.dirty, false);
    await assert.rejects(readFile(marker), { code: 'ENOENT' }, 'untrusted fsmonitor must not run');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

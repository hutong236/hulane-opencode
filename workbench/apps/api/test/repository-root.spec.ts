import assert from 'node:assert/strict';
import { mkdtemp, mkdir, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { test } from 'node:test';
import { validateRepositoryRoot } from '../src/repository-root.ts';

test('accepts canonical Git roots and rejects nested, non-Git and symlink paths', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'wb-repo-root-'));
  try {
    const repo = join(temp, 'repo');
    await mkdir(repo);
    execFileSync('git', ['init', '-q', repo]);
    await mkdir(join(repo, 'nested'));
    assert.equal(await validateRepositoryRoot(repo), repo);
    await assert.rejects(validateRepositoryRoot(join(repo, 'nested')), /Git worktree root/);
    await assert.rejects(validateRepositoryRoot(temp), /Command failed|not a git repository/i);
    await assert.rejects(validateRepositoryRoot('relative/repo'), /absolute/);
    const alias = join(temp, 'alias');
    await symlink(repo, alias);
    await assert.rejects(validateRepositoryRoot(alias), /Symbolic-link/);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

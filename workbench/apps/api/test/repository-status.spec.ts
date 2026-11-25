import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { readRepositoryStatus } from '../src/repository-status.ts';
import { fixturePrefix } from './fixture-prefix.js';

test('reads real branch, HEAD and dirty status without modifying the repository', async () => {
  const temp = await mkdtemp(fixturePrefix('wb-repo-status-'));
  try {
    const repo = join(temp, 'repo');
    await mkdir(repo);
    const git = (...args: string[]) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' }).trim();
    git('init', '-q');
    git('config', 'user.email', 'test@example.invalid');
    git('config', 'user.name', 'Workbench Test');
    git('commit', '--allow-empty', '-m', 'initial');
    const clean = await readRepositoryStatus(repo);
    assert.equal(clean.repoRoot, repo);
    assert.equal(clean.headSha, git('rev-parse', 'HEAD'));
    assert.equal(clean.branch, git('symbolic-ref', '--short', 'HEAD'));
    assert.equal(clean.dirty, false);
    await import('node:fs/promises').then(({ writeFile }) => writeFile(join(repo, 'untracked.txt'), 'change'));
    assert.equal((await readRepositoryStatus(repo)).dirty, true);
    git('checkout', '--detach', '-q');
    const detached = await readRepositoryStatus(repo);
    assert.equal(detached.branch, null);
    assert.equal(detached.headSha, clean.headSha);
    assert.equal(detached.dirty, true);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test('rejects nested paths rather than silently reading a parent repository', async () => {
  const temp = await mkdtemp(fixturePrefix('wb-repo-status-nested-'));
  try {
    const repo = join(temp, 'repo');
    await mkdir(repo);
    execFileSync('git', ['init', '-q', repo]);
    await mkdir(join(repo, 'nested'));
    await assert.rejects(readRepositoryStatus(join(repo, 'nested')), /not_git_root/);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test('unborn Git repository reports null HEAD and detects staged changes', async () => {
  const temp = await mkdtemp(fixturePrefix('wb-repo-status-unborn-'));
  try {
    const repo = join(temp, 'repo');
    await mkdir(repo);
    const git = (...args: string[]) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' }).trim();
    git('init', '-q');
    const branch = git('symbolic-ref', '--short', 'HEAD');
    const unborn = await readRepositoryStatus(repo);
    assert.deepEqual(unborn, { repoRoot: repo, headSha: null, branch, dirty: false });

    const { writeFile } = await import('node:fs/promises');
    await writeFile(join(repo, 'staged.txt'), 'staged content');
    git('add', '--', 'staged.txt');
    const staged = await readRepositoryStatus(repo);
    assert.equal(staged.headSha, null);
    assert.equal(staged.branch, branch);
    assert.equal(staged.dirty, true);

    git('reset', '--', 'staged.txt');
    assert.equal((await readRepositoryStatus(repo)).dirty, true, 'untracked file remains dirty');
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

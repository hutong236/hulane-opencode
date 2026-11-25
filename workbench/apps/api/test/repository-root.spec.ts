import assert from 'node:assert/strict';
import { mkdtemp, mkdir, symlink, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { test } from 'node:test';
import { validateRepositoryRoot } from '../src/repository-root.ts';
import { fixturePrefix } from './fixture-prefix.js';

test('accepts canonical Git roots and rejects nested, non-Git and symlink paths', async () => {
  const temp = await mkdtemp(fixturePrefix('wb-repo-root-'));
  try {
    const repo = join(temp, 'repo');
    await mkdir(repo);
    execFileSync('git', ['init', '-q', repo]);
    await mkdir(join(repo, 'nested'));
    assert.equal(await validateRepositoryRoot(repo), repo);
    await assert.rejects(validateRepositoryRoot(join(repo, 'nested')), /not_git_root/);
    await assert.rejects(validateRepositoryRoot(temp), /not_git_root/);
    await assert.rejects(validateRepositoryRoot('relative/repo'), /absolute/);
    const alias = join(temp, 'alias');
    await symlink(repo, alias);
    await assert.rejects(validateRepositoryRoot(alias), /symlink/);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test('rejects bare repositories and ignores inherited Git redirection variables', async () => {
  const temp = await mkdtemp(fixturePrefix('wb-repo-git-env-'));
  try {
    const valid = join(temp, 'valid');
    const bare = join(temp, 'bare.git');
    await mkdir(valid);
    execFileSync('git', ['init', '-q', valid]);
    execFileSync('git', ['init', '-q', '--bare', bare]);
    await assert.rejects(validateRepositoryRoot(bare), /not_git_root/);
    const original = process.env.GIT_DIR;
    try {
      process.env.GIT_DIR = join(valid, '.git');
      assert.equal(await validateRepositoryRoot(valid), valid);
      await assert.rejects(validateRepositoryRoot(temp), /not_git_root/);
    } finally {
      if (original === undefined) delete process.env.GIT_DIR;
      else process.env.GIT_DIR = original;
    }
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});


test('ignores injected Git config and object-directory environment overrides', async () => {
  const temp = await mkdtemp(fixturePrefix('wb-repo-git-config-'));
  const keys = ['GIT_CONFIG_COUNT', 'GIT_CONFIG_KEY_0', 'GIT_CONFIG_VALUE_0', 'GIT_OBJECT_DIRECTORY'];
  const previous = new Map(keys.map((key) => [key, process.env[key]]));
  try {
    const repo = join(temp, 'repo');
    await mkdir(repo);
    execFileSync('git', ['init', '-q', repo]);
    process.env.GIT_CONFIG_COUNT = '1';
    process.env.GIT_CONFIG_KEY_0 = 'core.bare';
    process.env.GIT_CONFIG_VALUE_0 = 'true';
    process.env.GIT_OBJECT_DIRECTORY = join(temp, 'missing-objects');
    assert.equal(await validateRepositoryRoot(repo), repo);
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await rm(temp, { recursive: true, force: true });
  }
});

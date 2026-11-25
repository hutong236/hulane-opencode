import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { WorkbenchDatabase } from '@hulane/workbench-database';
import { buildApp } from '../src/app.js';
import { readRepositoryStatus } from '../src/repository-status.js';
import { fixturePrefix } from './fixture-prefix.js';

const init = (repo: string) => execFileSync('git', ['init', '-q', '-b', 'main', repo]);
const commit = (repo: string) => execFileSync('git', ['-C', repo, '-c', 'user.name=Workbench Test', '-c', 'user.email=test@example.invalid',
  '-c', 'commit.gpgsign=false', 'commit', '-qm', 'initial'], { stdio: 'ignore' });
/** Content digest of every file under a directory, `.git` included. */
function snapshot(directory: string, prefix = ''): Record<string, string> {
  const entries: Record<string, string> = {};
  for (const name of readdirSync(directory).sort()) {
    const path = join(directory, name);
    if (lstatSync(path).isDirectory()) Object.assign(entries, snapshot(path, `${prefix}${name}/`));
    else entries[prefix + name] = createHash('sha256').update(readFileSync(path)).digest('hex');
  }
  return entries;
}
function tempRoot(prefix: string): string { return mkdtempSync(fixturePrefix(prefix)); }
const root = process.getuid?.() === 0;

test('each refused path is refused with a reason, and the reason never contains the path', async () => {
  const temp = tempRoot('wb-reasons-');
  const db = new WorkbenchDatabase({ dataDirectory: join(temp, 'data') });
  const app = buildApp({ database: db });
  const locked = join(temp, 'locked');
  try {
    const repo = join(temp, 'repo');
    init(repo);
    writeFileSync(join(repo, 'README.md'), 'x\n');
    execFileSync('git', ['-C', repo, 'add', '.']);
    commit(repo);
    mkdirSync(join(repo, 'nested'));
    const plain = join(temp, 'plain'); mkdirSync(plain);
    const file = join(temp, 'a-file.txt'); writeFileSync(file, 'x');
    symlinkSync(repo, join(temp, 'alias'));
    mkdirSync(locked); chmodSync(locked, 0o000);
    const cases: [string, string, string][] = [
      ['relative', 'relative/repo', 'not_absolute'],
      ['missing', join(temp, 'nope'), 'missing'],
      ['a file', file, 'not_directory'],
      ['a plain directory', plain, 'not_git_root'],
      ['a directory inside a repository', join(repo, 'nested'), 'not_git_root'],
      ['a symlink alias', join(temp, 'alias'), 'symlink'],
    ];
    if (!root) cases.push(['an unreadable directory', locked, 'unreadable']);
    for (const [label, path, reason] of cases) {
      const validated = await app.inject({ method: 'POST', url: '/api/projects/validate', payload: { path } });
      assert.equal(validated.statusCode, 400, label);
      assert.deepEqual(validated.json(), { error: 'Invalid Git repository root', reason }, label);
      const registered = await app.inject({ method: 'POST', url: '/api/projects',
        payload: { path, slug: 'cmdb', name: 'CMDB' } });
      assert.equal(registered.statusCode, 400, label);
      assert.deepEqual(registered.json(), { error: 'Invalid Git repository root', reason }, label);
      assert.equal(registered.body.includes(temp), false, `${label}: the path is not echoed`);
    }
    assert.deepEqual((await app.inject({ method: 'GET', url: '/api/projects' })).json(), { projects: [] });
    // The symlink itself is still a repository when it is reached by its real path.
    assert.deepEqual((await app.inject({ method: 'POST', url: '/api/projects/validate', payload: { path: repo } })).json(), { repoRoot: repo });
  } finally {
    if (existsLocked(locked)) chmodSync(locked, 0o755);
    await app.close(); db.close(); rmSync(temp, { recursive: true, force: true });
  }
});
const existsLocked = (path: string) => { try { lstatSync(path); return true; } catch { return false; } };

test('a repository nobody may write to can be registered, read and unregistered, and is left exactly as it was', { skip: root }, async () => {
  const temp = tempRoot('wb-readonly-');
  const repo = join(temp, 'repo');
  init(repo);
  writeFileSync(join(repo, 'README.md'), 'committed\n');
  execFileSync('git', ['-C', repo, 'add', '.']);
  commit(repo);
  writeFileSync(join(repo, 'untracked.txt'), 'uncommitted work in a read-only repository\n');
  const db = new WorkbenchDatabase({ dataDirectory: join(temp, 'data') });
  const app = buildApp({ database: db });
  try {
    // The digest is taken before anything is made read-only, so it does not depend on how that is done.
    const before = snapshot(repo);
    const makeReadOnly = (path: string) => chmodSync(path, lstatSync(path).isDirectory() ? 0o555 : 0o444);
    const walk = (directory: string) => {
      for (const name of readdirSync(directory)) {
        const path = join(directory, name);
        if (lstatSync(path).isDirectory()) walk(path);
        makeReadOnly(path);
      }
      makeReadOnly(directory);
    };
    walk(join(repo, '.git'));
    makeReadOnly(join(repo, 'README.md'));
    makeReadOnly(join(repo, 'untracked.txt'));
    makeReadOnly(repo);
    assert.equal(lstatSync(repo).mode & 0o222, 0, 'the repository is read-only');

    const registered = await app.inject({ method: 'POST', url: '/api/projects', payload: { path: repo, slug: 'locked', name: 'Locked' } });
    assert.equal(registered.statusCode, 201);
    const id = registered.json().id as string;
    const status = await app.inject({ method: 'GET', url: `/api/projects/${id}/status` });
    assert.equal(status.statusCode, 200);
    assert.equal(status.json().dirty, true);
    assert.equal(status.json().branch, 'main');
    assert.equal(status.json().headSha, execFileSync('git', ['-C', repo, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim());
    assert.equal((await app.inject({ method: 'DELETE', url: `/api/projects/${id}` })).statusCode, 204);

    assert.deepEqual(snapshot(repo), before, 'nothing inside the read-only repository changed');
    assert.equal((lstatSync(repo).mode & 0o222), 0, 'the directory is still read-only');
    assert.equal(readFileSync(join(repo, 'untracked.txt'), 'utf8'), 'uncommitted work in a read-only repository\n');
  } finally {
    execFileSync('chmod', ['-R', 'u+w', temp], { stdio: 'ignore' });
    await app.close(); db.close(); rmSync(temp, { recursive: true, force: true });
  }
});

test('reading the status never rewrites the index, even when its cached file information is stale', async () => {
  const temp = tempRoot('wb-index-');
  const repo = join(temp, 'repo');
  init(repo);
  writeFileSync(join(repo, 'tracked.txt'), 'same content\n');
  execFileSync('git', ['-C', repo, 'add', '.']);
  commit(repo);
  const digest = () => createHash('sha256').update(readFileSync(join(repo, '.git', 'index'))).digest('hex');
  const before = digest();
  try {
    // Same content, new timestamps: Git's cached stat information no longer matches the file.
    const later = new Date(Date.now() + 3_600_000);
    utimesSync(join(repo, 'tracked.txt'), later, later);
    assert.deepEqual(await readRepositoryStatus(repo), { repoRoot: repo, headSha: execFileSync('git', ['-C', repo, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), branch: 'main', dirty: false });
    assert.equal(digest(), before, 'the index is byte-identical after the read');
    // Reading it twice is stable too.
    await readRepositoryStatus(repo);
    assert.equal(digest(), before);
  } finally { rmSync(temp, { recursive: true, force: true }); }
});

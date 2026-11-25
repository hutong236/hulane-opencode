import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { WorkbenchDatabase } from '@hulane/workbench-database';
import { buildApp } from '../src/app.js';
import { readDefaultBranch, readRepositoryMetadata, redactRemoteUrl } from '../src/repository-metadata.js';
import { fixturePrefix } from './fixture-prefix.js';

const identity = ['-c', 'user.name=Workbench Test', '-c', 'user.email=test@example.invalid', '-c', 'commit.gpgsign=false'];
const git = (repo: string, ...args: string[]) =>
  execFileSync('git', ['-C', repo, ...identity, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
type Project = { id: string; slug: string; name: string; default_branch: string; remote_url: string | null };
type Answer = { status: number; body: Project | { error: string } };
/** `git init` for a directory that does not exist yet, so `-C` cannot be used. */
const init = (...args: string[]) => execFileSync('git', ['init', '-q', ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

async function setup() {
  const temp = mkdtempSync(fixturePrefix('wb-metadata-'));
  const db = new WorkbenchDatabase({ dataDirectory: join(temp, 'data') });
  const app = buildApp({ database: db });
  const register = async (slug: string, path: string): Promise<Answer> => {
    const response = await app.inject({ method: 'POST', url: '/api/projects', payload: { path, slug, name: slug.toUpperCase() } });
    return { status: response.statusCode, body: response.json() };
  };
  return {
    temp, app, register,
    dispose: async () => { await app.close(); db.close(); rmSync(temp, { recursive: true, force: true }); },
  };
}
/** A repository with one commit on `branch`, checked out there. */
function repository(parent: string, name: string, branch: string): string {
  const repo = join(parent, name);
  init('-b', branch, repo);
  writeFileSync(join(repo, 'README.md'), `${name}\n`);
  git(repo, 'add', '--', 'README.md');
  git(repo, 'commit', '-qm', 'initial');
  return repo;
}

test('a remote URL loses its user name and password and nothing else', () => {
  assert.equal(redactRemoteUrl(null), null);
  assert.equal(redactRemoteUrl(''), null);
  assert.equal(redactRemoteUrl('https://user:s3cr3t@github.com/example/repo.git'), 'https://github.com/example/repo.git');
  assert.equal(redactRemoteUrl('https://x-access-token:ghp_SECRET@github.com/example/repo.git'), 'https://github.com/example/repo.git');
  assert.equal(redactRemoteUrl('https://token@github.com/example/repo.git'), 'https://github.com/example/repo.git');
  assert.equal(redactRemoteUrl('ssh://git@github.com/example/repo.git'), 'ssh://github.com/example/repo.git');
  assert.equal(redactRemoteUrl('https://git.example.com:8443/team/repo.git'), 'https://git.example.com:8443/team/repo.git');
  assert.equal(redactRemoteUrl('https://example.com/a%20b.git'), 'https://example.com/a%20b.git');
  // The scp-like form and a local path carry no password and stay exactly as Git reports them.
  assert.equal(redactRemoteUrl('git@github.com:example/repo.git'), 'git@github.com:example/repo.git');
  assert.equal(redactRemoteUrl('/private/repos/origin.git'), '/private/repos/origin.git');
  // A URL with a scheme that cannot be parsed could not be checked, so it is not stored at all.
  assert.equal(redactRemoteUrl('https://[not-a-valid-host/x'), null);
});

test('registration records where origin points and the origin URL', async () => {
  const { temp, app, register, dispose } = await setup();
  try {
    const seed = repository(temp, 'seed', 'develop');
    const origin = join(temp, 'upstream.git');
    init('--bare', '-b', 'develop', origin);
    git(seed, 'push', '-q', origin, 'develop');
    // The clone is checked out on another branch: the default branch must still come from origin.
    const clone = join(temp, 'clone');
    execFileSync('git', ['clone', '-q', origin, clone]);
    git(clone, 'checkout', '-qb', 'feature/elsewhere');

    const created = await register('cloned', clone);
    assert.equal(created.status, 201);
    const project = created.body as Project;
    assert.equal(project.default_branch, 'develop');
    assert.equal(project.remote_url, origin);
    // List and detail agree with the registration answer.
    assert.deepEqual((await app.inject({ method: 'GET', url: `/api/projects/${project.id}` })).json(), project);
    assert.deepEqual((await app.inject({ method: 'GET', url: '/api/projects' })).json().projects, [project]);
    // Reading the metadata changed nothing in the repository.
    assert.equal(git(clone, 'status', '--porcelain'), '');
    assert.equal(git(clone, 'symbolic-ref', '--short', 'HEAD'), 'feature/elsewhere');
  } finally { await dispose(); }
});

test('credentials in an origin URL never reach any response', async () => {
  const { temp, app, register, dispose } = await setup();
  try {
    const cases = [
      { slug: 'https', url: 'https://deploy:s3cr3t-Token@git.example.com:8443/team/repo.git', expected: 'https://git.example.com:8443/team/repo.git' },
      { slug: 'token-only', url: 'https://ghp_SECRET@github.com/example/repo.git', expected: 'https://github.com/example/repo.git' },
      { slug: 'ssh', url: 'git@github.com:example/repo.git', expected: 'git@github.com:example/repo.git' },
      { slug: 'unparsable', url: 'https://[not-a-valid-host/x', expected: null },
    ];
    const ids: string[] = [];
    for (const { slug, url, expected } of cases) {
      const repo = join(temp, slug);
      init('-b', 'trunk', repo);
      git(repo, 'remote', 'add', 'origin', url);
      const created = await register(slug, repo);
      assert.equal(created.status, 201, slug);
      // No remote means no origin/HEAD: the branch in use is recorded.
      assert.equal((created.body as Project).default_branch, 'trunk', slug);
      assert.equal((created.body as Project).remote_url, expected, slug);
      ids.push((created.body as Project).id);
    }
    const responses = [
      (await app.inject({ method: 'GET', url: '/api/projects' })).body,
      ...await Promise.all(ids.map(id => app.inject({ method: 'GET', url: `/api/projects/${id}` }).then(response => response.body))),
    ].join('\n');
    assert.equal(responses.includes('s3cr3t-Token'), false);
    assert.equal(responses.includes('ghp_SECRET'), false);
    assert.equal(responses.includes('deploy'), false);
    // The stored records are what the responses show: nothing more is kept.
    for (const id of ids) {
      const raw = (await app.inject({ method: 'GET', url: `/api/projects/${id}` })).json() as Project;
      assert.ok(cases.some(entry => entry.expected === raw.remote_url), raw.remote_url ?? 'null');
    }
  } finally { await dispose(); }
});

test('without a remote the conventional branch is recorded, else the one that exists', async () => {
  const { temp, dispose } = await setup();
  try {
    const repo = repository(temp, 'repo', 'main');
    git(repo, 'checkout', '-qb', 'feature/work');
    // On a feature branch with main present: new work still starts from main.
    assert.deepEqual(await readRepositoryMetadata(repo), { defaultBranch: 'main', remoteUrl: null });

    const legacy = repository(temp, 'legacy', 'master');
    assert.deepEqual(await readRepositoryMetadata(legacy), { defaultBranch: 'master', remoteUrl: null });

    const trunk = repository(temp, 'trunk', 'trunk');
    assert.deepEqual(await readRepositoryMetadata(trunk), { defaultBranch: 'trunk', remoteUrl: null });

    // Before the first commit the branch does not exist as a ref, but it is still the branch in use.
    const unborn = join(temp, 'unborn');
    init('-b', 'trunk', unborn);
    assert.equal(await readDefaultBranch(unborn), 'trunk');

    const detached = repository(temp, 'detached', 'trunk');
    git(detached, 'checkout', '-q', '--detach');
    assert.equal(await readDefaultBranch(detached), 'HEAD');
  } finally { await dispose(); }
});

test('an inherited Git environment override cannot redirect what is recorded', async () => {
  const { temp, register, dispose } = await setup();
  const saved = { GIT_DIR: process.env.GIT_DIR, GIT_CONFIG_COUNT: process.env.GIT_CONFIG_COUNT };
  try {
    const target = join(temp, 'target');
    init('-b', 'trunk', target);
    git(target, 'remote', 'add', 'origin', 'https://example.invalid/team/target.git');
    const elsewhere = repository(temp, 'elsewhere', 'main');
    process.env.GIT_DIR = join(elsewhere, '.git');
    process.env.GIT_CONFIG_COUNT = '1';
    process.env.GIT_CONFIG_KEY_0 = 'core.fsmonitor';
    process.env.GIT_CONFIG_VALUE_0 = 'true';
    const created = await register('target', target);
    assert.equal(created.status, 201);
    assert.equal((created.body as Project).default_branch, 'trunk');
    assert.equal((created.body as Project).remote_url, 'https://example.invalid/team/target.git');
  } finally {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name]; else process.env[name] = value;
    }
    delete process.env.GIT_CONFIG_KEY_0;
    delete process.env.GIT_CONFIG_VALUE_0;
    await dispose();
  }
});

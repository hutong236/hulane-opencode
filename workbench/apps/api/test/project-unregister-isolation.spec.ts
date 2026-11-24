import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { WorkbenchDatabase } from '@hulane/workbench-database';
import { buildApp } from '../src/app.js';
import { fixturePrefix } from './fixture-prefix.js';

// Commits need an identity; hooks and signing from a developer's global Git config must not interfere.
const isolated = ['-c', 'user.name=Workbench Test', '-c', 'user.email=test@example.invalid',
  '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false'];
const run = (flags: string[], repo: string, ...args: string[]) =>
  execFileSync('git', [...flags, '-C', repo, ...isolated, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const git = (repo: string, ...args: string[]) => run([], repo, ...args).trim();
/** `--no-optional-locks` keeps this test's own reads from rewriting Git's index. */
const readOnly = (repo: string, ...args: string[]) => run(['--no-optional-locks'], repo, ...args).trim();
/** The leading column of porcelain status is meaningful (` M` unstaged, `A ` staged), so it is not trimmed. */
const changes = (repo: string) =>
  run(['--no-optional-locks'], repo, 'status', '--porcelain=v1', '--untracked-files=normal').trimEnd();
const refs = (repo: string) => readOnly(repo, 'for-each-ref', '--format=%(refname) %(objectname)');

/** Content digest of every file under a directory, `.git` included: a deleted, rewritten or recreated file changes it. */
function snapshot(directory: string, prefix = ''): Record<string, string> {
  const entries: Record<string, string> = {};
  for (const name of readdirSync(directory).sort()) {
    const path = join(directory, name);
    if (lstatSync(path).isDirectory()) Object.assign(entries, snapshot(path, `${prefix}${name}/`));
    else entries[prefix + name] = createHash('sha256').update(readFileSync(path)).digest('hex');
  }
  return entries;
}

function createRepository(repoRoot: string, kind: 'clean' | 'dirty' | 'unborn'): void {
  mkdirSync(repoRoot);
  git(repoRoot, 'init', '-q', '-b', 'main');
  if (kind === 'unborn') {
    writeFileSync(join(repoRoot, 'untracked.txt'), 'untracked file in a repository without commits');
    return;
  }
  writeFileSync(join(repoRoot, 'README.md'), `# ${kind}\n`);
  git(repoRoot, 'add', '--', 'README.md');
  git(repoRoot, 'commit', '-qm', 'initial');
  if (kind === 'clean') {
    git(repoRoot, 'checkout', '-qb', 'feature/second');
    writeFileSync(join(repoRoot, 'second.txt'), 'committed on another branch\n');
    git(repoRoot, 'add', '--', 'second.txt');
    git(repoRoot, 'commit', '-qm', 'second');
    git(repoRoot, 'checkout', '-q', 'main');
    return;
  }
  writeFileSync(join(repoRoot, 'README.md'), '# dirty\nmodified but not staged\n');
  writeFileSync(join(repoRoot, 'staged.txt'), 'staged but not committed\n');
  git(repoRoot, 'add', '--', 'staged.txt');
  writeFileSync(join(repoRoot, 'untracked.txt'), 'untracked, must survive\n');
}

interface ListedProject { id: string; slug: string }

test('unregistering one repository leaves the other registrations and every workspace file intact', async () => {
  const temp = mkdtempSync(fixturePrefix('wb-unregister-isolation-'));
  const dataDirectory = join(temp, 'data');
  mkdirSync(join(temp, 'repositories'));
  const repositories = {
    cmdb: join(temp, 'repositories', 'cmdb'),
    automation: join(temp, 'repositories', 'automation'),
    monitoring: join(temp, 'repositories', 'monitoring'),
  };
  createRepository(repositories.cmdb, 'clean');
  createRepository(repositories.automation, 'dirty');
  createRepository(repositories.monitoring, 'unborn');
  const slugs = async (app: ReturnType<typeof buildApp>) => {
    const list = await app.inject({ method: 'GET', url: '/api/projects' });
    assert.equal(list.statusCode, 200);
    return (list.json().projects as ListedProject[]).map(project => project.slug);
  };

  let db = new WorkbenchDatabase({ dataDirectory });
  let app = buildApp({ database: db });
  let automationId: string;
  try {
    const ids: Record<string, string> = {};
    for (const [slug, repoRoot] of Object.entries(repositories)) {
      const registered = await app.inject({ method: 'POST', url: '/api/projects',
        payload: { path: repoRoot, slug, name: slug.toUpperCase() } });
      assert.equal(registered.statusCode, 201, `register ${slug}`);
      ids[slug] = registered.json().id as string;
    }
    automationId = ids.automation;
    const status = async (slug: string) => {
      const response = await app.inject({ method: 'GET', url: `/api/projects/${ids[slug]}/status` });
      assert.equal(response.statusCode, 200, `status ${slug}`);
      return response.json();
    };
    // Known from how the fixtures were built; the API must report exactly this before and after the unregister.
    const expected = {
      cmdb: { repoRoot: repositories.cmdb, headSha: git(repositories.cmdb, 'rev-parse', 'HEAD'), branch: 'main', dirty: false },
      automation: { repoRoot: repositories.automation, headSha: git(repositories.automation, 'rev-parse', 'HEAD'), branch: 'main', dirty: true },
      monitoring: { repoRoot: repositories.monitoring, headSha: null, branch: 'main', dirty: true },
    };
    for (const slug of Object.keys(repositories)) assert.deepEqual(await status(slug), expected[slug as keyof typeof expected]);
    // Reading a status may refresh Git's index, so the baseline is taken afterwards.
    const before = Object.fromEntries(Object.entries(repositories).map(([slug, repoRoot]) => [slug, snapshot(repoRoot)]));
    const automationChanges = changes(repositories.automation);
    const automationRefs = refs(repositories.automation);
    const cmdbRefs = refs(repositories.cmdb);

    const deleted = await app.inject({ method: 'DELETE', url: `/api/projects/${automationId}` });
    assert.equal(deleted.statusCode, 204);
    assert.equal(deleted.body, '');

    // Nothing is read in between: unregistering must not have touched any of the three directories.
    for (const [slug, repoRoot] of Object.entries(repositories)) {
      assert.deepEqual(snapshot(repoRoot), before[slug], `${slug} must keep every file unchanged`);
    }
    assert.equal(changes(repositories.automation), automationChanges);
    assert.deepEqual(automationChanges.split('\n'), [' M README.md', 'A  staged.txt', '?? untracked.txt']);
    assert.equal(readFileSync(join(repositories.automation, 'README.md'), 'utf8'), '# dirty\nmodified but not staged\n');
    assert.equal(readFileSync(join(repositories.automation, 'staged.txt'), 'utf8'), 'staged but not committed\n');
    assert.equal(readFileSync(join(repositories.automation, 'untracked.txt'), 'utf8'), 'untracked, must survive\n');
    assert.equal(refs(repositories.automation), automationRefs);
    assert.equal(refs(repositories.cmdb), cmdbRefs);
    assert.match(cmdbRefs, /refs\/heads\/feature\/second [0-9a-f]{40}/);

    assert.deepEqual(await slugs(app), ['cmdb', 'monitoring']);
    assert.deepEqual(await status('cmdb'), expected.cmdb);
    assert.deepEqual(await status('monitoring'), expected.monitoring);
    for (const url of [`/api/projects/${automationId}`, `/api/projects/${automationId}/status`]) {
      const gone = await app.inject({ method: 'GET', url });
      assert.equal(gone.statusCode, 404);
      assert.ok(!gone.body.includes(temp), 'never expose local paths');
    }
    const repeated = await app.inject({ method: 'DELETE', url: `/api/projects/${automationId}` });
    assert.equal(repeated.statusCode, 404);
    assert.ok(!repeated.body.includes(temp));
  } finally {
    await app.close();
    db.close();
  }

  // A restart opens the same SQLite file: both remaining registrations and the removal must persist.
  db = new WorkbenchDatabase({ dataDirectory });
  app = buildApp({ database: db });
  try {
    assert.deepEqual(await slugs(app), ['cmdb', 'monitoring']);
    assert.equal((await app.inject({ method: 'GET', url: `/api/projects/${automationId}` })).statusCode, 404);
    // The directory was never removed, so the same repository can be registered again with a new ID.
    const again = await app.inject({ method: 'POST', url: '/api/projects',
      payload: { path: repositories.automation, slug: 'automation', name: 'AUTOMATION' } });
    assert.equal(again.statusCode, 201);
    assert.notEqual(again.json().id, automationId);
    const restored = await app.inject({ method: 'GET', url: `/api/projects/${again.json().id}/status` });
    assert.equal(restored.statusCode, 200);
    assert.equal(restored.json().dirty, true);
    assert.equal(restored.json().headSha, git(repositories.automation, 'rev-parse', 'HEAD'));
    assert.deepEqual(await slugs(app), ['cmdb', 'monitoring', 'automation']);
  } finally {
    await app.close();
    db.close();
    rmSync(temp, { recursive: true, force: true });
  }
});

import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';

/**
 * Real WB-004 flow: a real Fastify process, real Git repositories and the real page. Nothing under /api is mocked.
 * The page comes from the usual web server; only its /api calls are pointed at the API process started here, on its own
 * port and with its own SQLite directory, so the developer's real registrations are never read or written.
 */
test.describe.configure({ mode: 'serial', timeout: 120_000 });

// Commits need an identity; hooks and signing from a developer's global Git config must not interfere.
const isolated = ['-c', 'user.name=Workbench Test', '-c', 'user.email=test@example.invalid',
  '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false'];
const run = (flags: string[], repo: string, ...args: string[]) =>
  execFileSync('git', [...flags, '-C', repo, ...isolated, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const git = (repo: string, ...args: string[]) => run([], repo, ...args).trim();
/** The leading column of porcelain status is meaningful (` M` unstaged, `A ` staged), and `--no-optional-locks` keeps this read from rewriting the index. */
const changes = (repo: string) =>
  run(['--no-optional-locks'], repo, 'status', '--porcelain=v1', '--untracked-files=normal').trimEnd();

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
  if (kind === 'clean') return;
  // Its uncommitted work sits on another branch, so a hard-coded or stored branch cannot pass for the live one.
  git(repoRoot, 'checkout', '-qb', 'feature/automation');
  writeFileSync(join(repoRoot, 'README.md'), '# dirty\nmodified but not staged\n');
  writeFileSync(join(repoRoot, 'staged.txt'), 'staged but not committed\n');
  git(repoRoot, 'add', '--', 'staged.txt');
  writeFileSync(join(repoRoot, 'untracked.txt'), 'untracked, must survive\n');
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      const port = address && typeof address === 'object' ? address.port : 0;
      probe.close(() => resolve(port));
    });
  });
}

interface ApiProcess { port: number; origin: string; stop: () => Promise<void> }
let apiOutput = '';
/**
 * Starts the real API from the workbench root on a free port with the given SQLite directory and waits until it answers
 * /api/health. It is started with the directory of the Playwright configuration because `config.rootDir` follows the file
 * filters given on the command line and the launch directory is not guaranteed.
 */
async function startApi(workbenchRoot: string, dataDirectory: string): Promise<ApiProcess> {
  const port = await freePort();
  const child: ChildProcess = spawn(process.execPath, ['--import', 'tsx', 'apps/api/src/server.ts'], {
    cwd: workbenchRoot,
    env: { ...process.env, WORKBENCH_HOST: '127.0.0.1', WORKBENCH_API_PORT: String(port), WORKBENCH_DATA_DIR: dataDirectory },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const collect = (chunk: Buffer) => { apiOutput = (apiOutput + chunk.toString()).slice(-16_384); };
  child.stdout?.on('data', collect);
  child.stderr?.on('data', collect);
  // A worker that dies must not leave the API process bound to its port.
  process.on('exit', () => child.kill('SIGKILL'));
  const exited = new Promise<void>(resolve => child.once('exit', () => resolve()));
  const origin = `http://127.0.0.1:${port}`;
  for (let attempt = 0; ; attempt++) {
    if (child.exitCode !== null) throw new Error(`API exited during startup:\n${apiOutput}`);
    try { if ((await fetch(`${origin}/api/health`)).ok) break; } catch { /* not listening yet */ }
    if (attempt === 200) {
      child.kill('SIGKILL');
      throw new Error(`API did not become healthy:\n${apiOutput}`);
    }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  return { port, origin, stop: async () => { child.kill('SIGTERM'); await exited; } };
}

type Slug = 'cmdb' | 'automation' | 'monitoring';
const world: {
  temp: string; dataDirectory: string; repositories: Record<Slug, string>;
  notARepository: string; symlinkAlias: string; api?: ApiProcess;
} = { temp: '', dataDirectory: '', repositories: { cmdb: '', automation: '', monitoring: '' }, notARepository: '', symlinkAlias: '' };

test.beforeAll(async () => {
  // macOS places its temp directory below the /var symlink, which the path guards reject.
  world.temp = mkdtempSync(join(realpathSync(tmpdir()), 'wb-e2e-real-'));
  world.dataDirectory = join(world.temp, 'data');
  mkdirSync(join(world.temp, 'repositories'));
  createRepository(world.repositories.cmdb = join(world.temp, 'repositories', 'cmdb'), 'clean');
  createRepository(world.repositories.automation = join(world.temp, 'repositories', 'automation'), 'dirty');
  createRepository(world.repositories.monitoring = join(world.temp, 'repositories', 'monitoring'), 'unborn');
  mkdirSync(world.notARepository = join(world.temp, 'not-a-repository'));
  symlinkSync(world.repositories.cmdb, world.symlinkAlias = join(world.temp, 'cmdb-alias'));
  world.api = await startApi(dirname(test.info().config.configFile!), world.dataDirectory);
});

test.afterAll(async () => {
  await world.api?.stop();
  world.api = undefined;
  if (world.temp) rmSync(world.temp, { recursive: true, force: true });
});

test.afterEach(async ({}, testInfo) => {
  if (testInfo.status !== testInfo.expectedStatus) {
    await testInfo.attach('api-output', { body: apiOutput, contentType: 'text/plain' });
  }
});

const row = (page: Page, name: string) =>
  page.getByRole('row').filter({ has: page.getByRole('cell', { name, exact: true }) });
const registeredRows = (page: Page) => page.getByRole('row').filter({ has: page.getByRole('button', { name: '取消登记' }) });
const listedSlugs = async (page: Page) => {
  const response = await page.request.get(`${world.api!.origin}/api/projects`);
  expect(response.status()).toBe(200);
  return ((await response.json()).projects as { slug: string }[]).map(project => project.slug);
};

async function openProjects(page: Page) {
  const api = world.api!;
  // Only API calls, not the page's own /src/api/client.ts module. Same protocol, different port: the page still treats
  // the answers as its own origin.
  await page.route(url => url.pathname.startsWith('/api/'), route => {
    const target = new URL(route.request().url());
    target.port = String(api.port);
    return route.continue({ url: target.href });
  });
  await page.goto('/projects');
  await expect(page.getByText('API 已连接')).toBeVisible();
}

async function register(page: Page, path: string, slug: string, name: string) {
  await page.getByRole('textbox', { name: '仓库绝对路径' }).fill(path);
  await page.getByRole('textbox', { name: '项目标识' }).fill(slug);
  await page.getByRole('textbox', { name: '项目名称' }).fill(name);
  await page.getByRole('button', { name: '登记仓库' }).click();
}

test('three real repositories can be registered and the page shows what Git reports', async ({ page }) => {
  await openProjects(page);
  await expect(page.getByText('尚未登记项目')).toBeVisible();
  const { cmdb, automation, monitoring } = world.repositories;
  await register(page, cmdb, 'cmdb', 'CMDB');
  await expect(row(page, 'CMDB')).toBeVisible();
  await register(page, automation, 'automation', 'AUTOMATION');
  await register(page, monitoring, 'monitoring', 'MONITORING');
  await expect(registeredRows(page)).toHaveCount(3);

  // Compared with Git itself, not with the API's own answer.
  await expect(row(page, 'CMDB').getByText('工作区干净')).toBeVisible();
  await expect(row(page, 'AUTOMATION').getByText('有未提交修改')).toBeVisible();
  await expect(row(page, 'MONITORING').getByText('尚无提交')).toBeVisible();
  await expect(row(page, 'MONITORING').getByText('有未提交修改')).toBeVisible();
  await expect(row(page, 'CMDB').getByText(git(cmdb, 'rev-parse', 'HEAD').slice(0, 12))).toBeVisible();
  await expect(row(page, 'AUTOMATION').getByText(git(automation, 'rev-parse', 'HEAD').slice(0, 12))).toBeVisible();
  // Each row shows the branch Git is on now, which is not the stored default branch and not always "main".
  for (const [name, branch] of [['CMDB', 'main'], ['AUTOMATION', 'feature/automation'], ['MONITORING', 'main']] as const) {
    expect(git(world.repositories[name.toLowerCase() as Slug], 'symbolic-ref', '--short', 'HEAD')).toBe(branch);
    await expect(row(page, name).getByText(branch, { exact: true }).last()).toBeVisible();
  }
  expect(await row(page, 'MONITORING').innerText()).toContain(monitoring);
  expect(await listedSlugs(page)).toEqual(['cmdb', 'automation', 'monitoring']);
});

test('invalid, duplicate and symlinked registrations are rejected with a reason and add nothing', async ({ page }) => {
  await openProjects(page);
  await expect(registeredRows(page)).toHaveCount(3);
  const rejected = async (path: string, slug: string, reason: string) => {
    await register(page, path, slug, 'Must be rejected');
    await expect(page.getByRole('alert').filter({ hasText: '登记失败' })).toContainText(reason);
    await expect(row(page, 'Must be rejected')).toHaveCount(0);
    await expect(registeredRows(page)).toHaveCount(3);
  };
  await rejected(world.notARepository, 'plain-folder', '仓库路径或登记信息无效');
  await rejected(world.symlinkAlias, 'cmdb-alias', '仓库路径或登记信息无效');
  await rejected(world.repositories.automation, 'automation-again', '项目或仓库已登记');

  // A relative path never leaves the browser: the form itself refuses it.
  await register(page, 'relative/repo', 'relative', 'Must be rejected');
  await expect(page.getByText('必须使用绝对路径')).toBeVisible();
  await expect(registeredRows(page)).toHaveCount(3);
  // The refusal never echoes the local path it was given.
  await expect(page.getByRole('alert').filter({ hasText: '登记失败' })).not.toContainText(world.temp);
  expect(await listedSlugs(page)).toEqual(['cmdb', 'automation', 'monitoring']);
});

test('unregistering a repository keeps its files and the other registrations', async ({ page }) => {
  await openProjects(page);
  const automation = row(page, 'AUTOMATION');
  await expect(automation.getByText('有未提交修改')).toBeVisible();
  await expect(row(page, 'CMDB').getByText('工作区干净')).toBeVisible();
  // Git may refresh its index while a status is read, so the baseline is taken afterwards.
  const before = snapshot(world.repositories.automation);
  const changesBefore = changes(world.repositories.automation);
  expect(changesBefore.split('\n')).toEqual([' M README.md', 'A  staged.txt', '?? untracked.txt']);

  await automation.getByRole('button', { name: '取消登记' }).click();
  await page.locator('.ant-popconfirm').filter({ visible: true }).locator('.ant-popconfirm-buttons button').last().click();
  await expect(automation).toHaveCount(0);
  await expect(row(page, 'CMDB').getByText('工作区干净')).toBeVisible();
  await expect(row(page, 'MONITORING').getByText('尚无提交')).toBeVisible();
  await expect(page.getByRole('alert')).toHaveCount(0);
  expect(await listedSlugs(page)).toEqual(['cmdb', 'monitoring']);

  expect(Object.keys(snapshot(world.repositories.automation))).toEqual(Object.keys(before));
  expect(snapshot(world.repositories.automation)).toEqual(before);
  expect(changes(world.repositories.automation)).toBe(changesBefore);
  expect(readFileSync(join(world.repositories.automation, 'untracked.txt'), 'utf8')).toBe('untracked, must survive\n');
});

test('registrations survive an API restart and the unregistered files are still there', async ({ page }) => {
  await world.api!.stop();
  world.api = await startApi(dirname(test.info().config.configFile!), world.dataDirectory);
  await openProjects(page);
  await expect(row(page, 'CMDB').getByText('工作区干净')).toBeVisible();
  await expect(row(page, 'MONITORING').getByText('尚无提交')).toBeVisible();
  await expect(row(page, 'AUTOMATION')).toHaveCount(0);
  expect(await listedSlugs(page)).toEqual(['cmdb', 'monitoring']);
  expect(existsSync(join(world.repositories.automation, '.git'))).toBe(true);
});

test('a project can be renamed and the new name survives a restart without touching the repository', async ({ page }) => {
  await openProjects(page);
  const cmdb = async () => {
    const response = await page.request.get(`${world.api!.origin}/api/projects`);
    const projects = (await response.json()).projects as { slug: string; name: string; revision: number }[];
    return projects.find(project => project.slug === 'cmdb');
  };
  await expect(row(page, 'CMDB').getByText('工作区干净')).toBeVisible();
  const headBefore = git(world.repositories.cmdb, 'rev-parse', 'HEAD');
  const changesBefore = changes(world.repositories.cmdb);
  expect((await cmdb())?.revision).toBe(1);

  await row(page, 'CMDB').getByRole('button', { name: '重命名' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('textbox', { name: '项目名称' }).fill('CMDB Core');
  await dialog.getByRole('button', { name: '保存名称' }).click();
  await expect(dialog).toHaveCount(0);
  await expect(row(page, 'CMDB Core').getByText('工作区干净')).toBeVisible();
  await expect(row(page, 'CMDB')).toHaveCount(0);
  await expect(row(page, 'MONITORING').getByText('尚无提交')).toBeVisible();
  await expect(page.getByRole('alert')).toHaveCount(0);
  expect(await cmdb()).toMatchObject({ name: 'CMDB Core', revision: 2 });
  // A rename is a catalog change only: same commit, same working tree, same files.
  expect(git(world.repositories.cmdb, 'rev-parse', 'HEAD')).toBe(headBefore);
  expect(changes(world.repositories.cmdb)).toBe(changesBefore);

  await world.api!.stop();
  world.api = await startApi(dirname(test.info().config.configFile!), world.dataDirectory);
  await openProjects(page);
  await expect(row(page, 'CMDB Core').getByText('工作区干净')).toBeVisible();
  expect(await cmdb()).toMatchObject({ name: 'CMDB Core', revision: 2 });
  expect(await listedSlugs(page)).toEqual(['cmdb', 'monitoring']);
});

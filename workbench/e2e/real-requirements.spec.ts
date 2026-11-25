import { spawn, type ChildProcess } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';

/**
 * The requirement flow against the real API and the real SQLite database: create, two revisions, status
 * transitions and a restore, with the page as the only interface. Nothing under /api is mocked.
 */
test.describe.configure({ mode: 'serial', timeout: 120_000 });

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
  process.on('exit', () => child.kill('SIGKILL'));
  const exited = new Promise<void>(resolve => child.once('exit', () => resolve()));
  const origin = `http://127.0.0.1:${port}`;
  for (let attempt = 0; ; attempt++) {
    if (child.exitCode !== null) throw new Error(`API exited during startup:\n${apiOutput}`);
    try { if ((await fetch(`${origin}/api/health`)).ok) break; } catch { /* not listening yet */ }
    if (attempt === 200) { child.kill('SIGKILL'); throw new Error(`API did not become healthy:\n${apiOutput}`); }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  return { port, origin, stop: async () => { child.kill('SIGTERM'); await exited; } };
}

let world: { temp: string; dataDirectory: string; api: ApiProcess };

test.beforeAll(async () => {
  world = { temp: '', dataDirectory: '', api: undefined as unknown as ApiProcess };
  world.temp = mkdtempSync(join(realpathSync(tmpdir()), 'wb-e2e-req-'));
  world.dataDirectory = join(world.temp, 'data');
  mkdirSync(world.dataDirectory, { recursive: true });
  world.api = await startApi(dirname(test.info().config.configFile!), world.dataDirectory);
});

test.afterAll(async () => {
  await world.api?.stop();
  if (world.temp) rmSync(world.temp, { recursive: true, force: true });
});

test.afterEach(async ({}, testInfo) => {
  if (testInfo.status !== testInfo.expectedStatus) {
    await testInfo.attach('api-output', { body: apiOutput, contentType: 'text/plain' });
  }
});

async function openRequirements(page: Page) {
  const api = world.api;
  await page.route(url => url.pathname.startsWith('/api/'), route => {
    const target = new URL(route.request().url());
    target.port = String(api.port);
    return route.continue({ url: target.href });
  });
  await page.goto('/requirements');
  await expect(page.getByRole('heading', { name: '需求中心' })).toBeVisible();
}

const rowOf = (page: Page, key: string) =>
  page.getByRole('row').filter({ has: page.getByRole('cell', { name: key, exact: true }) });
// Modals stack: the detail opens a form or the history above itself. The top one is the last in the DOM.
const top = (page: Page) => page.getByRole('dialog').last();
const openDialogs = (page: Page) => page.getByRole('dialog');

async function fillRevision(page: Page, title: string, summary: string) {
  // "保存修订" opens the form in the detail and submits it once the fields are filled.
  await top(page).getByRole('button', { name: '保存修订' }).click();
  const form = top(page);
  await form.getByRole('textbox', { name: '标题' }).fill(title);
  await form.getByRole('textbox', { name: '操作人' }).fill('张三');
  await form.getByRole('textbox', { name: '变更摘要' }).fill(summary);
  await form.getByRole('button', { name: '保存修订' }).click();
}

test('a requirement is created and revised through the page, and its history is queryable', async ({ page }) => {
  await openRequirements(page);
  await expect(page.getByText('尚无真实记录')).toBeVisible();

  await page.getByRole('button', { name: '新建需求' }).click();
  const create = top(page);
  await create.getByRole('textbox', { name: '业务编号' }).fill('REQ-001');
  await create.getByRole('textbox', { name: '标题' }).fill('需求中心 UI');
  await create.getByRole('textbox', { name: '背景' }).fill('只有 API');
  await create.getByRole('textbox', { name: '目标' }).fill('页面可用');
  await create.getByRole('textbox', { name: '操作人' }).fill('张三');
  await create.getByRole('textbox', { name: '变更摘要' }).fill('初稿');
  await create.getByRole('button', { name: '添加验收条目' }).click();
  await create.getByRole('textbox', { name: '验收条目 1 编号' }).fill('AC-1');
  await create.getByRole('textbox', { name: '验收条目 1 内容' }).fill('页面可用');
  await create.getByRole('button', { name: '保存需求' }).click();
  await expect(openDialogs(page)).toHaveCount(0);
  await expect(rowOf(page, 'REQ-001')).toBeVisible();
  await expect(rowOf(page, 'REQ-001').getByText('V1')).toBeVisible();

  // Two revisions: each is a new immutable version and the row follows.
  await rowOf(page, 'REQ-001').getByRole('button', { name: '详情' }).click();
  await fillRevision(page, '需求中心 UI v2', '第二次修订');
  await expect(top(page).getByText('当前版本 V2 · 修订号 2')).toBeVisible();
  await fillRevision(page, '需求中心 UI v3', '第三次修订');
  await expect(top(page).getByText('当前版本 V3 · 修订号 3')).toBeVisible();

  // The history shows all three snapshots, each with its own content hash, and one is readable.
  await top(page).getByRole('button', { name: '版本历史' }).click();
  const history = top(page);
  // The versions are in their table; the two lists above it name versions too.
  const table = history.getByRole('table', { name: '版本历史' });
  for (const cell of ['V1', 'V2', 'V3']) await expect(table.getByRole('cell', { name: cell, exact: true })).toBeVisible();
  await expect(table.getByText('初稿')).toBeVisible();
  await expect(table.getByText('第三次修订')).toBeVisible();
  const hashes = await history.locator('td').filter({ hasText: /^[0-9a-f]{12}$/ }).allInnerTexts();
  expect(new Set(hashes.map(hash => hash.trim())).size).toBe(3);
  await history.getByRole('button', { name: '查看 V1' }).click();
  await expect(history.getByText('V1（只读快照）')).toBeVisible();
  await expect(history.getByText('需求中心 UI', { exact: true })).toBeVisible();
});

test('the status chain works on the real API and restoring an old version never rewrites history', async ({ page }) => {
  await openRequirements(page);
  await rowOf(page, 'REQ-001').getByRole('button', { name: '详情' }).click();
  const detail = top(page);
  await detail.getByRole('textbox', { name: '操作人' }).fill('张三');
  await detail.getByRole('button', { name: '标记为已评审' }).click();
  await page.locator('.ant-popconfirm').filter({ visible: true }).locator('.ant-popconfirm-buttons button').last().click();
  await expect(detail.getByText('已评审')).toBeVisible();
  await detail.getByRole('button', { name: '标记为已批准' }).click();
  await page.locator('.ant-popconfirm').filter({ visible: true }).locator('.ant-popconfirm-buttons button').last().click();
  await expect(detail.getByText('已批准')).toBeVisible();
  await detail.getByRole('button', { name: '版本历史' }).click();

  // The hashes before the restore; history must come out of it unchanged.
  const history = top(page);
  const before = (await history.locator('td').filter({ hasText: /^[0-9a-f]{12}$/ }).allInnerTexts()).map(hash => hash.trim());
  expect(new Set(before).size).toBe(3);
  const storedBefore = (await (await page.request.get(`${world.api.origin}/api/requirements`)).json())
    .requirements as { id: string }[];
  const beforeFull = ((await (await page.request.get(
    `${world.api.origin}/api/requirements/${storedBefore[0].id}/versions`)).json())
    .versions as { version: number; content_sha256: string }[])
    .sort((a, b) => a.version - b.version).map(entry => entry.content_sha256);
  await history.getByRole('button', { name: '恢复为新草稿' }).first().click();
  await page.locator('.ant-popconfirm').filter({ visible: true }).locator('.ant-popconfirm-buttons button').last().click();
  await expect(openDialogs(page)).toHaveCount(1);

  // The restore is a new version of its own; V1..V3 stay exactly as they were.
  await top(page).getByRole('button', { name: '版本历史' }).click();
  const after = top(page);
  await expect(after.getByRole('table', { name: '版本历史' }).getByRole('cell', { name: 'V4', exact: true })).toBeVisible();
  const later = (await after.locator('td').filter({ hasText: /^[0-9a-f]{12}$/ }).allInnerTexts()).map(hash => hash.trim());
  // Four rows, three distinct hashes: the restore is a copy of V1, so its content hash equals V1's. The hash
  // identifies content, not a version — and the three original snapshots keep theirs.
  expect(later).toHaveLength(4);
  expect(new Set(later).size).toBe(3);
  expect(before.every(hash => later.includes(hash))).toBe(true);

  // The same in storage: V1..V3 keep their hashes and V4 is byte-for-byte V1's content.
  const stored = (await (await page.request.get(`${world.api.origin}/api/requirements`)).json())
    .requirements as { id: string }[];
  const versions = (await (await page.request.get(
    `${world.api.origin}/api/requirements/${stored[0].id}/versions`)).json())
    .versions as { version: number; content_sha256: string }[];
  expect(versions.map(entry => entry.version).sort((a, b) => a - b)).toEqual([1, 2, 3, 4]);
  const hashOf = (version: number) => versions.find(entry => entry.version === version)!.content_sha256;
  expect(hashOf(4)).toBe(hashOf(1));
  expect([hashOf(1), hashOf(2), hashOf(3)]).toEqual(beforeFull);
  await after.getByRole('button', { name: '查看 V1' }).click();
  await expect(after.getByText('V1（只读快照）')).toBeVisible();
  await expect(after.getByText('需求中心 UI', { exact: true })).toBeVisible();
});

test('two versions are compared through the page and the view is the comparison that was stored', async ({ page }) => {
  await openRequirements(page);
  await rowOf(page, 'REQ-001').getByRole('button', { name: '版本历史' }).click();
  const history = top(page);
  await expect(history.getByRole('cell', { name: 'V4', exact: true })).toBeVisible();
  // The latest change is already chosen: V3 against V4, the restore of V1.
  const base = history.locator('.ant-select').filter({ has: page.getByRole('combobox', { name: '基准版本' }) })
    .locator('.ant-select-selection-item');
  await expect(base).toHaveText('V3');
  await history.getByRole('button', { name: '比较版本' }).click();
  const view = history.getByLabel('版本差分');
  await expect(view.getByLabel('差分版本')).toHaveText('V3 → V4');
  // Only the title went back to the first one.
  for (const tag of ['新增 0', '修改 1', '删除 0', '待审核 0', '未变化 6']) {
    await expect(view.getByText(tag, { exact: true })).toBeVisible();
  }
  await expect(view.getByLabel('修改 /title').getByLabel('差分值')).toHaveText(['需求中心 UI v3', '需求中心 UI']);

  // What the page shows is the comparison that was stored, down to its hash.
  const requirement = (await (await page.request.get(`${world.api.origin}/api/requirements`)).json()).requirements[0];
  const stored = async () => (await (await page.request.get(
    `${world.api.origin}/api/requirements/${requirement.id}/diffs`)).json()).diffs as {
      id: string; base_version: number; target_version: number; diff_sha256: string;
    }[];
  const [only] = await stored();
  expect([only.base_version, only.target_version]).toEqual([3, 4]);
  await expect(view.getByLabel('差分哈希')).toHaveText(only.diff_sha256.slice(0, 16));

  // The stored comparison is listed and opens from the list; that is not another comparison.
  await expect(history.getByRole('table', { name: '已保存的差分' }).getByText('V3 → V4')).toBeVisible();
  await history.getByRole('button', { name: '查看差分 V3 到 V4' }).click();
  await expect(view.getByLabel('差分版本')).toHaveText('V3 → V4');
  expect(await stored()).toHaveLength(1);
});

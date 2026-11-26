import { expect, test, type Page, type Route } from '@playwright/test';

const ID = '12345678-1234-4234-8234-123456789abc';
const DIFF_ID = '22345678-1234-4234-8234-123456789abc';
const content = (title: string) => ({
  title, background: '背景', goal: '目标', scope: '范围', risk: '风险',
  acceptanceCriteria: [{ id: 'AC-1', text: 'first' }], priority: 'high',
});
const version = (n: number) => ({
  id: `33333333-1234-4234-8234-1234567${String(n).padStart(5, '0')}`, requirement_id: ID, version: n,
  content: content(`V${n}`), content_sha256: String(n).repeat(64).slice(0, 64), actor: '张三', summary: `第 ${n} 版`,
  created_at: `2026-11-25T0${n}:00:00Z`,
});
const requirement = {
  id: ID, requirement_key: 'REQ-001', title: 'V3', status: 'draft', current_version: 3, revision: 3,
  created_at: '2026-11-25T01:00:00Z', updated_at: '2026-11-25T03:00:00Z', content: content('V3'),
  content_sha256: '3'.repeat(64),
};
const comparison = (baseVersion: number, targetVersion: number, value = 'T') => ({
  id: DIFF_ID, requirement_id: ID, base_version: baseVersion, target_version: targetVersion,
  base_version_id: `33333333-1234-4234-8234-1234567${String(baseVersion).padStart(5, '0')}`,
  target_version_id: `33333333-1234-4234-8234-1234567${String(targetVersion).padStart(5, '0')}`,
  base_sha256: 'a'.repeat(64), target_sha256: 'b'.repeat(64), diff_sha256: 'c'.repeat(64),
  created_at: '2026-11-25T10:00:00Z',
  summary: { added: 1, modified: 1, deleted: 1, needs_review: 1, unchanged: 1 },
  diff: {
    schema: 1, base_sha256: 'a'.repeat(64), target_sha256: 'b'.repeat(64),
    summary: { added: 1, modified: 1, deleted: 1, needs_review: 1, unchanged: 1 },
    changes: [
      { op: 'added', pointer: '/title', value },
      { op: 'modified', pointer: '/goal', old_value: '旧目标', new_value: '新目标' },
      { op: 'deleted', pointer: '/risk', old_value: '删掉的风险' },
      { op: 'needs_review', pointer: '/acceptanceCriteria[id=AC-9]', reason: 'possible_rename',
        old_value: { id: 'AC-1', text: 'same' }, new_value: { id: 'AC-9', text: 'same' }, related: ['/acceptanceCriteria[id=AC-1]'] },
    ],
    unchanged: ['/background'],
  },
});

/** What the page may ask for, with a record of what it asked. */
function mockApi(options: { versions?: number; refuseFirst?: boolean; value?: string; seed?: [number, number] } = {}) {
  const state = {
    posts: [] as unknown[], gets: [] as string[],
    stored: (options.seed ? [comparison(...options.seed)] : []) as ReturnType<typeof comparison>[],
  };
  const route = async (request: Route) => {
    const url = new URL(request.request().url());
    const path = url.pathname;
    const method = request.request().method();
    const json = (body: unknown, status = 200) =>
      request.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
    if (path === '/api/requirements' && method === 'GET') return json({ requirements: [requirement] });
    if (path === `/api/requirements/${ID}/versions`) {
      return json({ versions: Array.from({ length: options.versions ?? 3 }, (_, index) => version(index + 1)) });
    }
    if (path === `/api/requirements/${ID}/diffs` && method === 'POST') {
      const body = request.request().postDataJSON() as { baseVersion: number; targetVersion: number };
      state.posts.push(body);
      if (options.refuseFirst && state.posts.length === 1) return json({ error: 'Requirement not found' }, 404);
      const record = comparison(body.baseVersion, body.targetVersion, options.value);
      state.stored = [record];
      return json(record, 201);
    }
    if (path === `/api/requirements/${ID}/diffs` && method === 'GET') {
      state.gets.push('list');
      return json({ diffs: state.stored.map(({ diff: _diff, ...record }) => record) });
    }
    if (path === `/api/requirements/${ID}/diffs/${DIFF_ID}`) {
      state.gets.push('one');
      return json(state.stored[0] ?? comparison(2, 3));
    }
    return json({ error: 'not found' }, 404);
  };
  return { state, route };
}

async function openHistory(page: Page, options: Parameters<typeof mockApi>[0] = {}) {
  const api = mockApi(options);
  await page.route(url => url.pathname.startsWith('/api/requirements'), api.route);
  await page.goto('/requirements');
  await page.getByRole('button', { name: '刷新' }).click();
  await page.getByRole('row').filter({ has: page.getByRole('cell', { name: 'REQ-001', exact: true }) })
    .getByRole('button', { name: '版本历史' }).click();
  const dialog = page.getByRole('dialog').last();
  const versions = options.versions ?? 3;
  await expect(dialog.getByRole('cell', { name: `V${versions}`, exact: true })).toBeVisible();
  return { api, dialog };
}

const selectOf = (page: Page, dialog: ReturnType<Page['getByRole']>, name: string) =>
  dialog.locator('.ant-select').filter({ has: page.getByRole('combobox', { name }) });
const selectionOf = (page: Page, dialog: ReturnType<Page['getByRole']>, name: string) =>
  selectOf(page, dialog, name).locator('.ant-select-selection-item');
/**
 * Choosing another version in one of the two lists. The option is taken from the list that belongs to this select,
 * because a list that has just closed can still be on the page while it fades out.
 */
async function choose(page: Page, dialog: ReturnType<Page['getByRole']>, name: string, option: string) {
  const select = selectOf(page, dialog, name);
  await select.click();
  const list = await select.getByRole('combobox').getAttribute('aria-controls');
  // The option a person clicks, not the hidden one the list keeps for assistive technology.
  await page.locator('.ant-select-dropdown').filter({ has: page.locator(`[id="${list}"]`) })
    .locator('.ant-select-item-option', { hasText: new RegExp(`^${option}$`) }).click();
}

test('two versions are selected, compared, and every kind of change is shown with its values', async ({ page }) => {
  const { api, dialog } = await openHistory(page);
  // The usual comparison is already chosen: the version before the current one against the current one.
  await expect(selectionOf(page, dialog, '基准版本')).toHaveText('V2');
  await expect(selectionOf(page, dialog, '目标版本')).toHaveText('V3');
  await dialog.getByRole('button', { name: '比较版本' }).click();

  const view = dialog.getByLabel('版本差分');
  await expect(view.getByLabel('差分版本')).toHaveText('V2 → V3');
  for (const tag of ['新增 1', '修改 1', '删除 1', '待审核 1', '未变化 1']) await expect(view.getByText(tag, { exact: true })).toBeVisible();
  await expect(api.state.posts).toEqual([{ baseVersion: 2, targetVersion: 3 }]);

  // Each kind of change says where it is and shows what was stored, both values of a modification included.
  await expect(view.getByLabel('新增 /title')).toContainText('标题');
  await expect(view.getByLabel('新增 /title')).toContainText('T');
  const modified = view.getByLabel('修改 /goal');
  await expect(modified).toContainText('目标');
  // The old value first, then the new one.
  await expect(modified.getByLabel('差分值')).toHaveText(['旧目标', '新目标']);
  await expect(view.getByLabel('删除 /risk')).toContainText('删掉的风险');
  const question = view.getByLabel('待审核 /acceptanceCriteria[id=AC-9]');
  await expect(question).toContainText('验收条目 AC-9');
  await expect(question).toContainText('可能只是改了编号');
  await expect(question).toContainText('"id": "AC-1"');
  await expect(question).toContainText('"id": "AC-9"');
  await expect(question).toContainText('验收条目 AC-1');
  // The hash of the stored comparison is shown with it.
  await expect(view.getByLabel('差分哈希')).toHaveText('c'.repeat(16));
});

test('what did not change is folded away until it is asked for', async ({ page }) => {
  const { dialog } = await openHistory(page);
  await dialog.getByRole('button', { name: '比较版本' }).click();
  const view = dialog.getByLabel('版本差分');
  await expect(view.getByRole('list', { name: '未变化' })).toHaveCount(0);
  await dialog.getByRole('button', { name: '显示未变化' }).click();
  await expect(view.getByRole('list', { name: '未变化' })).toContainText('背景');
  await dialog.getByRole('button', { name: '收起未变化' }).click();
  await expect(view.getByRole('list', { name: '未变化' })).toHaveCount(0);
});

test('a stored comparison is listed and reopened without comparing again', async ({ page }) => {
  const { api, dialog } = await openHistory(page, { seed: [1, 3] });
  const stored = dialog.getByRole('table', { name: '已保存的差分' });
  await expect(stored.getByText('V1 → V3')).toBeVisible();
  await expect(stored.getByText('新增 1 · 修改 1 · 删除 1 · 待审核 1')).toBeVisible();
  await dialog.getByRole('button', { name: '查看差分 V1 到 V3' }).click();
  const view = dialog.getByLabel('版本差分');
  await expect(view.getByLabel('差分版本')).toHaveText('V1 → V3');
  expect(api.state.posts).toHaveLength(0);
  expect(api.state.gets).toEqual(['list', 'one']);
});

test('a comparison just made is in the list of stored comparisons', async ({ page }) => {
  const { dialog } = await openHistory(page);
  await expect(dialog.getByText('已保存的差分')).toHaveCount(0);
  await dialog.getByRole('button', { name: '比较版本' }).click();
  await expect(dialog.getByRole('table', { name: '已保存的差分' }).getByText('V2 → V3')).toBeVisible();
});

test('with one version there is nothing to compare', async ({ page }) => {
  const { api, dialog } = await openHistory(page, { versions: 1 });
  await expect(dialog.getByLabel('无法比较')).toHaveText('至少要有两个版本才能比较。');
  await expect(dialog.getByRole('combobox', { name: '基准版本' })).toBeDisabled();
  await expect(dialog.getByRole('button', { name: '比较版本' })).toBeDisabled();
  expect(api.state.posts).toHaveLength(0);
});

test('another version can be chosen, and the pair that is sent is the pair that was chosen', async ({ page }) => {
  const { api, dialog } = await openHistory(page);
  await choose(page, dialog, '基准版本', 'V1');
  await expect(selectionOf(page, dialog, '基准版本')).toHaveText('V1');
  // The same version twice is not a comparison.
  await choose(page, dialog, '目标版本', 'V1');
  await expect(dialog.getByRole('button', { name: '比较版本' })).toBeDisabled();
  await choose(page, dialog, '目标版本', 'V3');
  await dialog.getByRole('button', { name: '比较版本' }).click();
  await expect(dialog.getByLabel('版本差分').getByLabel('差分版本')).toHaveText('V1 → V3');
  expect(api.state.posts).toEqual([{ baseVersion: 1, targetVersion: 3 }]);
});

test('a refused comparison keeps the selection, says why, and can be retried', async ({ page }) => {
  const { api, dialog } = await openHistory(page, { refuseFirst: true });
  await dialog.getByRole('button', { name: '比较版本' }).click();
  await expect(dialog.getByRole('alert')).toContainText('需求或版本不存在');
  await expect(dialog.getByLabel('版本差分')).toHaveCount(0);
  await expect(selectionOf(page, dialog, '基准版本')).toHaveText('V2');
  await expect(dialog.getByRole('button', { name: '比较版本' })).toBeEnabled();
  await dialog.getByRole('button', { name: '比较版本' }).click();
  await expect(dialog.getByLabel('版本差分')).toBeVisible();
  expect(api.state.posts).toHaveLength(2);
});

test('markup inside a value is shown as text', async ({ page }) => {
  const attack = '<img src=x onerror="window.pwned=1"><script>alert(1)</script>';
  const { dialog } = await openHistory(page, { value: attack });
  await dialog.getByRole('button', { name: '比较版本' }).click();
  const added = dialog.getByLabel('版本差分').getByLabel('新增 /title');
  await expect(added.getByLabel('差分值')).toHaveText(attack);
  expect(await dialog.locator('img, script').count()).toBe(0);
  expect(await page.evaluate(() => (window as unknown as { pwned?: number }).pwned ?? 0)).toBe(0);
});

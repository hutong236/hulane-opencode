import { expect, test, type Page, type Route } from '@playwright/test';

const cmdb = {
  id: '12345678-1234-4234-8234-123456789abc',
  slug: 'cmdb', name: 'CMDB', repo_root: '/tmp/workbench-cmdb',
  default_branch: 'main', revision: 0,
  created_at: '2026-11-20T00:00:00Z', updated_at: '2026-11-20T00:00:00Z',
};
const monitoring = {
  ...cmdb, id: '12345678-1234-4234-8234-123456789abd',
  slug: 'monitoring', name: 'Monitoring', repo_root: '/tmp/workbench-monitoring',
};
type Rename = { name: string; revision: number };

/** Server state that changes only through PATCH; list and status answers never depend on request counts. */
async function mockProjectApi(page: Page) {
  // Copies: a save rewrites the record, and the fixtures must stay untouched for the next test in this worker.
  const api = {
    registered: [structuredClone(cmdb), structuredClone(monitoring)],
    lists: 0,
    patches: [] as { path: string; body: Rename }[],
    onPatch: async (_route: Route, _body: Rename) => {},
    // What the real API does: rename when the revision is still current, refuse it otherwise.
    save: async (route: Route, body: Rename) => {
      const path = new URL(route.request().url()).pathname;
      const current = api.registered.find(project => `/api/projects/${project.id}` === path);
      if (!current) return route.fulfill({ status: 404, body: 'SECRET_/private/repo' });
      if (body.revision !== current.revision) return route.fulfill({ status: 409, body: 'SECRET_/private/repo' });
      current.name = body.name.trim();
      current.revision += 1;
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(current) });
    },
  };
  await page.route('**/api/projects', route => {
    api.lists++;
    return route.fulfill({ status: 200, contentType: 'application/json',
      body: JSON.stringify({ projects: api.registered }) });
  });
  await page.route('**/api/projects/*/status', route => route.fulfill({ status: 200, contentType: 'application/json',
    body: JSON.stringify({ repoRoot: cmdb.repo_root, headSha: 'a'.repeat(40), branch: 'main', dirty: false }) }));
  await page.route('**/api/projects/*', async route => {
    expect(route.request().method()).toBe('PATCH');
    const body = route.request().postDataJSON() as Rename;
    const path = new URL(route.request().url()).pathname;
    api.patches.push({ path, body });
    await api.onPatch(route, body);
  });
  api.onPatch = api.save;
  return api;
}

const row = (page: Page, name: string) =>
  page.getByRole('row').filter({ has: page.getByRole('cell', { name, exact: true }) });
const dialog = (page: Page) => page.getByRole('dialog');
const saveButton = (page: Page) => dialog(page).getByRole('button', { name: '保存名称' });
const discardButton = (page: Page) => dialog(page).getByRole('button', { name: '放弃修改' });
const nameInput = (page: Page) => dialog(page).getByRole('textbox', { name: '项目名称' });

test('renaming states its scope, starts from the current name and cancelling sends nothing', async ({ page }) => {
  const api = await mockProjectApi(page);
  await page.goto('/projects');
  await row(page, 'CMDB').getByRole('button', { name: '重命名' }).click();
  await expect(dialog(page)).toContainText('重命名「CMDB」');
  await expect(dialog(page)).toContainText('只修改工作台里显示的名称，不会改动仓库目录、Git 分支或任何文件。');
  await expect(nameInput(page)).toHaveValue('CMDB');
  expect(api.patches).toEqual([]);

  await nameInput(page).fill('Not saved');
  await discardButton(page).click();
  await expect(dialog(page)).toHaveCount(0);
  await expect(row(page, 'CMDB')).toBeVisible();
  await expect(row(page, 'Monitoring')).toBeVisible();
  expect(api.patches).toEqual([]);
});

test('saving sends one PATCH with the loaded revision and the list is re-read', async ({ page }) => {
  const api = await mockProjectApi(page);
  await page.goto('/projects');
  await expect(row(page, 'Monitoring')).toBeVisible();
  const listsBefore = api.lists;
  await row(page, 'CMDB').getByRole('button', { name: '重命名' }).click();
  await nameInput(page).fill('CMDB v2');
  await saveButton(page).click();
  await expect(dialog(page)).toHaveCount(0);
  await expect(row(page, 'CMDB v2')).toBeVisible();
  await expect(row(page, 'CMDB')).toHaveCount(0);
  await expect(row(page, 'Monitoring')).toBeVisible();
  await expect(page.getByRole('alert')).toHaveCount(0);
  expect(api.patches).toEqual([{ path: `/api/projects/${cmdb.id}`, body: { name: 'CMDB v2', revision: 0 } }]);
  // The new name comes from the API, not from patching the row in the browser.
  expect(api.lists).toBeGreaterThan(listsBefore);
});

test('an empty name is refused by the form without a request', async ({ page }) => {
  const api = await mockProjectApi(page);
  await page.goto('/projects');
  await row(page, 'CMDB').getByRole('button', { name: '重命名' }).click();
  await nameInput(page).fill('   ');
  await saveButton(page).click();
  await expect(dialog(page).getByText('请输入项目名称')).toBeVisible();
  await expect(dialog(page)).toBeVisible();
  expect(api.patches).toEqual([]);
});

test('a pending rename cannot be saved twice or dismissed', async ({ page }) => {
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const api = await mockProjectApi(page);
  api.onPatch = async (route, body) => { await held; await api.save(route, body); };
  await page.goto('/projects');
  await row(page, 'CMDB').getByRole('button', { name: '重命名' }).click();
  await nameInput(page).fill('CMDB v2');
  await saveButton(page).click();
  await expect.poll(() => api.patches.length).toBe(1);
  await expect(saveButton(page)).toHaveClass(/ant-btn-loading/);
  await expect(discardButton(page)).toBeDisabled();
  await expect(nameInput(page)).toBeDisabled();
  await expect(row(page, 'Monitoring').getByRole('button', { name: '重命名' })).toBeDisabled();
  await expect(page.locator('.ant-card-extra button')).toBeDisabled();
  // A repeated click and Enter in the disabled field must not send anything while the first request is pending.
  await saveButton(page).click({ force: true });
  await nameInput(page).press('Enter', { force: true });
  expect(api.patches).toHaveLength(1);

  release();
  await expect(dialog(page)).toHaveCount(0);
  await expect(row(page, 'CMDB v2')).toBeVisible();
  await expect(row(page, 'Monitoring').getByRole('button', { name: '重命名' })).toBeEnabled();
  expect(api.patches).toHaveLength(1);
});

for (const failure of [
  { name: 'a stale revision', status: 409, message: '项目已被其他操作修改，请关闭后刷新列表再重试' },
  { name: 'HTTP 404', status: 404, message: '项目不存在' },
  { name: 'a lost connection', status: 0, message: '无法连接本地 API，请确认服务已启动' },
]) {
  test(`a failed rename (${failure.name}) keeps the dialog and the project, then an explicit retry works`, async ({ page }) => {
    const api = await mockProjectApi(page);
    api.onPatch = async route => {
      if (failure.status === 0) return route.abort('failed');
      return route.fulfill({ status: failure.status, body: 'SECRET_/private/repo' });
    };
    await page.goto('/projects');
    await expect(row(page, 'Monitoring')).toBeVisible();
    const listsBefore = api.lists;
    await row(page, 'CMDB').getByRole('button', { name: '重命名' }).click();
    await nameInput(page).fill('CMDB v2');
    await saveButton(page).click();
    const alert = dialog(page).getByRole('alert');
    await expect(alert).toContainText('重命名失败');
    await expect(alert).toContainText(failure.message);
    await expect(page.getByText('SECRET_/private/repo')).toHaveCount(0);
    // Nothing was saved: the row, the other project and the typed name are all still there.
    await expect(row(page, 'CMDB')).toBeVisible();
    await expect(row(page, 'Monitoring')).toBeVisible();
    await expect(nameInput(page)).toHaveValue('CMDB v2');
    expect(api.patches).toEqual([{ path: `/api/projects/${cmdb.id}`, body: { name: 'CMDB v2', revision: 0 } }]);
    // A failure never reloads the list, which would replace the revision the dialog is holding.
    expect(api.lists).toBe(listsBefore);

    api.onPatch = api.save;
    await saveButton(page).click();
    await expect(dialog(page)).toHaveCount(0);
    await expect(row(page, 'CMDB v2')).toBeVisible();
    expect(api.patches).toHaveLength(2);
  });
}

test('after a stale revision, refreshing the list makes the next save use the current revision', async ({ page }) => {
  const api = await mockProjectApi(page);
  await page.goto('/projects');
  await row(page, 'CMDB').getByRole('button', { name: '重命名' }).click();
  await nameInput(page).fill('CMDB v2');
  // Someone else renamed the project in the meantime; the server now sits at revision 1.
  api.registered[0] = { ...cmdb, name: 'CMDB v2', revision: 1 };
  await saveButton(page).click();
  await expect(dialog(page).getByRole('alert')).toContainText('项目已被其他操作修改');

  await discardButton(page).click();
  await page.locator('.ant-card-extra button').click();
  await expect(row(page, 'CMDB v2')).toBeVisible();
  await row(page, 'CMDB v2').getByRole('button', { name: '重命名' }).click();
  await expect(nameInput(page)).toHaveValue('CMDB v2');
  await nameInput(page).fill('CMDB v3');
  await saveButton(page).click();
  await expect(row(page, 'CMDB v3')).toBeVisible();
  expect(api.patches.map(patch => patch.body)).toEqual([
    { name: 'CMDB v2', revision: 0 }, { name: 'CMDB v3', revision: 1 },
  ]);
});

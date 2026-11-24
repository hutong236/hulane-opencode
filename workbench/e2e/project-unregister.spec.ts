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

/** Server state that only changes through DELETE; list and status answers never depend on request counts. */
async function mockProjectApi(page: Page) {
  const api = {
    registered: [cmdb, monitoring],
    lists: 0,
    deletes: [] as { path: string; body: string | null }[],
    onDelete: async (_route: Route, _id: string) => {},
    succeed: async (route: Route, id: string) => {
      await route.fulfill({ status: 204 });
      api.registered = api.registered.filter(project => project.id !== id);
    },
  };
  await page.route('**/api/projects', route => {
    api.lists++;
    return route.fulfill({ status: 200, contentType: 'application/json',
      body: JSON.stringify({ projects: api.registered }) });
  });
  await page.route('**/api/projects/*/status', route => {
    const id = new URL(route.request().url()).pathname.split('/')[3];
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(id === cmdb.id
      ? { repoRoot: cmdb.repo_root, headSha: 'a'.repeat(40), branch: 'main', dirty: false }
      : { repoRoot: monitoring.repo_root, headSha: 'b'.repeat(40), branch: 'feature/monitoring', dirty: true }) });
  });
  await page.route('**/api/projects/*', async route => {
    expect(route.request().method()).toBe('DELETE');
    const path = new URL(route.request().url()).pathname;
    api.deletes.push({ path, body: route.request().postData() });
    await api.onDelete(route, path.split('/')[3]);
  });
  api.onDelete = api.succeed;
  return api;
}

const row = (page: Page, name: string) =>
  page.getByRole('row').filter({ has: page.getByRole('cell', { name, exact: true }) });
const cmdbRow = (page: Page) => row(page, 'CMDB');
const monitoringRow = (page: Page) => row(page, 'Monitoring');
const unregisterAction = (page: Page, name: string) => row(page, name).getByRole('button', { name: '取消登记' });
const openConfirmation = (page: Page) => page.locator('.ant-popconfirm').filter({ visible: true });
const confirmButton = (page: Page) => openConfirmation(page).locator('.ant-popconfirm-buttons button').last();
const cmdbFailure = (page: Page) => page.getByRole('alert').filter({ hasText: '取消登记「CMDB」失败' });
const cmdbDelete = { path: `/api/projects/${cmdb.id}`, body: null };

test('unregister asks for confirmation that states local repository files are kept', async ({ page }) => {
  const api = await mockProjectApi(page);
  await page.goto('/projects');
  await expect(cmdbRow(page)).toBeVisible();
  await unregisterAction(page, 'CMDB').click();
  await expect(openConfirmation(page).getByText('确认取消登记「CMDB」？')).toBeVisible();
  await expect(openConfirmation(page).getByText('不会删除本地仓库文件、分支或未提交的修改。')).toBeVisible();
  await expect(openConfirmation(page).getByText(`仓库目录：${cmdb.repo_root}`)).toBeVisible();
  // Nothing is sent before the explicit second confirmation.
  expect(api.deletes).toEqual([]);

  await openConfirmation(page).getByRole('button', { name: '保留登记' }).click();
  await expect(openConfirmation(page)).toHaveCount(0);
  await expect(cmdbRow(page)).toBeVisible();
  await expect(monitoringRow(page)).toBeVisible();
  expect(api.deletes).toEqual([]);
});

test('an unbreakable repository path or project name cannot push the confirmation off-screen', async ({ page }) => {
  const api = await mockProjectApi(page);
  // No slash, space or hyphen: the browser has nowhere to wrap these without help.
  const name = 'M'.repeat(200);
  const repoRoot = `/${'a'.repeat(240)}`;
  api.registered = [{ ...monitoring, name, repo_root: repoRoot }];
  await page.goto('/projects');
  await unregisterAction(page, name).click();
  const confirmation = openConfirmation(page);
  await expect(confirmation.getByText(`确认取消登记「${name}」？`)).toBeVisible();
  await expect(confirmation.getByText(`仓库目录：${repoRoot}`)).toBeVisible();
  await expect(confirmation.getByText('不会删除本地仓库文件、分支或未提交的修改。')).toBeVisible();
  // Measure the settled confirmation, not a frame of its zoom-in animation.
  await confirmation.evaluate(element =>
    Promise.all(element.getAnimations({ subtree: true }).map(animation => animation.finished)));
  const viewport = page.viewportSize()!;
  // The popover frame may give up its own padding; its text and buttons may never leave the viewport.
  const regions = {
    title: confirmation.locator('.ant-popconfirm-title'),
    description: confirmation.locator('.ant-popconfirm-description'),
    buttons: confirmation.locator('.ant-popconfirm-buttons'),
  };
  for (const [label, region] of Object.entries(regions)) {
    const box = (await region.boundingBox())!;
    expect(box.x, `${label} left edge`).toBeGreaterThanOrEqual(0);
    expect(box.y, `${label} top edge`).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width, `${label} right edge`).toBeLessThanOrEqual(viewport.width + 1);
    expect(box.y + box.height, `${label} bottom edge`).toBeLessThanOrEqual(viewport.height);
  }
  expect((await confirmation.boundingBox())!.width).toBeLessThan(600);
  // Bounded is not enough: the text itself has to wrap inside the confirmation instead of overflowing it.
  const overflow = await confirmation.evaluate(element =>
    [...element.querySelectorAll<HTMLElement>('.ant-popconfirm-title > div, .ant-popconfirm-description > div')]
      .map(node => node.scrollWidth - node.clientWidth));
  expect(overflow).toEqual([0, 0]);
  expect(api.deletes).toEqual([]);
});

test('confirmed unregister sends one UUID DELETE, removes only that project and refreshes the list', async ({ page }) => {
  const api = await mockProjectApi(page);
  await page.goto('/projects');
  await expect(cmdbRow(page).getByText('aaaaaaaaaaaa')).toBeVisible();
  await expect(monitoringRow(page).getByText('bbbbbbbbbbbb')).toBeVisible();
  const listsBefore = api.lists;

  await unregisterAction(page, 'CMDB').click();
  await confirmButton(page).click();
  await expect(cmdbRow(page)).toHaveCount(0);
  await expect(monitoringRow(page)).toBeVisible();
  await expect(monitoringRow(page).getByText('bbbbbbbbbbbb')).toBeVisible();
  await expect(monitoringRow(page).getByText('feature/monitoring')).toBeVisible();
  await expect(monitoringRow(page).getByText('有未提交修改')).toBeVisible();
  await expect(page.getByRole('alert')).toHaveCount(0);
  expect(api.deletes).toEqual([cmdbDelete]);
  // The remaining list is re-read from the API instead of being patched in the browser.
  expect(api.lists).toBeGreaterThan(listsBefore);
});

test('a pending unregister stays on its confirmation and cannot be sent twice', async ({ page }) => {
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const api = await mockProjectApi(page);
  api.onDelete = async (route, id) => { await held; await api.succeed(route, id); };
  await page.goto('/projects');
  await expect(monitoringRow(page).getByText('bbbbbbbbbbbb')).toBeVisible();

  await unregisterAction(page, 'CMDB').click();
  await confirmButton(page).click();
  await expect.poll(() => api.deletes.length).toBe(1);
  await expect(confirmButton(page)).toHaveClass(/ant-btn-loading/);
  await expect(openConfirmation(page).getByRole('button', { name: '保留登记' })).toBeDisabled();
  await expect(unregisterAction(page, 'Monitoring')).toBeDisabled();
  await expect(page.locator('.ant-card-extra button')).toBeDisabled();
  // A repeated confirm and another project's action must not send anything while the first request is pending.
  await confirmButton(page).click({ force: true });
  await unregisterAction(page, 'Monitoring').click({ force: true });
  expect(api.deletes).toEqual([cmdbDelete]);
  await expect(monitoringRow(page).getByText('bbbbbbbbbbbb')).toBeVisible();
  await expect(monitoringRow(page).getByText('有未提交修改')).toBeVisible();

  release();
  await expect(cmdbRow(page)).toHaveCount(0);
  await expect(monitoringRow(page)).toBeVisible();
  await expect(unregisterAction(page, 'Monitoring')).toBeEnabled();
  expect(api.deletes).toEqual([cmdbDelete]);
});

for (const failure of [
  { name: 'HTTP 500', message: 'API 请求失败：HTTP 500', hidden: 'SECRET_/private/repo/cmdb',
    respond: (route: Route) => route.fulfill({ status: 500, body: 'SECRET_/private/repo/cmdb' }) },
  { name: 'HTTP 404', message: '项目不存在', hidden: 'SECRET_/private/repo/cmdb',
    respond: (route: Route) => route.fulfill({ status: 404, body: 'SECRET_/private/repo/cmdb' }) },
  { name: 'a lost connection', message: '无法连接本地 API，请确认服务已启动', hidden: 'ECONNRESET',
    respond: (route: Route) => route.abort('failed') },
]) {
  test(`failed unregister (${failure.name}) keeps the project with a safe error until retried`, async ({ page }) => {
    const api = await mockProjectApi(page);
    api.onDelete = async route => { await failure.respond(route); };
    await page.goto('/projects');
    await expect(monitoringRow(page).getByText('bbbbbbbbbbbb')).toBeVisible();
    const listsBefore = api.lists;

    await unregisterAction(page, 'CMDB').click();
    await confirmButton(page).click();
    await expect(cmdbFailure(page)).toContainText(failure.message);
    await expect(page.getByText(failure.hidden)).toHaveCount(0);
    // The project stays registered and can be retried; other projects are untouched.
    await expect(cmdbRow(page).getByText('aaaaaaaaaaaa')).toBeVisible();
    await expect(monitoringRow(page).getByText('bbbbbbbbbbbb')).toBeVisible();
    await expect(monitoringRow(page).getByText('有未提交修改')).toBeVisible();
    await expect(unregisterAction(page, 'CMDB')).toBeEnabled();
    await expect(unregisterAction(page, 'Monitoring')).toBeEnabled();
    await expect(openConfirmation(page)).toHaveCount(0);
    // A failure never reloads the list, which would hide what just happened.
    expect(api.deletes).toEqual([cmdbDelete]);
    expect(api.lists).toBe(listsBefore);

    // Only a new explicit confirmation retries, and then succeeds.
    api.onDelete = async (route, id) => { await api.succeed(route, id); };
    await unregisterAction(page, 'CMDB').click();
    await confirmButton(page).click();
    await expect(cmdbFailure(page)).toHaveCount(0);
    await expect(cmdbRow(page)).toHaveCount(0);
    await expect(monitoringRow(page)).toBeVisible();
    await expect(page.getByRole('alert')).toHaveCount(0);
    expect(api.deletes).toEqual([cmdbDelete, cmdbDelete]);
  });
}

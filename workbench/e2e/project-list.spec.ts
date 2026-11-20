import { expect, test } from '@playwright/test';

const project = {
  id: '12345678-1234-4234-8234-123456789abc',
  slug: 'cmdb', name: 'CMDB', repo_root: '/tmp/workbench-cmdb',
  default_branch: 'main', revision: 0,
  created_at: '2026-11-20T00:00:00Z', updated_at: '2026-11-20T00:00:00Z',
};

test('project list shows loading then registered project metadata', async ({ page }) => {
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  let requested!: () => void;
  const received = new Promise<void>(resolve => { requested = resolve; });
  await page.route('**/api/projects', async route => {
    requested();
    await held;
    await route.fulfill({ status: 200, contentType: 'application/json',
      body: JSON.stringify({ projects: [project] }) });
  });
  try {
    await page.goto('/projects');
    await received;
    await expect(page.getByLabel('项目列表加载中')).toBeVisible();
  } finally {
    release();
  }
  await expect(page.getByRole('cell', { name: 'CMDB', exact: true }).first()).toBeVisible();
  await expect(page.getByRole('cell', { name: '/tmp/workbench-cmdb', exact: true }).first()).toBeVisible();
  await expect(page.getByText('尚未登记项目')).toHaveCount(0);
});

test('empty project list is explicit and refresh loads a new registration', async ({ page }) => {
  let count = 0;
  await page.route('**/api/projects', route => {
    count++;
    return route.fulfill({ status: 200, contentType: 'application/json',
      body: JSON.stringify({ projects: count <= 2 ? [] : [project] }) });
  });
  await page.goto('/projects');
  await expect(page.getByText('尚未登记项目')).toBeVisible();
  await page.getByRole('button', { name: '刷新' }).click();
  await expect(page.getByRole('cell', { name: 'CMDB', exact: true }).first()).toBeVisible();
  expect(count).toBeGreaterThanOrEqual(3);
});

test('project list HTTP failure has a retry action and recovers', async ({ page }) => {
  let count = 0;
  await page.route('**/api/projects', route => {
    count++;
    return route.fulfill(count <= 2
      ? { status: 503, body: 'unavailable' }
      : { status: 200, contentType: 'application/json', body: '{"projects":[]}' });
  });
  await page.goto('/projects');
  await expect(page.getByText('项目列表加载失败')).toBeVisible();
  await expect(page.getByText('API 请求失败：HTTP 503')).toBeVisible();
  await page.getByRole('button', { name: '重试加载' }).click();
  await expect(page.getByText('尚未登记项目')).toBeVisible();
  await expect(page.getByText('项目列表加载失败')).toHaveCount(0);
  expect(count).toBeGreaterThanOrEqual(3);
});

test('navigating away during a pending request does not show stale project data', async ({ page }) => {
  let requested!: () => void;
  const received = new Promise<void>(resolve => { requested = resolve; });
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  await page.route('**/api/projects', async route => {
    requested();
    await held;
    try {
      await route.fulfill({ status: 200, contentType: 'application/json',
        body: JSON.stringify({ projects: [project] }) });
    } catch {
      // The browser may already have cancelled the request after unmount.
    }
  });
  try {
    await page.goto('/projects');
    await received;
    await page.getByRole('menuitem', { name: '需求中心' }).first().click();
    await expect(page).toHaveURL(/\/requirements$/);
  } finally {
    release();
  }
  await expect(page.getByRole('heading', { name: '需求中心' })).toBeVisible();
  await expect(page.getByRole('cell', { name: 'CMDB', exact: true }).first()).toHaveCount(0);
});

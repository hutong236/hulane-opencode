import { expect, test } from '@playwright/test';

const project = {
  id: '12345678-1234-4234-8234-123456789abc',
  slug: 'cmdb', name: 'CMDB', repo_root: '/tmp/workbench-cmdb',
  default_branch: 'main', remote_url: null, revision: 0,
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
  // The repository cell is named after both of its lines: the path and the remote, or the lack of one.
  await expect(page.getByRole('cell', { name: '仓库 /tmp/workbench-cmdb，远端 无', exact: true }).first()).toBeVisible();
  await expect(page.getByText('尚未登记项目')).toHaveCount(0);
});

test('empty project list is explicit and refresh loads a new registration', async ({ page }) => {
  let refreshed = false;
  let count = 0;
  await page.route('**/api/projects', route => {
    count++;
    return route.fulfill({ status: 200, contentType: 'application/json',
      body: JSON.stringify({ projects: refreshed ? [project] : [] }) });
  });
  await page.goto('/projects');
  await expect(page.getByText('尚未登记项目')).toBeVisible();
  // Target the Card's refresh action without depending on AntD's accessible-name
  // composition; StrictMode may make one or two initial requests.
  refreshed = true;
  await page.locator('.ant-card-extra button').click();
  await expect(page.getByRole('cell', { name: 'CMDB', exact: true }).first()).toBeVisible();
  expect(count).toBeGreaterThanOrEqual(2);
});

test('project list HTTP failure has a retry action and recovers', async ({ page }) => {
  // StrictMode may send one or two initial requests, so the outage ends when the test says so, not at a count.
  let failing = true;
  let count = 0;
  await page.route('**/api/projects', route => {
    count++;
    return route.fulfill(failing
      ? { status: 503, body: 'unavailable' }
      : { status: 200, contentType: 'application/json', body: '{"projects":[]}' });
  });
  await page.goto('/projects');
  await expect(page.getByText('项目列表加载失败')).toBeVisible();
  await expect(page.getByText('API 请求失败：HTTP 503')).toBeVisible();
  failing = false;
  await page.getByRole('button', { name: '重试加载' }).click();
  await expect(page.getByText('尚未登记项目')).toBeVisible();
  await expect(page.getByText('项目列表加载失败')).toHaveCount(0);
  expect(count).toBeGreaterThanOrEqual(2);
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

test('registered project shows live HEAD, branch and dirty status', async ({ page }) => {
  await page.route('**/api/projects', route => route.fulfill({ status: 200, contentType: 'application/json',
    body: JSON.stringify({ projects: [project] }) }));
  await page.route('**/api/projects/*/status', route => route.fulfill({ status: 200, contentType: 'application/json',
    body: JSON.stringify({ repoRoot: project.repo_root, headSha: 'a'.repeat(40), branch: 'feature/health', dirty: true }) }));
  await page.goto('/projects');
  await expect(page.getByText('aaaaaaaaaaaa')).toBeVisible();
  await expect(page.getByText('feature/health')).toBeVisible();
  await expect(page.getByText('有未提交修改')).toBeVisible();
});

test('stale Git repository reports a scoped error and can retry independently', async ({ page }) => {
  // StrictMode may send one or two initial requests, so the repository recovers when the test says so.
  let available = false;
  let attempts = 0;
  await page.route('**/api/projects', route => route.fulfill({ status: 200, contentType: 'application/json',
    body: JSON.stringify({ projects: [project] }) }));
  await page.route('**/api/projects/*/status', route => {
    attempts++;
    return route.fulfill(!available ? { status: 409, body: 'sensitive /private/path' }
      : { status: 200, contentType: 'application/json',
          body: JSON.stringify({ repoRoot: project.repo_root, headSha: null, branch: 'main', dirty: false }) });
  });
  await page.goto('/projects');
  await expect(page.getByText('已登记的 Git 仓库不可用')).toBeVisible();
  await expect(page.getByText('sensitive /private/path')).toHaveCount(0);
  const beforeRetry = attempts;
  available = true;
  await page.getByRole('button', { name: '重试状态' }).click();
  await expect(page.getByText('尚无提交')).toBeVisible();
  await expect(page.getByText('工作区干净')).toBeVisible();
  expect(attempts).toBeGreaterThan(beforeRetry);
});

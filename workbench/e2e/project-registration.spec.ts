import { expect, test } from '@playwright/test';

const registered = {
  id: '12345678-1234-4234-8234-123456789abc',
  slug: 'cmdb', name: 'CMDB', repo_root: '/tmp/workbench-cmdb',
  default_branch: 'main', revision: 0,
  created_at: '2026-11-20T00:00:00Z', updated_at: '2026-11-20T00:00:00Z',
};

test('registration POST uses local API and refreshes persisted project list', async ({ page }) => {
  let saved = false;
  const posts: unknown[] = [];
  await page.route('**/api/projects', async route => {
    if (route.request().method() === 'POST') {
      posts.push(route.request().postDataJSON());
      saved = true;
      await route.fulfill({ status: 201, contentType: 'application/json', body: JSON.stringify(registered) });
      return;
    }
    await route.fulfill({ status: 200, contentType: 'application/json',
      body: JSON.stringify({ projects: saved ? [registered] : [] }) });
  });
  await page.goto('/projects');
  await expect(page.getByText('尚未登记项目')).toBeVisible();
  await page.getByRole('textbox', { name: '仓库绝对路径' }).fill('/tmp/workbench-cmdb');
  await page.getByRole('textbox', { name: '项目标识' }).fill('cmdb');
  await page.getByRole('textbox', { name: '项目名称' }).fill('CMDB');
  await page.getByRole('button', { name: '登记仓库' }).click();
  await expect(page.getByRole('cell', { name: 'CMDB', exact: true })).toBeVisible();
  expect(posts).toEqual([{ path: '/tmp/workbench-cmdb', slug: 'cmdb', name: 'CMDB' }]);
  await expect(page.getByRole('textbox', { name: '项目标识' })).toBeEmpty();
});

test('duplicate registration is rejected without exposing untrusted server response', async ({ page }) => {
  let posts = 0;
  await page.route('**/api/projects', route => {
    if (route.request().method() === 'POST') {
      posts++;
      return route.fulfill({ status: 409, contentType: 'text/plain', body: 'SECRET_INTERNAL_PATH' });
    }
    return route.fulfill({ status: 200, contentType: 'application/json', body: '{"projects":[]}' });
  });
  await page.goto('/projects');
  await page.getByRole('textbox', { name: '仓库绝对路径' }).fill('/tmp/workbench-cmdb');
  await page.getByRole('textbox', { name: '项目标识' }).fill('cmdb');
  await page.getByRole('textbox', { name: '项目名称' }).fill('CMDB');
  await page.getByRole('button', { name: '登记仓库' }).click();
  await expect(page.getByText('项目或仓库已登记')).toBeVisible();
  await expect(page.getByText('SECRET_INTERNAL_PATH')).toHaveCount(0);
  expect(posts).toBe(1);
});

test('relative repository path fails form validation without POST', async ({ page }) => {
  let posts = 0;
  await page.route('**/api/projects', route => {
    if (route.request().method() === 'POST') posts++;
    return route.fulfill({ status: 200, contentType: 'application/json', body: '{"projects":[]}' });
  });
  await page.goto('/projects');
  await page.getByRole('textbox', { name: '仓库绝对路径' }).fill('relative/repo');
  await page.getByRole('textbox', { name: '项目标识' }).fill('cmdb');
  await page.getByRole('textbox', { name: '项目名称' }).fill('CMDB');
  await page.getByRole('button', { name: '登记仓库' }).click();
  await expect(page.getByText('必须使用绝对路径')).toBeVisible();
  expect(posts).toBe(0);
});

test('invalid Git root returns safe 400 feedback and allows a corrected retry', async ({ page }) => {
  const posts: unknown[] = [];
  await page.route('**/api/projects', route => {
    if (route.request().method() === 'POST') {
      const body = route.request().postDataJSON();
      posts.push(body);
      if (posts.length === 1) {
        return route.fulfill({ status: 400, contentType: 'text/plain',
          body: 'PRIVATE_SERVER_PATH=/home/secret/repository' });
      }
      return route.fulfill({ status: 201, contentType: 'application/json',
        body: JSON.stringify(registered) });
    }
    return route.fulfill({ status: 200, contentType: 'application/json',
      body: JSON.stringify({ projects: posts.length === 2 ? [registered] : [] }) });
  });
  await page.goto('/projects');
  await page.getByRole('textbox', { name: '仓库绝对路径' }).fill('/tmp/not-a-git-repository');
  await page.getByRole('textbox', { name: '项目标识' }).fill('cmdb');
  await page.getByRole('textbox', { name: '项目名称' }).fill('CMDB');
  await page.getByRole('button', { name: '登记仓库' }).click();
  await expect(page.getByText('仓库路径或登记信息无效')).toBeVisible();
  await expect(page.getByText(/PRIVATE_SERVER_PATH/)).toHaveCount(0);
  await page.getByRole('textbox', { name: '仓库绝对路径' }).fill('/tmp/workbench-cmdb');
  await page.getByRole('button', { name: '登记仓库' }).click();
  await expect(page.getByRole('cell', { name: 'CMDB', exact: true })).toBeVisible();
  expect(posts).toHaveLength(2);
});

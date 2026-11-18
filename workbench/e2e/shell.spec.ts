import { test, expect } from '@playwright/test';

test('navigation and deep links work for all six pages', async ({ page }) => {
  const sections = [
    ['/projects', '项目管理'], ['/requirements', '需求中心'], ['/workflows', '工作流中心'],
    ['/runs', '执行监控'], ['/integration', '集成测试'], ['/settings', '系统配置'],
  ] as const;
  await page.goto('/');
  await expect(page).toHaveURL(/\/projects$/);
  await expect(page.getByText('API 已连接')).toBeVisible();
  for (const [path, title] of sections) {
    await page.getByRole('menuitem', { name: title }).first().click();
    await expect(page).toHaveURL(new RegExp(`${path}$`));
    await expect(page.getByRole('heading', { name: title })).toBeVisible();
    await page.reload();
    await expect(page.getByRole('heading', { name: title })).toBeVisible();
  }
});

test('API 500 error is visible and retry recovers', async ({ page }) => {
  let fail = true;
  await page.route(/\/api\/health$/, async route => {
    if (fail) await route.fulfill({ status: 500, body: 'service failure' });
    else await route.continue();
  });
  await page.goto('/projects');
  await expect(page.getByText('API 连接失败')).toBeVisible();
  await expect(page.getByText('API 请求失败：HTTP 500')).toBeVisible();
  fail = false;
  await page.getByRole('button', { name: '重试连接' }).click();
  await expect(page.getByText('API 已连接')).toBeVisible();
});

test('mobile drawer navigates between routes', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/projects');
  await page.getByRole('button', { name: '打开导航' }).click();
  await page.getByRole('menuitem', { name: '执行监控' }).last().click();
  await expect(page).toHaveURL(/\/runs$/);
});

test('local dark theme persists on reload', async ({ page }) => {
  await page.goto('/settings');
  await page.getByRole('switch').click();
  await page.getByRole('button', { name: '保存设置' }).click();
  await expect(page.locator('.app-layout')).toHaveClass(/theme-dark/);
  await page.reload();
  await expect(page.locator('.app-layout')).toHaveClass(/theme-dark/);
});

test('resetting the browser theme requires confirmation', async ({ page }) => {
  await page.goto('/settings');
  await page.getByRole('switch').click();
  await page.getByRole('button', { name: '保存设置' }).click();
  await expect(page.locator('.app-layout')).toHaveClass(/theme-dark/);

  await page.getByRole('button', { name: '恢复默认' }).click();
  await expect(page.getByText('确认恢复默认外观？')).toBeVisible();
  await expect(page.locator('.ant-popconfirm-buttons button')).toHaveCount(2);
  await page.locator('.ant-popconfirm-buttons button').first().click();
  await expect(page.locator('.app-layout')).toHaveClass(/theme-dark/);

  await page.getByRole('button', { name: '恢复默认' }).click();
  await page.locator('.ant-popconfirm-buttons button').last().click();
  await expect(page.locator('.app-layout')).not.toHaveClass(/theme-dark/);
});

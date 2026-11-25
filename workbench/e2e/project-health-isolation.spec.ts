import { expect, test } from '@playwright/test';

const first = {
  id: '12345678-1234-4234-8234-123456789abc',
  slug: 'cmdb', name: 'CMDB', repo_root: '/tmp/workbench-cmdb',
  default_branch: 'main', remote_url: null, revision: 0,
  created_at: '2026-11-20T00:00:00Z', updated_at: '2026-11-20T00:00:00Z',
};
const second = {
  ...first, id: '12345678-1234-4234-8234-123456789abd',
  slug: 'monitoring', name: 'Monitoring', repo_root: '/tmp/workbench-monitoring',
};

test('Git health errors and retries are isolated to their registered project', async ({ page }) => {
  // StrictMode may deliver one or two initial requests per row, so answers follow this phase instead of a count.
  let firstAvailable = false;
  let firstAttempts = 0;
  let secondAttempts = 0;
  await page.route('**/api/projects', route => route.fulfill({
    status: 200, contentType: 'application/json',
    body: JSON.stringify({ projects: [first, second] }),
  }));
  await page.route('**/api/projects/*/status', route => {
    const id = new URL(route.request().url()).pathname.split('/')[3];
    if (id === first.id) {
      firstAttempts++;
      return route.fulfill(!firstAvailable
        ? { status: 404, body: 'sensitive /private/repo' }
        : { status: 200, contentType: 'application/json',
            body: JSON.stringify({ repoRoot: first.repo_root, headSha: null, branch: 'main', dirty: false }) });
    }
    secondAttempts++;
    return route.fulfill({ status: 200, contentType: 'application/json',
      body: JSON.stringify({ repoRoot: second.repo_root, headSha: 'b'.repeat(40),
        branch: 'feature/monitoring', dirty: true }) });
  });

  await page.goto('/projects');
  const cmdb = page.getByRole('row').filter({ has: page.getByRole('cell', { name: 'CMDB', exact: true }) });
  const monitoring = page.getByRole('row').filter({ has: page.getByRole('cell', { name: 'Monitoring', exact: true }) });
  await expect(cmdb.getByText('项目不存在')).toBeVisible();
  await expect(monitoring.getByText('bbbbbbbbbbbb')).toBeVisible();
  await expect(monitoring.getByText('有未提交修改')).toBeVisible();
  await expect(page.getByText('sensitive /private/repo')).toHaveCount(0);

  const beforeRetry = { first: firstAttempts, second: secondAttempts };
  firstAvailable = true;
  await cmdb.getByRole('button', { name: '重试状态' }).click();
  await expect(cmdb.getByText('尚无提交')).toBeVisible();
  await expect(cmdb.getByText('工作区干净')).toBeVisible();
  await expect(monitoring.getByText('bbbbbbbbbbbb')).toBeVisible();
  await expect(monitoring.getByText('有未提交修改')).toBeVisible();
  // Only the failed row is read again; the healthy one is left alone.
  expect(firstAttempts).toBeGreaterThan(beforeRetry.first);
  expect(secondAttempts).toBe(beforeRetry.second);
});

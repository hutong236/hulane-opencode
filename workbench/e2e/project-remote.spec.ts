import { expect, test, type Page } from '@playwright/test';

const remote = 'https://github.com/example/cmdb.git';
const cmdb = {
  id: '12345678-1234-4234-8234-123456789abc',
  slug: 'cmdb', name: 'CMDB', repo_root: '/tmp/workbench-cmdb',
  default_branch: 'develop', remote_url: remote, revision: 0,
  created_at: '2026-11-20T00:00:00Z', updated_at: '2026-11-20T00:00:00Z',
};
const monitoring = {
  ...cmdb, id: '12345678-1234-4234-8234-123456789abd',
  slug: 'monitoring', name: 'Monitoring', repo_root: '/tmp/workbench-monitoring',
  default_branch: 'main', remote_url: null,
};

async function mockProjects(page: Page, projects: unknown[]) {
  await page.route('**/api/projects', route => route.fulfill({ status: 200, contentType: 'application/json',
    body: JSON.stringify({ projects }) }));
  await page.route('**/api/projects/*/status', route => route.fulfill({ status: 200, contentType: 'application/json',
    body: JSON.stringify({ repoRoot: cmdb.repo_root, headSha: 'a'.repeat(40), branch: 'main', dirty: false }) }));
}
const row = (page: Page, name: string) =>
  page.getByRole('row').filter({ has: page.getByRole('cell', { name, exact: true }) });

test('each project shows its remote address and the default branch recorded for it, or that it has none', async ({ page }) => {
  await mockProjects(page, [cmdb, monitoring]);
  await page.goto('/projects');
  // The recorded default branch is metadata; the live branch is read separately, so both can appear.
  await expect(row(page, 'CMDB').getByRole('cell', { name: 'develop', exact: true })).toBeVisible();
  const repository = (name: string) => row(page, name).getByRole('cell', { name: /^仓库 / });
  await expect(repository('CMDB')).toHaveAccessibleName(`仓库 ${cmdb.repo_root}，远端 ${remote}`);
  await expect(repository('CMDB').getByText(cmdb.repo_root, { exact: true })).toBeVisible();
  await expect(repository('CMDB').getByText(`origin: ${remote}`, { exact: true })).toBeVisible();
  await expect(repository('Monitoring')).toHaveAccessibleName(`仓库 ${monitoring.repo_root}，远端 无`);
  await expect(repository('Monitoring').getByText('无远端', { exact: true })).toBeVisible();
  await expect(repository('Monitoring').getByText(remote, { exact: false })).toHaveCount(0);
});

test('credentials in a remote address are not shown', async ({ page }) => {
  await mockProjects(page, [{ ...cmdb, remote_url: 'https://x-access-token:ghp_SECRET@github.com/example/cmdb.git' }]);
  await page.goto('/projects');
  const shown = row(page, 'CMDB').getByRole('cell', { name: /^仓库 / });
  await expect(shown).toHaveAccessibleName(`仓库 ${cmdb.repo_root}，远端 ${remote}`);
  await expect(shown.getByText(`origin: ${remote}`, { exact: true })).toBeVisible();
  // Neither the visible text nor the cell's name for assistive technology carries the credentials.
  await expect(page.getByText(/ghp_SECRET|x-access-token/)).toHaveCount(0);
  expect((await shown.getAttribute('aria-label'))?.includes('ghp_SECRET')).toBe(false);
});

test('a list with a missing or invalid remote field is refused as a whole', async ({ page }) => {
  for (const invalid of ['missing', '', '   ', 7, false]) {
    const project: Record<string, unknown> = { ...cmdb };
    if (invalid === 'missing') delete project.remote_url; else project.remote_url = invalid;
    await page.unrouteAll({ behavior: 'wait' });
    await mockProjects(page, [project]);
    await page.goto('/projects');
    await expect(page.getByText('项目列表加载失败')).toBeVisible();
    await expect(page.getByText('API 返回的数据结构不正确')).toBeVisible();
    await expect(row(page, 'CMDB')).toHaveCount(0);
  }
});

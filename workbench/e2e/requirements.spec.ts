import { expect, test } from '@playwright/test';

const UUID = '12345678-1234-4234-8234-123456789abc';
const content = {
  title: 'CMDB 扩容', background: '背景内容', goal: '目标内容', scope: '范围内容', risk: '风险内容',
  acceptanceCriteria: [{ id: 'AC-1', text: '扩容到 10 倍' }], priority: 'high',
};
const version = (n: number, summary: string) => ({
  id: `22345678-1234-4234-8234-123456789ab${n}`, requirement_id: UUID, version: n,
  content, content_sha256: `${n}`.repeat(64), actor: '张三', summary, created_at: `2026-11-25T0${n}:00:00Z`,
});
const requirement = {
  id: UUID, requirement_key: 'REQ-001', title: content.title, status: 'draft',
  current_version: 1, revision: 1, created_at: '2026-11-25T00:00:00Z', updated_at: '2026-11-25T00:00:00Z',
  content, content_sha256: '1'.repeat(64),
};

/** The real API normalizes a missing optional field to an empty string; the mock must behave the same. */
const contentOf = (body: Record<string, unknown>) => ({
  title: String(body.title ?? ''), background: String(body.background ?? ''),
  goal: String(body.goal ?? ''), scope: String(body.scope ?? ''), risk: String(body.risk ?? ''),
  priority: String(body.priority ?? 'medium'),
  acceptanceCriteria: Array.isArray(body.acceptanceCriteria) ? body.acceptanceCriteria : [],
}) as never;

/** A small in-memory API: the page talks to it like to the real one, including the 409s. */
function mockApi(overrides: {
  transitions?: 'conflict-first' | 'ok';
} = {}) {
  const state = {
    rows: [] as typeof requirement[],
    versions: [version(1, '初稿')] as ReturnType<typeof version>[],
    posts: [] as { path: string; body: unknown }[],
    transitionCount: 0,
  };
  const route = async (route: import('@playwright/test').Route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;
    const json = (body: unknown, status = 200) =>
      route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
    if (path === '/api/requirements' && request.method() === 'GET') return json({ requirements: state.rows });
    if (path === '/api/requirements' && request.method() === 'POST') {
      const body = request.postDataJSON() as typeof content & { requirementKey: string; actor: string; summary: string };
      state.posts.push({ path, body });
      state.rows = [{ ...requirement, requirement_key: body.requirementKey, title: body.title,
        content: contentOf(body) }];
      return json(state.rows[0], 201);
    }
    const detail = /^\/api\/requirements\/[^/]+$/.exec(path);
    if (detail && request.method() === 'GET') return json(state.rows[0]);
    if (detail && request.method() === 'PUT') {
      const body = request.postDataJSON() as typeof content & { expectedRevision: number };
      state.posts.push({ path, body });
      state.versions.push({ ...version(state.versions.length + 1, '修订'), content: contentOf(body) });
      state.rows = [{ ...state.rows[0], revision: state.rows[0].revision + 1, current_version: state.versions.length }];
      return json(state.rows[0]);
    }
    if (/\/transitions$/.test(path)) {
      const body = request.postDataJSON() as { status: string; expectedRevision: number; actor: string };
      state.posts.push({ path, body });
      state.transitionCount += 1;
      if (overrides.transitions === 'conflict-first' && state.transitionCount === 1) {
        return json({ error: 'Requirement changed or transition is not allowed' }, 409);
      }
      state.rows = [{ ...state.rows[0], status: body.status, revision: state.rows[0].revision + 1 }];
      return json(state.rows[0]);
    }
    if (/\/restore$/.test(path)) {
      const body = request.postDataJSON() as { version: number; expectedRevision: number };
      state.posts.push({ path, body });
      state.rows = [{ ...state.rows[0], revision: state.rows[0].revision + 1, current_version: state.versions.length + 1 }];
      return json(state.rows[0]);
    }
    if (/\/versions$/.test(path)) return json({ versions: state.versions });
    const one = /\/versions\/(\d+)$/.exec(path);
    if (one) return json(state.versions[Number(one[1]) - 1] ?? {}, state.versions[Number(one[1]) - 1] ? 200 : 404);
    return json({ error: 'not found' }, 404);
  };
  return { state, route };
}

async function openPage(page: import('@playwright/test').Page, api = mockApi()) {
  await page.route(url => url.pathname.startsWith('/api/requirements'), api.route);
  await page.goto('/requirements');
  await expect(page.getByRole('heading', { name: '需求中心' })).toBeVisible();
  return api;
}

const rowOf = (page: import('@playwright/test').Page, key: string) =>
  page.getByRole('row').filter({ has: page.getByRole('cell', { name: key, exact: true }) });

test('the list shows what the API returned, and the empty state when it has nothing', async ({ page }) => {
  const api = await openPage(page);
  await expect(page.getByText('尚无真实记录')).toBeVisible();
  api.state.rows = [{ ...requirement }, { ...requirement, id: '22345678-1234-4234-8234-123456789abc', requirement_key: 'REQ-002', title: '监控告警' }];
  await page.getByRole('button', { name: '刷新' }).click();
  await expect(rowOf(page, 'REQ-001')).toBeVisible();
  await expect(rowOf(page, 'REQ-002')).toBeVisible();
  await expect(rowOf(page, 'REQ-001').getByText('草稿')).toBeVisible();
  await expect(rowOf(page, 'REQ-001').getByText('V1')).toBeVisible();
  await expect(rowOf(page, 'REQ-001').getByText('高')).toBeVisible();
});

test('creating a requirement posts its content beside key, actor and summary', async ({ page }) => {
  const api = await openPage(page);
  await page.getByRole('button', { name: '新建需求' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('textbox', { name: '业务编号' }).fill('REQ-007');
  await dialog.getByRole('textbox', { name: '标题' }).fill('需求中心 UI');
  await dialog.getByRole('textbox', { name: '背景' }).fill('只有 API');
  await dialog.getByRole('textbox', { name: '操作人' }).fill('李四');
  await dialog.getByRole('textbox', { name: '变更摘要' }).fill('初稿');
  await dialog.getByRole('button', { name: '添加验收条目' }).click();
  await dialog.getByRole('textbox', { name: '验收条目 1 编号' }).fill('AC-1');
  await dialog.getByRole('textbox', { name: '验收条目 1 内容' }).fill('页面可用');
  await dialog.getByRole('button', { name: '保存需求' }).click();
  await expect(dialog).toHaveCount(0);
  await expect(rowOf(page, 'REQ-007')).toBeVisible();
  const body = api.state.posts[0].body as Record<string, unknown>;
  expect(body).toMatchObject({ requirementKey: 'REQ-007', title: '需求中心 UI', actor: '李四', summary: '初稿' });
  expect(body.acceptanceCriteria).toEqual([{ id: 'AC-1', text: '页面可用' }]);
});

test('the detail shows the structured fields and a transition is confirmed exactly once', async ({ page }) => {
  const api = await openPage(page);
  api.state.rows = [{ ...requirement }];
  await page.getByRole('button', { name: '刷新' }).click();
  await rowOf(page, 'REQ-001').getByRole('button', { name: '详情' }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByText('背景内容')).toBeVisible();
  await expect(dialog.getByText('扩容到 10 倍')).toBeVisible();
  await expect(dialog.getByText('高', { exact: true })).toBeVisible();
  await dialog.getByRole('textbox', { name: '操作人' }).fill('王五');
  await dialog.getByRole('button', { name: '标记为已评审' }).click();
  // The confirmation is open and the request is not sent before it is answered.
  expect(api.state.posts).toHaveLength(0);
  await page.locator('.ant-popconfirm').filter({ visible: true }).locator('.ant-popconfirm-buttons button').last().click();
  await expect(dialog.getByText('已评审')).toBeVisible();
  const post = api.state.posts.find(entry => String(entry.path).endsWith('/transitions'))!;
  expect(post.body).toMatchObject({ status: 'reviewed', actor: '王五', expectedRevision: 1 });
});

test('a transition without an operator is refused by the page before any request', async ({ page }) => {
  const api = mockApi();
  api.state.rows = [{ ...requirement }];
  await openPage(page, api);
  await page.getByRole('button', { name: '刷新' }).click();
  await rowOf(page, 'REQ-001').getByRole('button', { name: '详情' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('button', { name: '标记为已评审' }).click();
  await page.locator('.ant-popconfirm').filter({ visible: true }).locator('.ant-popconfirm-buttons button').last().click();
  await expect(dialog.getByText('请先填写操作人')).toBeVisible();
  await expect(dialog.getByText('草稿')).toBeVisible();
  expect(api.state.posts).toHaveLength(0);
});

test('a refused transition keeps the requirement and the typed operator, and the retry works', async ({ page }) => {
  const api = mockApi({ transitions: 'conflict-first' });
  api.state.rows = [{ ...requirement }];
  await openPage(page, api);
  await page.getByRole('button', { name: '刷新' }).click();
  await rowOf(page, 'REQ-001').getByRole('button', { name: '详情' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('textbox', { name: '操作人' }).fill('王五');
  await dialog.getByRole('button', { name: '标记为已评审' }).click();
  await page.locator('.ant-popconfirm').filter({ visible: true }).locator('.ant-popconfirm-buttons button').last().click();
  await expect(dialog.getByText('需求已被他人修改或状态不允许该转换，请刷新后重试')).toBeVisible();
  await expect(dialog.getByText('草稿')).toBeVisible();
  await expect(dialog.getByRole('textbox', { name: '操作人' })).toHaveValue('王五');
  await dialog.getByRole('button', { name: '标记为已评审' }).click();
  await page.locator('.ant-popconfirm').filter({ visible: true }).locator('.ant-popconfirm-buttons button').last().click();
  await expect(dialog.getByText('已评审')).toBeVisible();
});

test('the version history shows read-only snapshots and restores one as a new draft', async ({ page }) => {
  const api = await openPage(page);
  api.state.rows = [{ ...requirement }];
  api.state.versions = [version(1, '初稿'), version(2, '第二次修订'), version(3, '第三次修订')];
  api.state.rows[0] = { ...api.state.rows[0], current_version: 3, revision: 3 };
  await page.getByRole('button', { name: '刷新' }).click();
  await rowOf(page, 'REQ-001').getByRole('button', { name: '版本历史' }).click();
  const dialog = page.getByRole('dialog');
  // The versions are in their table; the two lists above it name versions too.
  const table = dialog.getByRole('table', { name: '版本历史' });
  await expect(table.getByRole('cell', { name: 'V1', exact: true })).toBeVisible();
  await expect(table.getByRole('cell', { name: 'V3', exact: true })).toBeVisible();
  await dialog.getByRole('button', { name: '查看 V1' }).click();
  await expect(dialog.getByText('V1（只读快照）')).toBeVisible();
  await expect(dialog.getByText('背景内容')).toBeVisible();
  await dialog.getByRole('textbox', { name: '操作人' }).fill('李四');
  await dialog.getByRole('button', { name: '恢复为新草稿' }).first().click();
  await page.locator('.ant-popconfirm').filter({ visible: true }).locator('.ant-popconfirm-buttons button').last().click();
  await expect(dialog).toHaveCount(0);
  const post = api.state.posts.find(entry => String(entry.path).endsWith('/restore'))!;
  expect(post.body).toMatchObject({ version: 1, expectedRevision: 3, actor: '李四' });
});

test('raw HTML in a requirement is inert text', async ({ page }) => {
  const api = mockApi();
  api.state.rows = [{ ...requirement, content: {
    ...content, background: '<img src=x onerror="window.pwned=1">正文 <script>alert(1)</script>',
  } }];
  await openPage(page, api);
  await page.getByRole('button', { name: '刷新' }).click();
  await rowOf(page, 'REQ-001').getByRole('button', { name: '详情' }).click();
  await expect(page.getByText('<img src=x onerror="window.pwned=1">正文 <script>alert(1)</script>')).toBeVisible();
  expect(await page.locator('img').count()).toBe(0);
  expect(await page.evaluate(() => (window as unknown as { pwned?: number }).pwned ?? 0)).toBe(0);
});

test('an incomplete form is refused by the page before any request', async ({ page }) => {
  const api = await openPage(page);
  await page.getByRole('button', { name: '新建需求' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('button', { name: '保存需求' }).click();
  await expect(dialog.getByText('请填写业务编号')).toBeVisible();
  await expect(dialog.getByText('请填写标题')).toBeVisible();
  expect(api.state.posts).toHaveLength(0);
});

export interface ApiHealth {
  status: 'ok';
  service: string;
}

export class ApiError extends Error {
  constructor(message: string, readonly status = 0) {
    super(message);
    this.name = 'ApiError';
  }
}

export async function requestJson<T>(path: string, decode: (data: unknown) => T, signal?: AbortSignal): Promise<T> {
  if (!path.startsWith('/api/')) throw new ApiError('禁止访问非本地 /api/ 接口');
  let response: Response;
  try {
    response = await fetch(path, { signal, cache: 'no-store', headers: { Accept: 'application/json' } });
  } catch (error) {
    if (signal?.aborted) throw error;
    throw new ApiError('无法连接本地 API，请确认服务已启动');
  }
  if (!response.ok) throw new ApiError(`API 请求失败：HTTP ${response.status}`, response.status);
  let json: unknown;
  try { json = await response.json(); }
  catch { throw new ApiError('API 返回无效 JSON', response.status); }
  try { return decode(json); }
  catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError('API 返回的数据结构不正确', response.status);
  }
}

export function getHealth(signal?: AbortSignal): Promise<ApiHealth> {
  return requestJson('/api/health', value => {
    if (!value || typeof value !== 'object') throw new Error('Invalid health payload');
    const row = value as Record<string, unknown>;
    if (row.status !== 'ok' || typeof row.service !== 'string' || !row.service) {
      throw new Error('Invalid health payload');
    }
    return { status: 'ok', service: row.service };
  }, signal);
}

/** Project list contract is intentionally strict: never render unvalidated API data. */
export interface RegisteredProject {
  id: string;
  slug: string;
  name: string;
  repo_root: string;
  default_branch: string;
  revision: number;
  created_at: string;
  updated_at: string;
}

export function decodeProjectList(value: unknown): RegisteredProject[] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ApiError('API 返回的数据结构不正确');
  const data = value as Record<string, unknown>;
  if (!Array.isArray(data.projects)) throw new ApiError('API 返回的数据结构不正确');
  const ids = new Set<string>();
  return data.projects.map((item: unknown) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw new ApiError('API 返回的数据结构不正确');
    const row = item as Record<string, unknown>;
    const fields = ['id', 'slug', 'name', 'repo_root', 'default_branch', 'created_at', 'updated_at'] as const;
    if (fields.some(key => typeof row[key] !== 'string' || !(row[key] as string).trim()) ||
        !Number.isSafeInteger(row.revision) || (row.revision as number) < 0 ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(row.id as string) ||
        !(row.repo_root as string).startsWith('/') || ids.has(row.id as string)) {
      throw new ApiError('API 返回的数据结构不正确');
    }
    ids.add(row.id as string);
    return Object.fromEntries([...fields.map(key => [key, row[key]]), ['revision', row.revision]]) as unknown as RegisteredProject;
  });
}

export function getProjects(signal?: AbortSignal): Promise<RegisteredProject[]> {
  return requestJson('/api/projects', decodeProjectList, signal);
}

/** Register a local Git repository. Server-side realpath/Git validation remains authoritative. */
export async function registerProject(input: { path: string; slug: string; name: string }, signal?: AbortSignal): Promise<RegisteredProject> {
  if (!input.path.startsWith('/') || !/^[a-z0-9][a-z0-9-]{1,63}$/.test(input.slug) || !input.name.trim()) {
    throw new ApiError('请填写有效的绝对路径、项目标识和名称', 400);
  }
  let response: Response;
  try {
    response = await fetch('/api/projects', {
      method: 'POST', signal, cache: 'no-store',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: input.path, slug: input.slug, name: input.name }),
    });
  } catch (error) {
    if (signal?.aborted) throw error;
    throw new ApiError('无法连接本地 API，请确认服务已启动');
  }
  if (!response.ok) {
    if (response.status === 409) throw new ApiError('项目或仓库已登记', 409);
    if (response.status === 400) throw new ApiError('仓库路径或登记信息无效', 400);
    throw new ApiError(`API 请求失败：HTTP ${response.status}`, response.status);
  }
  let payload: unknown;
  try { payload = await response.json(); }
  catch { throw new ApiError('API 返回无效 JSON', response.status); }
  return decodeProjectList({ projects: [payload] })[0]!;
}

/** Rename the catalog entry only. `revision` must be the one the caller loaded, so a newer rename is never overwritten. */
export async function renameProject(id: string, input: { name: string; revision: number }, signal?: AbortSignal): Promise<RegisteredProject> {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
    throw new ApiError('项目 ID 无效', 400);
  }
  if (!Number.isSafeInteger(input.revision) || input.revision < 0) {
    throw new ApiError('项目信息已过期，请刷新列表后重试', 409);
  }
  if (!input.name.trim() || input.name.trim().length > 120) throw new ApiError('项目名称需为 1–120 个字符', 400);
  let response: Response;
  try {
    response = await fetch(`/api/projects/${id}`, {
      method: 'PATCH', signal, cache: 'no-store',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: input.name, revision: input.revision }),
    });
  } catch (error) {
    if (signal?.aborted) throw error;
    throw new ApiError('无法连接本地 API，请确认服务已启动');
  }
  if (response.status === 404) throw new ApiError('项目不存在', 404);
  if (response.status === 409) throw new ApiError('项目已被其他操作修改，请关闭后刷新列表再重试', 409);
  if (response.status === 400) throw new ApiError('项目名称无效', 400);
  if (!response.ok) throw new ApiError(`API 请求失败：HTTP ${response.status}`, response.status);
  let payload: unknown;
  try { payload = await response.json(); }
  catch { throw new ApiError('API 返回无效 JSON', response.status); }
  return decodeProjectList({ projects: [payload] })[0]!;
}

/** Live Git status for a registered project; never accepts an arbitrary filesystem path. */
export interface ProjectGitStatus {
  repoRoot: string;
  headSha: string | null;
  branch: string | null;
  dirty: boolean;
}

export function decodeProjectGitStatus(value: unknown): ProjectGitStatus {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ApiError('API 返回的数据结构不正确');
  const row = value as Record<string, unknown>;
  if (typeof row.repoRoot !== 'string' || !row.repoRoot.startsWith('/') ||
      (row.headSha !== null && (typeof row.headSha !== 'string' || !/^[0-9a-f]{40}$/i.test(row.headSha))) ||
      (row.branch !== null && (typeof row.branch !== 'string' || !row.branch.trim())) ||
      typeof row.dirty !== 'boolean') {
    throw new ApiError('API 返回的数据结构不正确');
  }
  return { repoRoot: row.repoRoot, headSha: row.headSha, branch: row.branch, dirty: row.dirty };
}

export async function getProjectStatus(id: string, signal?: AbortSignal): Promise<ProjectGitStatus> {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
    throw new ApiError('项目 ID 无效', 400);
  }
  try {
    return await requestJson(`/api/projects/${id}/status`, decodeProjectGitStatus, signal);
  } catch (error) {
    if (error instanceof ApiError && error.status === 409) throw new ApiError('已登记的 Git 仓库不可用', 409);
    if (error instanceof ApiError && error.status === 404) throw new ApiError('项目不存在', 404);
    throw error;
  }
}

/** Unregister only the catalog entry. Never sends a filesystem path or deletes repository files. */
export async function unregisterProject(id: string, signal?: AbortSignal): Promise<void> {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
    throw new ApiError('项目 ID 无效', 400);
  }
  let response: Response;
  try {
    response = await fetch(`/api/projects/${id}`, {
      method: 'DELETE', signal, cache: 'no-store', headers: { Accept: 'application/json' },
    });
  } catch (error) {
    if (signal?.aborted) throw error;
    throw new ApiError('无法连接本地 API，请确认服务已启动');
  }
  if (response.status === 404) throw new ApiError('项目不存在', 404);
  if (!response.ok) throw new ApiError(`API 请求失败：HTTP ${response.status}`, response.status);
  if (response.status !== 204) throw new ApiError('API 返回意外的删除结果', response.status);
}

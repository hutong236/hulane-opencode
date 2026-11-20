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

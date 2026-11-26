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
  /** The `origin` URL without any user name or password; null when the repository has none. */
  remote_url: string | null;
  revision: number;
  created_at: string;
  updated_at: string;
}

/** The API strips credentials before storing a remote. Never show them either, should one slip through. */
function withoutCredentials(url: string): string | null {
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(url)) return url;
  try {
    const parsed = new URL(url);
    if (!parsed.username && !parsed.password) return url;
    parsed.username = '';
    parsed.password = '';
    return parsed.href;
  } catch {
    return null;
  }
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
    // A remote is either null or a non-empty URL. Missing is not accepted: the field is part of the contract.
    if (row.remote_url !== null &&
        (typeof row.remote_url !== 'string' || !(row.remote_url as string).trim())) {
      throw new ApiError('API 返回的数据结构不正确');
    }
    const remoteUrl = row.remote_url === null ? null : withoutCredentials(row.remote_url as string);
    if (remoteUrl === null && row.remote_url !== null) throw new ApiError('API 返回的数据结构不正确');
    ids.add(row.id as string);
    const entries = [...fields.map(key => [key, row[key]]), ['remote_url', remoteUrl], ['revision', row.revision]];
    return Object.fromEntries(entries) as unknown as RegisteredProject;
  });
}

export function getProjects(signal?: AbortSignal): Promise<RegisteredProject[]> {
  return requestJson('/api/projects', decodeProjectList, signal);
}

/** What the API says is wrong with a path, in words. Anything it does not name gets the general message. */
const REJECTIONS: Record<string, string> = {
  not_absolute: '必须使用绝对路径',
  missing: '目录不存在',
  not_directory: '该路径不是目录',
  symlink: '路径中包含符号链接，请使用真实路径',
  unreadable: '没有读取该目录的权限',
  not_git_root: '该目录不是 Git 仓库的根目录',
};

async function rejectionReason(response: Response): Promise<string> {
  try {
    const payload = (await response.json()) as { reason?: unknown } | null;
    const reason = payload?.reason;
    return typeof reason === 'string' && Object.hasOwn(REJECTIONS, reason) ? REJECTIONS[reason] : '仓库路径或登记信息无效';
  } catch {
    return '仓库路径或登记信息无效';
  }
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
    if (response.status === 400) throw new ApiError(await rejectionReason(response), 400);
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

/* ------------------------------- Requirements ------------------------------ */

export type RequirementStatus = 'draft' | 'reviewed' | 'approved' | 'archived';
export type RequirementPriority = 'low' | 'medium' | 'high' | 'critical';
export interface RequirementAcceptanceCriterion { id: string; text: string }
export interface RequirementContent {
  title: string;
  background: string;
  goal: string;
  scope: string;
  acceptanceCriteria: RequirementAcceptanceCriterion[];
  priority: RequirementPriority;
  risk: string;
}
export interface Requirement {
  id: string;
  requirement_key: string;
  title: string;
  status: RequirementStatus;
  current_version: number;
  revision: number;
  created_at: string;
  updated_at: string;
  content: RequirementContent;
  content_sha256: string;
}
export interface RequirementVersion {
  id: string;
  requirement_id: string;
  version: number;
  content: RequirementContent;
  content_sha256: string;
  actor: string;
  summary: string;
  created_at: string;
}

export const REQUIREMENT_STATUSES: readonly RequirementStatus[] = ['draft', 'reviewed', 'approved', 'archived'];
export const REQUIREMENT_PRIORITIES: readonly RequirementPriority[] = ['low', 'medium', 'high', 'critical'];
/** draft→reviewed→approved→archived, one way. The API refuses anything else. */
export const ALLOWED_TRANSITIONS: Readonly<Record<RequirementStatus, readonly RequirementStatus[]>> = {
  draft: ['reviewed'], reviewed: ['approved'], approved: ['archived'], archived: [],
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const REQUIREMENT_KEY = /^REQ-[0-9]{3,6}$/;
const SHA = /^[0-9a-f]{64}$/;

function decodeContent(value: unknown): RequirementContent {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid content');
  const row = value as Record<string, unknown>;
  for (const field of ['title', 'background', 'goal', 'scope', 'risk'] as const) {
    if (typeof row[field] !== 'string') throw new Error('Invalid content');
  }
  if ((row.title as string).trim().length === 0) throw new Error('Invalid content');
  if (!Array.isArray(row.acceptanceCriteria) || row.acceptanceCriteria.length > 50) throw new Error('Invalid content');
  const ids = new Set<string>();
  const criteria = row.acceptanceCriteria.map((entry: unknown) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw new Error('Invalid content');
    const item = entry as Record<string, unknown>;
    if (typeof item.id !== 'string' || !item.id || typeof item.text !== 'string' || !item.text.trim()) {
      throw new Error('Invalid content');
    }
    if (ids.has(item.id)) throw new Error('Invalid content');
    ids.add(item.id);
    return { id: item.id, text: item.text };
  });
  if (!REQUIREMENT_PRIORITIES.includes(row.priority as RequirementPriority)) throw new Error('Invalid content');
  return {
    title: row.title as string, background: row.background as string, goal: row.goal as string,
    scope: row.scope as string, acceptanceCriteria: criteria,
    priority: row.priority as RequirementPriority, risk: row.risk as string,
  };
}

/** The requirement contract is strict like the project one: never render unvalidated API data. */
function decodeRequirement(value: unknown): Requirement {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid requirement');
  const row = value as Record<string, unknown>;
  if (typeof row.id !== 'string' || !UUID.test(row.id)) throw new Error('Invalid requirement');
  if (typeof row.requirement_key !== 'string' || !REQUIREMENT_KEY.test(row.requirement_key)) throw new Error('Invalid requirement');
  if (typeof row.title !== 'string' || !row.title.trim()) throw new Error('Invalid requirement');
  if (!REQUIREMENT_STATUSES.includes(row.status as RequirementStatus)) throw new Error('Invalid requirement');
  for (const field of ['created_at', 'updated_at'] as const) {
    if (typeof row[field] !== 'string' || !(row[field] as string).trim()) throw new Error('Invalid requirement');
  }
  if (!Number.isSafeInteger(row.current_version) || (row.current_version as number) < 1) throw new Error('Invalid requirement');
  if (!Number.isSafeInteger(row.revision) || (row.revision as number) < 1) throw new Error('Invalid requirement');
  if (typeof row.content_sha256 !== 'string' || !SHA.test(row.content_sha256)) throw new Error('Invalid requirement');
  return {
    id: row.id as string, requirement_key: row.requirement_key as string, title: row.title as string,
    status: row.status as RequirementStatus,
    current_version: row.current_version as number, revision: row.revision as number,
    created_at: row.created_at as string, updated_at: row.updated_at as string,
    content: decodeContent(row.content), content_sha256: row.content_sha256 as string,
  };
}

/** A snapshot is strict like the requirement itself; its content is read-only by contract. */
function decodeVersion(value: unknown): RequirementVersion {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid version');
  const row = value as Record<string, unknown>;
  if (typeof row.id !== 'string' || !UUID.test(row.id)) throw new Error('Invalid version');
  if (typeof row.requirement_id !== 'string' || !UUID.test(row.requirement_id)) throw new Error('Invalid version');
  if (!Number.isSafeInteger(row.version) || (row.version as number) < 1) throw new Error('Invalid version');
  if (typeof row.actor !== 'string' || !row.actor.trim()) throw new Error('Invalid version');
  if (typeof row.summary !== 'string') throw new Error('Invalid version');
  if (typeof row.created_at !== 'string' || !(row.created_at as string).trim()) throw new Error('Invalid version');
  if (typeof row.content_sha256 !== 'string' || !SHA.test(row.content_sha256)) throw new Error('Invalid version');
  return {
    id: row.id, requirement_id: row.requirement_id, version: row.version as number,
    content: decodeContent(row.content), content_sha256: row.content_sha256,
    actor: row.actor, summary: row.summary, created_at: row.created_at,
  };
}

export function decodeRequirementList(value: unknown): Requirement[] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ApiError('API 返回的数据结构不正确');
  const data = value as Record<string, unknown>;
  if (!Array.isArray(data.requirements)) throw new ApiError('API 返回的数据结构不正确');
  const ids = new Set<string>();
  return data.requirements.map((item: unknown) => {
    const requirement = decodeRequirement(item);
    if (ids.has(requirement.id)) throw new ApiError('API 返回的数据结构不正确');
    ids.add(requirement.id);
    return requirement;
  });
}

async function writeRequirement(path: string, method: string, payload: unknown, signal?: AbortSignal): Promise<Requirement> {
  let response: Response;
  try {
    response = await fetch(path, {
      method, signal, cache: 'no-store',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
  } catch (error) {
    if (signal?.aborted) throw error;
    throw new ApiError('无法连接本地 API，请确认服务已启动');
  }
  if (!response.ok) {
    if (response.status === 409) throw new ApiError('需求已被他人修改或状态不允许该转换，请刷新后重试', 409);
    if (response.status === 404) throw new ApiError('需求不存在', 404);
    if (response.status === 400) throw new ApiError('需求输入无效或格式不正确', 400);
    throw new ApiError(`API 请求失败：HTTP ${response.status}`, response.status);
  }
  try { return decodeRequirement(await response.json()); }
  catch { throw new ApiError('API 返回的数据结构不正确', response.status); }
}

export interface RequirementInput {
  requirementKey: string;
  content: RequirementContent;
  actor: string;
  summary: string;
}

/** The API reads the content fields from the top level of the body, beside key, actor and summary. */
const writeBody = (input: RequirementInput & { expectedRevision?: number }) => ({
  ...input.content,
  requirementKey: input.requirementKey,
  actor: input.actor,
  summary: input.summary,
  ...(input.expectedRevision === undefined ? {} : { expectedRevision: input.expectedRevision }),
});

export async function createRequirement(input: RequirementInput, signal?: AbortSignal): Promise<Requirement> {
  return writeRequirement('/api/requirements', 'POST', writeBody(input), signal);
}

export function getRequirements(signal?: AbortSignal): Promise<Requirement[]> {
  return requestJson('/api/requirements', decodeRequirementList, signal);
}

export async function getRequirement(id: string, signal?: AbortSignal): Promise<Requirement> {
  if (!UUID.test(id)) throw new ApiError('需求 ID 无效', 400);
  return requestJson(`/api/requirements/${id}`, decodeRequirement, signal);
}

export async function updateRequirement(
  id: string, input: RequirementInput & { expectedRevision: number }, signal?: AbortSignal,
): Promise<Requirement> {
  if (!UUID.test(id)) throw new ApiError('需求 ID 无效', 400);
  return writeRequirement(`/api/requirements/${id}`, 'PUT', writeBody(input), signal);
}

export async function transitionRequirement(
  id: string, input: { status: RequirementStatus; expectedRevision: number; actor: string; summary: string }, signal?: AbortSignal,
): Promise<Requirement> {
  if (!UUID.test(id)) throw new ApiError('需求 ID 无效', 400);
  return writeRequirement(`/api/requirements/${id}/transitions`, 'POST', input, signal);
}

export async function restoreRequirement(
  id: string, input: { version: number; expectedRevision: number; actor: string; summary: string }, signal?: AbortSignal,
): Promise<Requirement> {
  if (!UUID.test(id)) throw new ApiError('需求 ID 无效', 400);
  return writeRequirement(`/api/requirements/${id}/restore`, 'POST', input, signal);
}

export async function getRequirementVersions(id: string, signal?: AbortSignal): Promise<RequirementVersion[]> {
  if (!UUID.test(id)) throw new ApiError('需求 ID 无效', 400);
  return requestJson(`/api/requirements/${id}/versions`, (value: unknown) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ApiError('API 返回的数据结构不正确');
    const data = value as Record<string, unknown>;
    if (!Array.isArray(data.versions)) throw new ApiError('API 返回的数据结构不正确');
    return data.versions.map(decodeVersion);
  }, signal);
}

export async function getRequirementVersion(id: string, version: number, signal?: AbortSignal): Promise<RequirementVersion> {
  if (!UUID.test(id) || !Number.isSafeInteger(version) || version < 1) throw new ApiError('需求版本无效', 400);
  return requestJson(`/api/requirements/${id}/versions/${version}`, decodeVersion, signal);
}

/* ----------------------------- Requirement diffs ---------------------------- */

export type DiffOp = 'added' | 'modified' | 'deleted' | 'needs_review';
export type NeedsReviewReason =
  | 'duplicate_id' | 'unkeyed_array_changed' | 'reordered' | 'possible_rename' | 'ambiguous_match';
export interface RequirementDiffChange {
  op: DiffOp;
  pointer: string;
  value?: unknown;
  old_value?: unknown;
  new_value?: unknown;
  reason?: NeedsReviewReason;
  related?: string[];
}
export interface RequirementDiffSummary {
  added: number;
  modified: number;
  deleted: number;
  needs_review: number;
  unchanged: number;
}
export interface RequirementDiff {
  schema: 1;
  base_sha256: string;
  target_sha256: string;
  summary: RequirementDiffSummary;
  changes: RequirementDiffChange[];
  unchanged: string[];
}
/** A comparison without its changes, as a list of comparisons gives it. */
export interface RequirementDiffRecord {
  id: string;
  requirement_id: string;
  base_version: number;
  target_version: number;
  base_version_id: string;
  target_version_id: string;
  base_sha256: string;
  target_sha256: string;
  diff_sha256: string;
  summary: RequirementDiffSummary;
  created_at: string;
}
export interface StoredRequirementDiff extends RequirementDiffRecord {
  diff: RequirementDiff;
}

export const DIFF_OPS: readonly DiffOp[] = ['added', 'modified', 'deleted', 'needs_review'];
export const NEEDS_REVIEW_REASONS: readonly NeedsReviewReason[] = [
  'duplicate_id', 'unkeyed_array_changed', 'reordered', 'possible_rename', 'ambiguous_match',
];
const SHA256 = /^[0-9a-f]{64}$/;
const malformed = (): ApiError => new ApiError('API 返回的数据结构不正确');

function decodeDiffSummary(value: unknown): RequirementDiffSummary {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw malformed();
  const row = value as Record<string, unknown>;
  for (const key of ['added', 'modified', 'deleted', 'needs_review', 'unchanged'] as const) {
    if (!Number.isSafeInteger(row[key]) || (row[key] as number) < 0) throw malformed();
  }
  return {
    added: row.added as number, modified: row.modified as number, deleted: row.deleted as number,
    needs_review: row.needs_review as number, unchanged: row.unchanged as number,
  };
}

function decodeDiffChange(value: unknown): RequirementDiffChange {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw malformed();
  const row = value as Record<string, unknown>;
  if (!DIFF_OPS.includes(row.op as DiffOp) || typeof row.pointer !== 'string') throw malformed();
  const has = (key: string): boolean => Object.hasOwn(row, key);
  if (row.op === 'added' && !has('value')) throw malformed();
  if ((row.op === 'deleted' || row.op === 'modified') && !has('old_value')) throw malformed();
  if (row.op === 'modified' && !has('new_value')) throw malformed();
  if (row.op === 'needs_review') {
    if (!NEEDS_REVIEW_REASONS.includes(row.reason as NeedsReviewReason) || !Array.isArray(row.related) ||
        !row.related.every(pointer => typeof pointer === 'string')) {
      throw malformed();
    }
  }
  const change: RequirementDiffChange = { op: row.op as DiffOp, pointer: row.pointer };
  if (has('value')) change.value = row.value;
  if (has('old_value')) change.old_value = row.old_value;
  if (has('new_value')) change.new_value = row.new_value;
  if (row.op === 'needs_review') {
    change.reason = row.reason as NeedsReviewReason;
    change.related = row.related as string[];
  }
  return change;
}

/** The diff of one comparison. The summary has to agree with the entries, or the answer is refused as a whole. */
function decodeDiff(value: unknown): RequirementDiff {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw malformed();
  const row = value as Record<string, unknown>;
  if (row.schema !== 1 || typeof row.base_sha256 !== 'string' || !SHA256.test(row.base_sha256) ||
      typeof row.target_sha256 !== 'string' || !SHA256.test(row.target_sha256)) {
    throw malformed();
  }
  const summary = decodeDiffSummary(row.summary);
  if (!Array.isArray(row.changes) || !Array.isArray(row.unchanged) ||
      !row.unchanged.every(pointer => typeof pointer === 'string')) {
    throw malformed();
  }
  const changes = row.changes.map(decodeDiffChange);
  const counted = { added: 0, modified: 0, deleted: 0, needs_review: 0, unchanged: row.unchanged.length };
  for (const change of changes) counted[change.op] += 1;
  for (const key of Object.keys(counted) as (keyof RequirementDiffSummary)[]) {
    if (counted[key] !== summary[key]) throw malformed();
  }
  return {
    schema: 1, base_sha256: row.base_sha256, target_sha256: row.target_sha256, summary, changes,
    unchanged: row.unchanged as string[],
  };
}

function decodeDiffRecord(value: unknown): RequirementDiffRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw malformed();
  const row = value as Record<string, unknown>;
  if (typeof row.id !== 'string' || !UUID.test(row.id) || typeof row.requirement_id !== 'string' || !UUID.test(row.requirement_id)) {
    throw malformed();
  }
  for (const field of ['base_version_id', 'target_version_id'] as const) {
    if (typeof row[field] !== 'string' || !UUID.test(row[field])) throw malformed();
  }
  for (const field of ['base_version', 'target_version'] as const) {
    if (!Number.isSafeInteger(row[field]) || (row[field] as number) < 1) throw malformed();
  }
  if ((row.base_version as number) === row.target_version) throw malformed();
  for (const field of ['base_sha256', 'target_sha256', 'diff_sha256'] as const) {
    if (typeof row[field] !== 'string' || !SHA256.test(row[field])) throw malformed();
  }
  if (typeof row.created_at !== 'string' || !row.created_at.trim()) throw malformed();
  return {
    id: row.id, requirement_id: row.requirement_id,
    base_version: row.base_version as number, target_version: row.target_version as number,
    base_version_id: row.base_version_id as string, target_version_id: row.target_version_id as string,
    base_sha256: row.base_sha256 as string, target_sha256: row.target_sha256 as string,
    diff_sha256: row.diff_sha256 as string, summary: decodeDiffSummary(row.summary), created_at: row.created_at,
  };
}

function decodeStoredDiff(value: unknown): StoredRequirementDiff {
  const record = decodeDiffRecord(value);
  const diff = decodeDiff((value as Record<string, unknown>).diff);
  // The diff names the two snapshots the record says were compared.
  if (diff.base_sha256 !== record.base_sha256 || diff.target_sha256 !== record.target_sha256) throw malformed();
  return { ...record, diff };
}

export async function getRequirementDiffs(id: string, signal?: AbortSignal): Promise<RequirementDiffRecord[]> {
  if (!UUID.test(id)) throw new ApiError('需求 ID 无效', 400);
  return requestJson(`/api/requirements/${id}/diffs`, value => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw malformed();
    const data = value as Record<string, unknown>;
    if (!Array.isArray(data.diffs)) throw malformed();
    const ids = new Set<string>();
    return data.diffs.map((item: unknown) => {
      const record = decodeDiffRecord(item);
      // A record of another requirement is not an answer to this question.
      if (record.requirement_id !== id || ids.has(record.id)) throw malformed();
      ids.add(record.id);
      return record;
    });
  }, signal);
}

export async function getRequirementDiff(id: string, diffId: string, signal?: AbortSignal): Promise<StoredRequirementDiff> {
  if (!UUID.test(id)) throw new ApiError('需求 ID 无效', 400);
  if (!UUID.test(diffId)) throw new ApiError('差分 ID 无效', 400);
  const stored = requestJson(`/api/requirements/${id}/diffs/${diffId}`, value => {
    const record = decodeStoredDiff(value);
    if (record.id !== diffId || record.requirement_id !== id) throw malformed();
    return record;
  }, signal);
  return stored.catch(error => {
    if (error instanceof ApiError && error.status === 404) throw new ApiError('这个差分不存在', 404);
    throw error;
  });
}

/** Compare two versions. The first comparison is stored; a later one for the same pair gives the stored result. */
export async function compareRequirementVersions(
  id: string, input: { baseVersion: number; targetVersion: number }, signal?: AbortSignal,
): Promise<StoredRequirementDiff> {
  if (!UUID.test(id)) throw new ApiError('需求 ID 无效', 400);
  let response: Response;
  try {
    response = await fetch(`/api/requirements/${id}/diffs`, {
      method: 'POST', signal, cache: 'no-store',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify({ baseVersion: input.baseVersion, targetVersion: input.targetVersion }),
    });
  } catch (error) {
    if (signal?.aborted) throw error;
    throw new ApiError('无法连接本地 API，请确认服务已启动');
  }
  if (!response.ok) {
    if (response.status === 404) throw new ApiError('需求或版本不存在', 404);
    if (response.status === 400) throw new ApiError('请选择两个不同的版本进行比较', 400);
    throw new ApiError(`API 请求失败：HTTP ${response.status}`, response.status);
  }
  try {
    const stored = decodeStoredDiff(await response.json());
    if (stored.requirement_id !== id) throw malformed();
    return stored;
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw malformed();
  }
}

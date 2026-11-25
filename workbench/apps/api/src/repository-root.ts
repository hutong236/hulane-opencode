import { constants, existsSync, lstatSync } from 'node:fs';
import { access, lstat, realpath } from 'node:fs/promises';
import { isAbsolute, join, parse, resolve, sep } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export type RepositoryRootReason =
  | 'not_absolute' | 'missing' | 'not_directory' | 'symlink' | 'unreadable' | 'not_git_root';

/** Why a path was refused. The reason names a kind of problem and is safe to show; it never contains a path. */
export class RepositoryRootError extends Error {
  constructor(readonly reason: RepositoryRootReason) {
    super(`Invalid Git repository root: ${reason}`);
    this.name = 'RepositoryRootError';
  }
}

function isPermissionError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | null)?.code;
  return code === 'EACCES' || code === 'EPERM';
}

/** Entering and listing a directory takes read and execute permission; so does reading a repository's own metadata. */
async function assertReadable(directory: string): Promise<void> {
  const targets = [directory];
  const metadata = join(directory, '.git');
  if (existsSync(metadata) && lstatSync(metadata).isDirectory()) targets.push(metadata);
  for (const target of targets) {
    try { await access(target, constants.R_OK | constants.X_OK); }
    catch { throw new RepositoryRootError('unreadable'); }
  }
}

/** Validate a local Git root before registration; never invoke a shell. */
export async function validateRepositoryRoot(input: string): Promise<string> {
  if (!input || !isAbsolute(input)) throw new RepositoryRootError('not_absolute');
  const normalized = resolve(input);
  const root = parse(normalized).root;
  let cursor = root;
  for (const segment of normalized.slice(root.length).split(sep).filter(Boolean)) {
    cursor = resolve(cursor, segment);
    let stat: Awaited<ReturnType<typeof lstat>>;
    try { stat = await lstat(cursor); }
    catch (error) { throw new RepositoryRootError(isPermissionError(error) ? 'unreadable' : 'missing'); }
    if (stat.isSymbolicLink()) throw new RepositoryRootError('symlink');
    if (!stat.isDirectory()) throw new RepositoryRootError('not_directory');
  }
  let canonical: string;
  try { canonical = await realpath(normalized); }
  catch (error) { throw new RepositoryRootError(isPermissionError(error) ? 'unreadable' : 'missing'); }
  await assertReadable(canonical);
  // A caller's Git environment must never redirect validation to another repository.
  const env = { ...process.env };
  // Git honors many GIT_* overrides (including injected config and object directories).
  // Remove the entire Git namespace rather than maintaining a fragile allowlist.
  for (const key of Object.keys(env)) {
    if (key.startsWith('GIT_')) delete env[key];
  }
  let stdout: string;
  try {
    ({ stdout } = await execFileAsync('git', ['-C', canonical, 'rev-parse', '--is-inside-work-tree', '--show-toplevel'], {
      env,
      timeout: 5000,
      maxBuffer: 1024 * 1024,
    }));
  } catch {
    // Not a repository, a bare one, or one whose metadata Git cannot read.
    throw new RepositoryRootError('not_git_root');
  }
  const lines = stdout.trim().split(/\r?\n/);
  if (lines.length !== 2 || lines[0] !== 'true' || resolve(lines[1]) !== canonical) {
    throw new RepositoryRootError('not_git_root');
  }
  return canonical;
}

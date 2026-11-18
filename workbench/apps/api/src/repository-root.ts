import { lstat, realpath } from 'node:fs/promises';
import { isAbsolute, parse, resolve, sep } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/** Validate a local Git root before registration; never invoke a shell. */
export async function validateRepositoryRoot(input: string): Promise<string> {
  if (!input || !isAbsolute(input)) throw new Error('Repository path must be absolute');
  const normalized = resolve(input);
  const root = parse(normalized).root;
  let cursor = root;
  for (const segment of normalized.slice(root.length).split(sep).filter(Boolean)) {
    cursor = resolve(cursor, segment);
    const stat = await lstat(cursor);
    if (stat.isSymbolicLink()) throw new Error('Symbolic-link repository paths are not allowed');
    if (!stat.isDirectory()) throw new Error('Repository path must be a directory');
  }
  const canonical = await realpath(normalized);
  // A caller's Git environment must never redirect validation to another repository.
  const env = { ...process.env };
  for (const key of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_COMMON_DIR', 'GIT_INDEX_FILE', 'GIT_CEILING_DIRECTORIES']) {
    delete env[key];
  }
  const { stdout } = await execFileAsync('git', ['-C', canonical, 'rev-parse', '--is-inside-work-tree', '--show-toplevel'], {
    env,
    timeout: 5000,
    maxBuffer: 1024 * 1024,
  });
  const lines = stdout.trim().split(/\r?\n/);
  if (lines.length !== 2 || lines[0] !== 'true' || resolve(lines[1]) !== canonical) {
    throw new Error('Repository path must be a non-bare Git worktree root');
  }
  return canonical;
}

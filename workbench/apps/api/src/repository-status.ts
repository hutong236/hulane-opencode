import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { validateRepositoryRoot } from './repository-root.js';

const execFileAsync = promisify(execFile);

export interface RepositoryStatus {
  repoRoot: string;
  headSha: string | null;
  branch: string | null;
  dirty: boolean;
}

/**
 * Read-only Git in a repository: never a shell, never inherited GIT_* overrides, never a repository-configured
 * fsmonitor or hook. `--no-optional-locks` keeps Git from rewriting the index while it refreshes stat information, so
 * the user's repository is left exactly as it was and a read-only one can be inspected. Rejects on a non-zero exit.
 */
export async function runGit(repoRoot: string, ...args: string[]): Promise<string> {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.startsWith('GIT_')) delete env[key];
  }
  const { stdout } = await execFileAsync('git', ['--no-optional-locks', '-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=/dev/null', '-C', repoRoot, ...args], {
    env, timeout: 5000, maxBuffer: 1024 * 1024,
  });
  return stdout.trim();
}

/** Read-only status for a validated Git root. */
export async function readRepositoryStatus(input: string): Promise<RepositoryStatus> {
  const repoRoot = await validateRepositoryRoot(input);
  const run = (...args: string[]) => runGit(repoRoot, ...args);
  // Unborn repositories have no HEAD commit yet, but still have a branch.
  const branch = await run('symbolic-ref', '--quiet', '--short', 'HEAD').catch(() => null);
  const headSha = await run('rev-parse', '--verify', 'HEAD').catch(() => null);
  const porcelain = await run('status', '--porcelain=v1', '--untracked-files=normal');
  return { repoRoot, headSha, branch, dirty: porcelain.length > 0 };
}

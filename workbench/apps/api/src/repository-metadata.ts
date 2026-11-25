import { validateRepositoryRoot } from './repository-root.js';
import { runGit } from './repository-status.js';

export interface RepositoryMetadata {
  /** The branch new work starts from. */
  defaultBranch: string;
  /** URL of the `origin` remote without any user name or password; null when the repository has none. */
  remoteUrl: string | null;
}

const CONVENTIONAL_BRANCHES = ['main', 'master'];

/**
 * Removes the user name and password from a remote URL. A token embedded for HTTPS, as in `https://user:token@host/path`,
 * must never reach storage or a response. The scp-like `git@host:path` form and a local path carry no password.
 */
export function redactRemoteUrl(url: string | null): string | null {
  if (!url) return null;
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(url)) return url;
  try {
    const parsed = new URL(url);
    parsed.username = '';
    parsed.password = '';
    return parsed.href;
  } catch {
    // A URL with a scheme that cannot be parsed could not be checked for credentials, so it is not stored.
    return null;
  }
}

/** Where `origin` points, else the conventional branch, else the one checked out ("HEAD" when detached). */
export async function readDefaultBranch(repoRoot: string): Promise<string> {
  const remoteHead = await runGit(repoRoot, 'symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD').catch(() => null);
  if (remoteHead?.startsWith('origin/')) return remoteHead.slice('origin/'.length);
  for (const candidate of CONVENTIONAL_BRANCHES) {
    if (await runGit(repoRoot, 'rev-parse', '--verify', '--quiet', `refs/heads/${candidate}`).catch(() => null)) return candidate;
  }
  return await runGit(repoRoot, 'symbolic-ref', '--quiet', '--short', 'HEAD').catch(() => 'HEAD');
}

/** Facts about a validated Git root that the catalog keeps next to the path. Reads Git only; changes nothing. */
export async function readRepositoryMetadata(input: string): Promise<RepositoryMetadata> {
  const repoRoot = await validateRepositoryRoot(input);
  return {
    defaultBranch: await readDefaultBranch(repoRoot),
    remoteUrl: redactRemoteUrl(await runGit(repoRoot, 'remote', 'get-url', 'origin').catch(() => null)),
  };
}

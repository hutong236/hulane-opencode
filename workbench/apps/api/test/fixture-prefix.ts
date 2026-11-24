import { realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Prefix for a test fixture directory. macOS places its temp directory below the `/var` symlink, which the
 * repository and database path guards reject, so fixtures are always created below the resolved real path.
 */
export function fixturePrefix(prefix: string): string {
  return join(realpathSync(tmpdir()), prefix);
}

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const workbench = fileURLToPath(new URL('..', import.meta.url));

// The shell cases are not mocked, so the development API they reach opens its database in the directory it was
// started with. A server started by Playwright must never start with the developer's real one.
function serverEnvironment(extra = {}) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => name !== 'WORKBENCH_DATA_DIR'));
  // tsx loads the configuration as CommonJS here, which wraps the default export once more than ESM would.
  const script = "import('./playwright.config.ts').then(loaded => { const config = loaded.default?.default ?? loaded.default;"
    + ' console.log(JSON.stringify(config.webServer.env)); })';
  const output = execFileSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script],
    { cwd: workbench, encoding: 'utf8', env: { ...env, ...extra } });
  return JSON.parse(output.trim().split('\n').pop());
}

test('a server started by Playwright gets a throwaway data directory that is removed afterwards', () => {
  const directory = serverEnvironment().WORKBENCH_DATA_DIR;
  assert.ok(directory?.startsWith('/'), 'an absolute directory is passed to the server');
  for (const real of [`${homedir()}/Library/`, `${homedir()}/.local/`, `${homedir()}/.config/`]) {
    assert.ok(!directory.startsWith(real), `the throwaway directory is not under ${real}`);
  }
  assert.equal(existsSync(directory), false, 'the throwaway directory is gone once the run ends');
});

test('an explicit WORKBENCH_DATA_DIR is passed through and left alone', () => {
  const explicit = mkdtempSync(join(realpathSync(tmpdir()), 'wb-explicit-'));
  try {
    assert.equal(serverEnvironment({ WORKBENCH_DATA_DIR: explicit }).WORKBENCH_DATA_DIR, explicit);
    assert.ok(existsSync(explicit), 'an explicit directory is never removed by the configuration');
  } finally {
    rmSync(explicit, { recursive: true, force: true });
  }
});

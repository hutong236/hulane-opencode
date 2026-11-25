import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defineConfig, devices } from '@playwright/test';

// The shell cases are not mocked, so the development API they reach opens its database in the directory it was
// started with. Without an explicit directory that is the developer's real one; a server started here gets a
// throwaway directory instead.
const dataDirectory = process.env.WORKBENCH_DATA_DIR
  ?? mkdtempSync(join(realpathSync(tmpdir()), 'workbench-e2e-'));
if (!process.env.WORKBENCH_DATA_DIR) {
  process.on('exit', () => rmSync(dataDirectory, { recursive: true, force: true }));
}

export default defineConfig({
  testDir: './e2e',
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? 'list' : 'line',
  use: { baseURL: 'http://127.0.0.1:3000', trace: 'retain-on-failure' },
  projects: [{ name: 'chrome', use: { ...devices['Desktop Chrome'], channel: 'chrome' } }],
  webServer: {
    command: 'npm run dev',
    url: 'http://127.0.0.1:3000/api/health',
    reuseExistingServer: !process.env.CI,
    timeout: 45_000,
    env: { WORKBENCH_DATA_DIR: dataDirectory },
    // Without this, Playwright kills the whole process group with SIGKILL. A child that is started in that very
    // moment survives as an orphan and keeps the output pipe open, so the run waits for it for minutes although
    // every case has passed. SIGTERM lets the dev server end in order; SIGKILL follows if it does not.
    gracefulShutdown: { signal: 'SIGTERM', timeout: 5_000 },
  },
});

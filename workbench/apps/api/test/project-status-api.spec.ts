import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { buildApp } from '../src/app.js';

test('status API reports real Git branch, HEAD and dirty state and rejects unsafe paths', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'wb-api-status-'));
  const app = buildApp();
  try {
    const root = join(temp, 'repo');
    await mkdir(root);
    execFileSync('git', ['init', '-q', root]);
    execFileSync('git', ['-C', root, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid',
      'commit', '--allow-empty', '-qm', 'initial']);
    const headSha = execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
    const branch = execFileSync('git', ['-C', root, 'symbolic-ref', '--short', 'HEAD'], { encoding: 'utf8' }).trim();
    const clean = await app.inject({ method: 'POST', url: '/api/projects/status', payload: { path: root } });
    assert.equal(clean.statusCode, 200);
    assert.deepEqual(clean.json(), { repoRoot: root, headSha, branch, dirty: false });

    await mkdir(join(root, 'untracked'));
    const dirty = await app.inject({ method: 'POST', url: '/api/projects/status', payload: { path: root } });
    // Git does not report empty untracked directories.
    assert.equal(dirty.json().dirty, false);
    const { writeFile } = await import('node:fs/promises');
    await writeFile(join(root, 'untracked', 'new.txt'), 'change');
    const changed = await app.inject({ method: 'POST', url: '/api/projects/status', payload: { path: root } });
    assert.equal(changed.statusCode, 200);
    assert.equal(changed.json().dirty, true);

    execFileSync('git', ['-C', root, 'checkout', '--detach', '-q', 'HEAD']);
    const detached = await app.inject({ method: 'POST', url: '/api/projects/status', payload: { path: root } });
    assert.equal(detached.statusCode, 200);
    assert.equal(detached.json().branch, null);
    assert.equal(detached.json().headSha, headSha);

    for (const payload of [{}, { path: 42 }, { path: join(root, 'untracked') }, { path: join(temp, 'missing') }]) {
      const response = await app.inject({ method: 'POST', url: '/api/projects/status', payload });
      assert.equal(response.statusCode, 400);
      assert.ok(!response.body.includes(temp), 'must not disclose local paths');
    }
  } finally {
    await app.close();
    await rm(temp, { recursive: true, force: true });
  }
});

import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { WorkbenchDatabase } from '../src/index.ts';

test('two independent SQLite connections cannot register the same canonical root', () => {
  const dir = mkdtempSync(join(realpathSync(tmpdir()), 'wb-project-race-'));
  const first = new WorkbenchDatabase({ dataDirectory: dir });
  let second: WorkbenchDatabase | undefined;
  try {
    second = new WorkbenchDatabase({ dataDirectory: dir });
    const root = join(dir, 'git-root');
    const registered = first.projects.create({
      slug: 'project-one', name: 'First project', repoRoot: root,
    });
    assert.equal(second.projects.findByRoot(root)?.id, registered.id);
    assert.throws(() => second!.projects.create({
      slug: 'project-two', name: 'Second project', repoRoot: root,
    }), /UNIQUE constraint failed/);
    assert.equal(first.projects.findByRoot(root)?.id, registered.id);
    assert.equal((second.connection.prepare('SELECT COUNT(*) AS count FROM projects').get() as { count: number }).count, 1);
    first.close();
    second.close();
    const reopened = new WorkbenchDatabase({ dataDirectory: dir });
    try {
      assert.equal(reopened.projects.findByRoot(root)?.id, registered.id);
    } finally {
      reopened.close();
    }
  } finally {
    first.close();
    second?.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

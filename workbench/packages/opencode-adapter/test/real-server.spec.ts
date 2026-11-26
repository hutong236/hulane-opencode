import assert from 'node:assert/strict';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, realpathSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { test } from 'node:test';
import {
  OpenCodeError, OpenCodeHttpAdapter, READONLY_AGENT_ID, VERIFIED_VERSION, connectOpenCode, readOnlyProblems,
  resolvePermission, startManagedOpenCode,
} from '../src/index.ts';
import { REAL_READONLY_RULES, shown } from './rules.ts';

/**
 * The same adapter against a real OpenCode server, started here from the installed CLI in a temporary repository
 * with its own data, config and state directories, so that nothing of the developer's own OpenCode is read or
 * written. No model is configured there: the prompt is queued and the user's message is read back, and the model's
 * answer is not part of this check.
 */
const CLI = process.env.OPENCODE_BIN ?? 'opencode';
/** `opencode v2.2.7` as the CLI prints it, or null when there is no such program. */
function cliVersion(): string | null {
  try {
    const printed = execFileSync(CLI, ['--version'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    // The CLI colors its output, on a terminal or not.
    return printed.replace(/\u001b\[[0-9;]*m/g, '').trim();
  } catch { return null; }
}
const installed = cliVersion();
const expected = `opencode v${VERIFIED_VERSION}`;

/** Every file below a directory, apart from Git's own. */
function files(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    if (entry.name === '.git') return [];
    if (entry.isDirectory()) return [`${entry.name}/`, ...files(join(directory, entry.name)).map(name => `${entry.name}/${name}`)];
    return [entry.name];
  }).sort();
}

const freePort = (): Promise<number> => new Promise((resolve, reject) => {
  const probe = createServer();
  probe.once('error', reject);
  probe.listen(0, '127.0.0.1', () => {
    const address = probe.address();
    const port = address && typeof address === 'object' ? address.port : 0;
    probe.close(() => resolve(port));
  });
});

test('the adapter talks to a real OpenCode server of the verified version', { skip: installed !== expected, timeout: 90_000 }, async () => {
  const lab = mkdtempSync(join(realpathSync(tmpdir()), 'wb-oc-real-'));
  const repo = join(lab, 'repo');
  execFileSync('git', ['init', '-q', '-b', 'main', repo]);
  const password = randomBytes(12).toString('hex');
  const port = await freePort();
  const origin = `http://127.0.0.1:${port}`;
  const child: ChildProcess = spawn(CLI, ['serve', '--hostname', '127.0.0.1', '--port', String(port)], {
    cwd: repo,
    env: {
      ...process.env, OPENCODE_PASSWORD: password,
      XDG_DATA_HOME: join(lab, 'data'), XDG_CONFIG_HOME: join(lab, 'config'),
      XDG_STATE_HOME: join(lab, 'state'), XDG_CACHE_HOME: join(lab, 'cache'),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout?.on('data', (chunk: Buffer) => { output = (output + chunk.toString()).slice(-4_096); });
  child.stderr?.on('data', (chunk: Buffer) => { output = (output + chunk.toString()).slice(-4_096); });
  const exited = new Promise<void>(resolve => child.once('exit', () => resolve()));
  const kill = async () => { child.kill('SIGTERM'); await exited; };
  const directory = realpathSync(repo);
  const adapter = new OpenCodeHttpAdapter({ baseUrl: origin, directory, password, timeoutMs: 15_000 });
  try {
    let info: { version: string; pid: number; hostname: string } | undefined;
    for (let attempt = 0; attempt < 120 && !info; attempt++) {
      if (child.exitCode !== null) throw new Error(`The real server exited while starting:\n${output}`);
      await new Promise(resolve => setTimeout(resolve, 250));
      // Until it listens, nothing answers; that is the `unavailable` this adapter reports.
      await adapter.info().then(value => { info = value; }, () => undefined);
    }
    assert.ok(info, `The real server did not answer in 30 s:\n${output}`);
    assert.equal(info.version, VERIFIED_VERSION);
    assert.equal(info.pid, child.pid, 'the pid the server reports is the one that was started');

    const session = await adapter.createSession({ title: 'adapter smoke' });
    assert.equal(session.directory, directory);
    assert.match(session.id, /^ses_/);
    assert.equal((await adapter.getSession(session.id))?.title, 'adapter smoke');

    // The server lists sessions of every directory together; the other project's adapter does not see this one.
    const elsewhere = new OpenCodeHttpAdapter({ baseUrl: origin, directory: join(lab, 'elsewhere'), password });
    assert.equal(await elsewhere.getSession(session.id), null);
    await assert.rejects(elsewhere.sendPrompt(session.id, { text: 'x' }), (error: unknown) =>
      error instanceof OpenCodeError && error.kind === 'not_found');

    // Events: the first one says that the server is there.
    const controller = new AbortController();
    const first = (async (): Promise<{ type?: string } | undefined> => {
      for await (const event of adapter.subscribeEvents(controller.signal)) return event;
    })();
    let quietTimer: NodeJS.Timeout | undefined;
    const quiet = new Promise<null>(resolve => { quietTimer = setTimeout(() => resolve(null), 10_000); });
    try {
      const event = await Promise.race<{ type?: string } | null | undefined>([first, quiet]);
      controller.abort();
      assert.equal(event?.type, 'server.connected');
    } finally { clearTimeout(quietTimer); }

    const sent = await adapter.sendPrompt(session.id, { text: 'List the files of this repository.' });
    assert.equal(sent.type, 'user');
    assert.equal(sent.text, 'List the files of this repository.');
    assert.equal(sent.sessionID, session.id);
    const messages = await adapter.getMessages(session.id);
    assert.ok(messages.some(message => message.id === sent.id && message.type === 'user'));

    const stopped = await adapter.abort(session.id);
    assert.equal(typeof stopped.interrupted, 'boolean');

    // A wrong password is refused by the real server.
    await assert.rejects(new OpenCodeHttpAdapter({ baseUrl: origin, directory, password: 'wrong' }).info(),
      (error: unknown) => error instanceof OpenCodeError && error.kind === 'unauthorized');

    // Attached to as a server someone else started: the verified version, and no read-only agent, as it was
    // given none.
    const attached = await connectOpenCode({ baseUrl: origin, directory, password });
    assert.equal(attached.readOnly, false);
    assert.deepEqual(attached.problems, ['there is no agent named "workbench-readonly"']);
  } finally {
    await kill();
    rmSync(lab, { recursive: true, force: true });
  }
});

test('a real server of another version than the verified one is not used silently', { skip: installed === null || installed === expected }, () => {
  assert.fail(`OpenCode ${installed} is installed; this adapter was read from ${expected}. Read the new version and update the adapter.`);
});

test('a managed server comes from the real CLI checked, and its sessions outlive it',
  { skip: installed !== expected, timeout: 120_000 }, async () => {
    const lab = mkdtempSync(join(realpathSync(tmpdir()), 'wb-oc-real-'));
    const repo = join(lab, 'repo');
    execFileSync('git', ['init', '-q', '-b', 'main', repo]);
    const directory = realpathSync(repo);
    // Its own data, config and state: nothing of the developer's OpenCode is read or written, and what it keeps is
    // still there for the next server.
    const env = {
      XDG_DATA_HOME: join(lab, 'data'), XDG_CONFIG_HOME: join(lab, 'config'),
      XDG_STATE_HOME: join(lab, 'state'), XDG_CACHE_HOME: join(lab, 'cache'),
    };
    const start = () => startManagedOpenCode({ directory, command: [CLI], env, startTimeoutMs: 60_000 });
    let first: Awaited<ReturnType<typeof start>> | undefined;
    let second: Awaited<ReturnType<typeof start>> | undefined;
    try {
      first = await start();
      assert.match(first.baseUrl, /^http:\/\/127\.0\.0\.1:[1-9]\d*$/);
      assert.deepEqual([first.directory, first.version], [directory, VERIFIED_VERSION]);
      assert.equal((await first.adapter.info()).pid, first.pid);
      assert.equal(await first.check(), 'running');
      // The system says it is this process's child, started as `serve --hostname 127.0.0.1 --port 0`.
      assert.equal(first.identity?.parent, process.pid);
      assert.match(first.identity?.command ?? '', /serve --hostname 127\.0\.0\.1 --port 0$/);

      // The read-only agent came from the environment. These are the rules the real server computed for it.
      await first.adapter.listAgents();
      const rules = (await first.adapter.getAgent(READONLY_AGENT_ID))?.permissions;
      assert.ok(rules, 'the real server has no read-only agent');
      assert.equal(shown(rules), REAL_READONLY_RULES);
      const expectations: Array<[string, string, string]> = [
        ['read', '/repo/README.md', 'allow'], ['read', '/repo/.env', 'ask'], ['read', '/repo/config/.env.production', 'ask'],
        ['edit', '/repo/src/app.ts', 'deny'], ['shell', '/repo/src/app.ts', 'deny'], ['grep', '/repo/src/app.ts', 'deny'],
        ['subagent', '/repo/src/app.ts', 'deny'], ['a-tool-nobody-has-heard-of', '/repo/src/app.ts', 'deny'],
      ];
      for (const [action, file, effect] of expectations) {
        assert.equal(resolvePermission(rules, action, file), effect, `${action} ${file}`);
      }

      // The built-in `plan` agent calls itself read-only and is not: it leaves `shell` allowed.
      const plan = await first.adapter.getAgent('plan');
      assert.ok(plan?.permissions.some(rule => rule.action === 'edit' && rule.effect === 'deny'));
      assert.ok(readOnlyProblems(plan!).includes('shell is not denied'), shown(plan!.permissions));

      const session = await first.adapter.createSession({ title: 'before the restart' });
      assert.equal(session.directory, directory);
      // None of this wrote anything into the project.
      assert.deepEqual(files(repo), []);
      await first.stop();
      assert.equal(first.running, false);
      assert.ok(existsSync(join(lab, 'data', 'opencode')), 'the server kept its data where it was told to');

      // Another server for the same project, on the same data: the session is still there to be read.
      second = await start();
      assert.notEqual(second.pid, first.pid);
      assert.equal((await second.adapter.getSession(session.id))?.title, 'before the restart');
      assert.deepEqual(files(repo), []);
    } finally {
      // Whatever is still there is asked to end, and killed if it did not; the lab goes with it.
      for (const server of [second, first]) {
        await server?.stop().catch(() => undefined);
        server?.killNow();
      }
      rmSync(lab, { recursive: true, force: true });
    }
  });

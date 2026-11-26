import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test, type TestContext } from 'node:test';
import {
  OpenCodeError, RunningOpenCodeServer, ServerStartError, VERIFIED_VERSION, connectOpenCode, describeProcess,
  managedConfigContent, startManagedOpenCode,
  type ManagedServerOptions, type OpenCodeErrorKind,
} from '../src/index.ts';
import { startMockOpenCode } from './mock-server.mjs';

/**
 * The managed server against a program that stands in for `opencode serve`. The real one is started in
 * `real-server.spec.ts`, wherever the CLI is installed.
 */
const FAKE: readonly string[] = [process.execPath, fileURLToPath(new URL('./fake-opencode.mjs', import.meta.url))];
const LOOPBACK = /^http:\/\/127\.0\.0\.1:[1-9]\d*$/;
const ONE = '/projects/one';

interface Scratch { root: string; project: string; receipt: string; cleanup(): void }

/** A project directory of the test's own, and where the fake writes what it was started with. Removed with the test. */
function scratch(t: TestContext): Scratch {
  const root = realpathSync(mkdtempSync(join(realpathSync(tmpdir()), 'wb-managed-')));
  const project = join(root, 'project');
  mkdirSync(project);
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return { root, project, receipt: join(root, 'receipt.json'), cleanup: () => rmSync(root, { recursive: true, force: true }) };
}
/**
 * Ends the server with the test, however the test ends. SIGKILL comes last, so that a server which ignored SIGTERM,
 * or a test of stopping that was cut short, leaves no process behind.
 */
function stopsWith(t: TestContext, server: RunningOpenCodeServer): void {
  t.after(async () => {
    await server.stop().catch(() => undefined);
    server.killNow();
  });
}
const start = (s: Scratch, env: NodeJS.ProcessEnv = {}, options: Partial<ManagedServerOptions> = {}) =>
  startManagedOpenCode({
    command: FAKE, directory: s.project, env: { FAKE_OPENCODE_RECEIPT: s.receipt, ...env }, ...options,
  });
interface Receipt { cwd: string; pid: number; argv: string[]; configContent: string | null }
const receiptOf = (s: Scratch): Receipt => JSON.parse(readFileSync(s.receipt, 'utf8'));
/** Every file below a directory, sorted. */
function files(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    if (entry.isDirectory()) return [`${entry.name}/`, ...files(join(directory, entry.name)).map(name => `${entry.name}/${name}`)];
    return [entry.name];
  }).sort();
}
function gone(pid: number): boolean {
  try { process.kill(pid, 0); return false; } catch { return true; }
}
/** Runs a start that must fail, and returns what it failed with. One that does not fail is stopped first. */
async function failing(run: () => Promise<unknown>): Promise<ServerStartError> {
  let outcome: unknown;
  try { outcome = await run(); }
  catch (error) {
    assert.ok(error instanceof ServerStartError, `not a ServerStartError: ${String(error)}`);
    return error;
  }
  const started = outcome instanceof RunningOpenCodeServer ? outcome : undefined;
  await started?.stop();
  started?.killNow();
  return assert.fail(`the start was expected to fail, and gave ${started ? `a server on ${started.baseUrl}` : String(outcome)}`) as never;
}
const kindOf = (error: unknown): OpenCodeErrorKind | undefined => (error instanceof OpenCodeError ? error.kind : undefined);
const status = async (url: string, headers: Record<string, string>): Promise<number> => {
  const response = await fetch(url, { headers });
  await response.arrayBuffer();
  return response.status;
};

test('a managed server is started in the project, with its own password and the read-only agent, and is what it says',
  { timeout: 30_000 }, async (t) => {
    const s = scratch(t);
    const server = await start(s, { OPENCODE_PASSWORD: 'from-the-environment' });
    stopsWith(t, server);
    assert.match(server.baseUrl, LOOPBACK);
    assert.deepEqual([server.directory, server.version], [s.project, VERIFIED_VERSION]);
    assert.equal(await server.check(), 'running');
    assert.equal((await server.adapter.info()).pid, server.pid);

    // Started as `serve --hostname 127.0.0.1 --port 0`, in the project, by this process.
    const receipt = receiptOf(s);
    assert.deepEqual([receipt.cwd, receipt.pid, receipt.argv],
      [s.project, server.pid, ['serve', '--hostname', '127.0.0.1', '--port', '0']]);
    assert.deepEqual(Object.keys(JSON.parse(receipt.configContent ?? '').agent), ['workbench-readonly']);
    assert.equal(server.identity?.parent, process.pid);
    assert.match(server.identity?.command ?? '', /fake-opencode\.mjs serve --hostname 127\.0\.0\.1 --port 0$/);

    // Its password is made for it: not the environment's, and nothing without it is let in.
    const headers = { 'x-opencode-directory': s.project };
    const basic = (password: string): Record<string, string> => ({
      ...headers, authorization: `Basic ${Buffer.from(`opencode:${password}`).toString('base64')}`,
    });
    assert.equal(await status(`${server.baseUrl}/api/info`, headers), 401);
    assert.equal(await status(`${server.baseUrl}/api/info`, basic('from-the-environment')), 401);
    // It works for the project, and nothing was written into the project to get it.
    const session = await server.adapter.createSession({ title: 'Look around' });
    assert.equal(session.directory, s.project);
    assert.deepEqual(files(s.project), []);

    await server.stop();
    assert.deepEqual([server.running, await server.check()], [false, 'exited']);
    assert.ok(gone(server.pid), `process ${server.pid} is still there`);
  });

test('a managed server keeps the configuration its environment had, with the read-only agent added to it',
  { timeout: 30_000 }, async (t) => {
    const s = scratch(t);
    const own = JSON.stringify({ model: 'one/two', agent: { mine: { mode: 'subagent' } } });
    const server = await start(s, { OPENCODE_CONFIG_CONTENT: own });
    stopsWith(t, server);
    const content = JSON.parse(receiptOf(s).configContent ?? '');
    assert.deepEqual([content.model, content.agent.mine, Object.keys(content.agent).sort()],
      ['one/two', { mode: 'subagent' }, ['mine', 'workbench-readonly']]);
    assert.deepEqual((await server.adapter.listAgents()).map(agent => agent.id),
      ['build', 'compaction', 'title', 'summary', 'plan', 'mine', 'workbench-readonly']);
  });

/** A start that runs something first, as a directory that is moved at that very moment. */
function disappearing(first: (directory: string) => void): typeof spawn {
  return ((command: string, args: readonly string[], options: { cwd?: string }) => {
    if (options?.cwd) first(options.cwd);
    return spawn(command, args, options);
  }) as unknown as typeof spawn;
}

interface WayToFail {
  name: string;
  env?: NodeJS.ProcessEnv;
  options?: Partial<ManagedServerOptions>;
  /** Runs just before the program is started, with the project directory. */
  beforeSpawn?: (directory: string) => void;
  directory?: string;
  kind: OpenCodeErrorKind;
  says?: RegExp;
  output?: RegExp;
}
/** What a server says when what it printed is not the address it was asked for. */
const NOT_THERE = /did not say where it listens/;
const WAYS_TO_FAIL: readonly WayToFail[] = [
  { name: 'a program that is not there', options: { command: ['/nonexistent/opencode'] }, kind: 'not_installed', says: /nonexistent\/opencode/ },
  { name: 'a directory that is gone', directory: 'missing', kind: 'directory_unavailable' },
  {
    name: 'a directory that goes between the check and the start',
    beforeSpawn: (directory) => rmSync(directory, { recursive: true, force: true }),
    kind: 'directory_unavailable',
  },
  { name: 'a server that ends at once', env: { FAKE_OPENCODE_EXIT: '3' }, kind: 'exited', says: /code 3/, output: /ServeError/ },
  // Each of these is refused for what it said, before anything is asked of that address.
  { name: 'a server that says it listens on another host', env: { FAKE_OPENCODE_PRINT_ADDRESS: 'http://[::1]:4096' }, kind: 'protocol', says: NOT_THERE },
  { name: 'a server that says it listens on port 0', env: { FAKE_OPENCODE_PRINT_ADDRESS: 'http://127.0.0.1:0' }, kind: 'protocol', says: NOT_THERE },
  { name: 'a server that says it listens under a path', env: { FAKE_OPENCODE_PRINT_ADDRESS: 'http://127.0.0.1:4096/path' }, kind: 'protocol', says: NOT_THERE },
  { name: 'a server that does not say where it listens', env: { FAKE_OPENCODE_PRINT_ADDRESS: 'nowhere' }, kind: 'protocol', says: NOT_THERE },
  { name: 'a server that never says it listens', env: { FAKE_OPENCODE_HANG: '1' }, options: { startTimeoutMs: 800 }, kind: 'timeout' },
  { name: 'another version', env: { FAKE_OPENCODE_VERSION: '2.3.0' }, kind: 'incompatible_version', says: /2\.3\.0/ },
  { name: 'a server that reports another process', env: { FAKE_OPENCODE_PID: '4242' }, kind: 'pid_mismatch' },
  { name: 'no read-only agent', env: { FAKE_OPENCODE_AGENT: 'none' }, kind: 'readonly_agent', says: /no agent named/ },
  { name: 'a read-only agent that may edit', env: { FAKE_OPENCODE_AGENT: 'unsafe' }, kind: 'readonly_agent', says: /edit is not denied/ },
  { name: 'an agent configured under `agents`', env: { FAKE_OPENCODE_AGENT: 'agents-key' }, kind: 'readonly_agent' },
];

test('what cannot be started is said why, and leaves no process behind', { timeout: 60_000 }, async (t) => {
  for (const way of WAYS_TO_FAIL) {
    const s = scratch(t);
    const error = await failing(() => start(s, way.env, {
      // Unless a case says otherwise, nothing is waited for longer than this.
      startTimeoutMs: 5_000, ...way.options, ...(way.directory ? { directory: join(s.root, way.directory) } : {}),
      ...(way.beforeSpawn ? { spawn: disappearing(way.beforeSpawn) } : {}),
    }));
    assert.equal(error.kind, way.kind, `${way.name}: ${error.message}`);
    if (way.says) assert.match(error.message, way.says, way.name);
    if (way.output) assert.match(error.output, way.output, way.name);
    // Whatever was started is gone: the receipt is written before the fake does anything else.
    if (existsSync(s.receipt)) assert.ok(gone(receiptOf(s).pid), `${way.name}: its process is still there`);
    s.cleanup();
  }
});

test('a server is started only on this machine, and only in a directory that is there', async (t) => {
  const s = scratch(t);
  const refuse = (options: Partial<ManagedServerOptions>) => failing(() => start(s, {}, options));
  assert.equal((await refuse({ hostname: '0.0.0.0' })).kind, 'invalid_request');
  assert.equal((await refuse({ directory: 'relative/path' })).kind, 'invalid_request');
  writeFileSync(join(s.root, 'file'), '');
  assert.equal((await refuse({ directory: join(s.root, 'file') })).kind, 'directory_unavailable');
  assert.equal(existsSync(s.receipt), false, 'nothing was started');
});

test('a server whose first listing is empty, or whose agent is still loading, is still given out', { timeout: 30_000 }, async (t) => {
  // Right after a start the real server answers the first listing with an empty list; the agent is found by name all the same.
  const slow = await start(scratch(t), { FAKE_OPENCODE_AGENT: 'slow' });
  stopsWith(t, slow);
  assert.equal(await slow.check(), 'running');
  await slow.stop();
  assert.ok(gone(slow.pid));
  // An agent that is not there yet is asked for again, for a moment.
  const late = await start(scratch(t), { FAKE_OPENCODE_AGENT: 'late' });
  stopsWith(t, late);
  assert.equal((await late.adapter.getAgent('workbench-readonly'))?.mode, 'primary');
});

test('a server that ignores SIGTERM is killed', { timeout: 30_000 }, async (t) => {
  const server = await start(scratch(t), { FAKE_OPENCODE_IGNORE_SIGTERM: '1' }, { stopTimeoutMs: 300 });
  stopsWith(t, server);
  const ended = server.exited;
  await server.stop();
  assert.deepEqual([server.running, gone(server.pid)], [false, true]);
  assert.equal((await ended).signal, 'SIGKILL');
});

test('a server can be killed at once, for when the Workbench itself ends and cannot wait', { timeout: 30_000 }, async (t) => {
  const server = await start(scratch(t));
  stopsWith(t, server);
  server.killNow();
  assert.equal((await server.exited).signal, 'SIGKILL');
  assert.deepEqual([server.running, gone(server.pid)], [false, true]);
});

test('a server that ends on its own is reported as ended, and whoever listens is told how', { timeout: 30_000 }, async (t) => {
  const server = await start(scratch(t));
  stopsWith(t, server);
  const told = new Promise<unknown>((resolve) => { server.onExit(resolve); });
  process.kill(server.pid, 'SIGKILL');
  assert.equal((await told as { signal: string }).signal, 'SIGKILL');
  assert.deepEqual([await server.check(), server.running], ['exited', false]);
});

test('a process that is alive but no longer the one answering is not asked anything more', { timeout: 30_000 }, async (t) => {
  const server = await start(scratch(t));
  stopsWith(t, server);
  let impostor: Awaited<ReturnType<typeof startMockOpenCode>> | undefined;
  t.after(async () => { await impostor?.close(); });
  try {
    // The process gives up its port and stays alive; another server takes the port.
    process.kill(server.pid, 'SIGUSR1');
    for (let attempt = 0; attempt < 100; attempt++) {
      if (await status(`${server.baseUrl}/api/info`, {}).catch(() => 0) === 0) break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    impostor = await startMockOpenCode({ port: Number(new URL(server.baseUrl).port) });
    assert.equal(server.running, true);
    assert.equal(await server.check(), 'replaced');
  } finally {
    await impostor?.close();
  }
});

test('what a server prints is kept for a diagnosis, without its password', { timeout: 30_000 }, async (t) => {
  const server = await start(scratch(t), { FAKE_OPENCODE_PRINT_PASSWORD: '1' });
  stopsWith(t, server);
  assert.match(server.diagnostics(), /server password \[password\]/);
  assert.doesNotMatch(server.diagnostics(), /server password [A-Za-z0-9_-]{8,}/);
});

test('a server someone else started is attached to as it is, and only in the verified version', async () => {
  const withAgent = await startMockOpenCode({ password: 'secret', configContent: managedConfigContent(undefined) });
  try {
    const attached = await connectOpenCode({ baseUrl: withAgent.origin, directory: ONE, password: 'secret' });
    assert.deepEqual([attached.readOnly, attached.problems, attached.info.pid], [true, [], process.pid]);
    // There too the agents may come late.
    withAgent.agentDirectories.clear();
    withAgent.agentFirstListEmpty = true;
    const again = await connectOpenCode({
      baseUrl: withAgent.origin, directory: ONE, password: 'secret', readyTimeoutMs: 3_000,
    });
    assert.equal(again.readOnly, true);
    await assert.rejects(
      connectOpenCode({ baseUrl: withAgent.origin, directory: ONE }),
      (error: unknown) => kindOf(error) === 'unauthorized',
    );
    withAgent.version = '2.3.0';
    await assert.rejects(
      connectOpenCode({ baseUrl: withAgent.origin, directory: ONE, password: 'secret' }),
      (error: unknown) => kindOf(error) === 'incompatible_version',
    );
    // An address that is not an origin is refused before anything is asked of it.
    withAgent.version = VERIFIED_VERSION;
    await assert.rejects(
      connectOpenCode({ baseUrl: `${withAgent.origin}/path`, directory: ONE }),
      (error: unknown) => kindOf(error) === 'protocol',
    );
  } finally { await withAgent.close(); }

  // One without the read-only agent is still attached to, and it is said that it has none.
  const plain = await startMockOpenCode();
  try {
    const attached = await connectOpenCode({ baseUrl: plain.origin, directory: ONE, agentGraceMs: 300 });
    assert.equal(attached.readOnly, false);
    assert.deepEqual(attached.problems, ['there is no agent named "workbench-readonly"']);
    // The list was asked first, the agent by name after it, and again for a moment. Nothing was written.
    assert.deepEqual(plain.requests.slice(0, 3).map(request => `${request.method} ${request.path}`),
      ['GET /api/info', 'GET /api/agent', 'GET /api/agent/workbench-readonly']);
    assert.ok(plain.requests.every(request => request.method === 'GET'), 'something was written to the server');
  } finally { await plain.close(); }

  // Nothing there.
  const probe = createServer();
  await new Promise<void>((resolve) => { probe.listen(0, '127.0.0.1', () => resolve()); });
  const { port } = probe.address() as { port: number };
  await new Promise<void>((resolve) => { probe.close(() => resolve()); });
  await assert.rejects(
    connectOpenCode({ baseUrl: `http://127.0.0.1:${port}`, directory: ONE }),
    (error: unknown) => kindOf(error) === 'unavailable',
  );
});

test('a process is told from another that gets its number later, where the system can say', async () => {
  const self = await describeProcess(process.pid);
  assert.ok(self, 'ps says nothing about this process');
  assert.equal(self.parent, process.ppid);
  assert.match(self.started, /^\w{3} +(?:\w{3} +)?\d+ \d\d:\d\d:\d\d \d{4}$/);
  assert.ok(self.command.length > 0);
  // Beyond the largest process number macOS or Linux gives out.
  assert.equal(await describeProcess(2_147_483_646), null);
});

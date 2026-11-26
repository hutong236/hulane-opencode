import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import {
  chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync,
} from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { test, type TestContext } from 'node:test';
import { WorkbenchDatabase, type OpenCodeServerRecord } from '@hulane/workbench-database';
import { describeProcess, connectOpenCode, managedConfigContent, type ProcessIdentity } from '@hulane/workbench-opencode-adapter';
import { startMockOpenCode } from '../../../packages/opencode-adapter/test/mock-server.mjs';
import { buildApp } from '../src/app.js';
import type { OpenCodeOptions } from '../src/opencode.js';

/** The program that stands in for `opencode`, as the adapter's own tests start it. */
const FAKE: readonly string[] = [
  process.execPath, fileURLToPath(new URL('../../../packages/opencode-adapter/test/fake-opencode.mjs', import.meta.url)),
];
const NO_PROJECT = '99999999-9999-4999-8999-999999999999';
const BAD_ID = 'not-an-id';
const url = (id: string) => `/api/projects/${id}/opencode/server`;

function gone(pid: number): boolean {
  try { process.kill(pid, 0); return false; } catch { return true; }
}
/** A process that has ended: its number is free again. */
async function endedProcess(): Promise<number> {
  const child = spawn(process.execPath, ['-e', '']);
  const pid = child.pid as number;
  await new Promise<void>((resolve) => { child.once('exit', () => resolve()); });
  return pid;
}
/** Reads `look` until it satisfies `is`, for up to five seconds, and returns what it last read. */
async function until<T>(look: () => Promise<T>, is: (value: T) => boolean): Promise<T> {
  let value = await look();
  for (let attempt = 0; attempt < 100 && !is(value); attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 50));
    value = await look();
  }
  return value;
}
/** What `promise` settles to, or `fallback` when it has not settled in `ms`. Its timer does not outlive it. */
async function within<T>(promise: Promise<T>, ms: number, fallback: T): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([promise, new Promise<T>((resolve) => { timer = setTimeout(() => resolve(fallback), ms); })]);
  } finally { clearTimeout(timer); }
}
/** The address of a port that was just let go: nothing listens there. */
async function nowhere(): Promise<string> {
  const probe = createServer();
  await new Promise<void>((resolve) => { probe.listen(0, '127.0.0.1', () => resolve()); });
  const { port } = probe.address() as { port: number };
  await new Promise<void>((resolve) => { probe.close(() => resolve()); });
  return `http://127.0.0.1:${port}`;
}
/**
 * Starts the fake the way an earlier Workbench process would have left it: its parent gone, so it belongs to the
 * system. Its number is written to `receipt`.
 */
async function leftoverFake(root: string, receipt: string): Promise<number> {
  const launcher = spawn(process.execPath, [
    '-e',
    `const { spawn } = require('node:child_process'); spawn(process.execPath, [${JSON.stringify(FAKE[1])}, ...process.argv.slice(1)], { detached: true, stdio: 'ignore', env: process.env }).unref();`,
    'serve', '--hostname', '127.0.0.1', '--port', '0',
  ], { cwd: root, env: { ...process.env, FAKE_OPENCODE_ORPHAN: '1', FAKE_OPENCODE_RECEIPT: receipt }, stdio: 'ignore' });
  await new Promise<void>((resolve) => { launcher.once('exit', () => resolve()); });
  for (let attempt = 0; attempt < 100; attempt++) {
    if (existsSync(receipt)) return (JSON.parse(readFileSync(receipt, 'utf8')) as { pid: number }).pid;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return assert.fail('the leftover server did not start') as never;
}

interface Answer { statusCode: number; body: string; json(): any }

interface Harness {
  app: ReturnType<typeof buildApp>;
  database: WorkbenchDatabase;
  temp: string;
  register(slug: string): Promise<{ id: string; root: string }>;
  call(method: 'GET' | 'POST' | 'DELETE', url: string, payload?: Record<string, unknown>): Promise<Answer>;
}

async function harness(t: TestContext, opencode: OpenCodeOptions = {}): Promise<Harness> {
  const temp = mkdtempSync(join(realpathSync(tmpdir()), 'wb-oc-api-'));
  const database = new WorkbenchDatabase({ dataDirectory: join(temp, 'data') });
  const app = buildApp({ database, opencode: { command: FAKE, startTimeoutMs: 10_000, ...opencode } });
  // Every fake started for this test leaves a mark while it runs. A server that a failing case left running is
  // killed at the end, so that it does not keep the test process alive.
  const marks = join(temp, 'running');
  mkdirSync(marks);
  fakeVariables(t, { FAKE_OPENCODE_PIDS: marks });
  t.after(async () => {
    await app.close();
    for (const mark of readdirSync(marks)) {
      try { process.kill(Number(mark), 'SIGKILL'); } catch { /* gone */ }
    }
    rmSync(temp, { recursive: true, force: true });
  });
  return {
    app, database, temp,
    register: async (slug: string) => {
      const root = join(temp, slug);
      mkdirSync(root);
      execFileSync('git', ['init', '-q', '-b', 'main', root]);
      execFileSync('git', ['-C', root, '-c', 'user.name=t', '-c', 'user.email=t@example.invalid', 'commit', '-q', '--allow-empty', '-m', 'init']);
      const response = await app.inject({ method: 'POST', url: '/api/projects', payload: { path: root, slug, name: slug } });
      assert.equal(response.statusCode, 201, response.body);
      return { id: (response.json() as { id: string }).id, root: realpathSync(root) };
    },
    call: async (method, path, payload) => {
      const response = await app.inject({ method, url: path, ...(payload === undefined ? {} : { payload }) });
      return { statusCode: response.statusCode, body: response.body, json: () => response.json() };
    },
  };
}
const beforeTheTest = new WeakMap<TestContext, Map<string, string | undefined>>();
/**
 * Sets variables the fake reads. Whatever they were before the test began is put back when the test ends, however
 * often this is called. An empty or undefined value takes the variable away.
 */
function fakeVariables(t: TestContext, variables: NodeJS.ProcessEnv): void {
  let saved = beforeTheTest.get(t);
  if (!saved) {
    const restore = new Map<string, string | undefined>();
    beforeTheTest.set(t, restore);
    t.after(() => {
      for (const [key, value] of restore) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    });
    saved = restore;
  }
  for (const [key, value] of Object.entries(variables)) {
    if (!saved.has(key)) saved.set(key, process.env[key]);
    if (!value) delete process.env[key];
    else process.env[key] = value;
  }
}
/** Every switch the fake reads, starting from none of them set. */
const fakeSwitches = (variables: NodeJS.ProcessEnv): NodeJS.ProcessEnv => ({
  FAKE_OPENCODE_RECEIPT: undefined, FAKE_OPENCODE_EXIT: undefined, FAKE_OPENCODE_READY_DELAY_MS: undefined,
  FAKE_OPENCODE_HANG: undefined, FAKE_OPENCODE_VERSION: undefined, FAKE_OPENCODE_PID: undefined,
  FAKE_OPENCODE_IGNORE_SIGTERM: undefined, FAKE_OPENCODE_PRINT_PASSWORD: undefined,
  FAKE_OPENCODE_PRINT_ADDRESS: undefined, FAKE_OPENCODE_AGENT: undefined, FAKE_OPENCODE_ORPHAN: undefined,
  ...variables,
});
const rowsOf = (database: WorkbenchDatabase) =>
  database.connection.prepare('SELECT * FROM opencode_servers ORDER BY rowid').all() as Record<string, unknown>[];

test('a managed server is started in the registered root, asked about, and stopped', { timeout: 60_000 }, async (t) => {
  const h = await harness(t);
  const { id, root } = await h.register('one');
  const receipt = join(h.temp, 'receipt.json');
  fakeVariables(t, fakeSwitches({ FAKE_OPENCODE_RECEIPT: receipt }));
  // Nothing is known of a server for the project.
  assert.deepEqual((await h.call('GET', url(id))).json(), { server: null, held: false });

  const started = await h.call('POST', url(id), { mode: 'managed' });
  assert.equal(started.statusCode, 201, started.body);
  const server = started.json().server as OpenCodeServerRecord;
  assert.deepEqual(
    [server.project_id, server.kind, server.state, server.directory, server.readonly_agent, server.owner_pid, server.version],
    [id, 'managed', 'running', root, true, process.pid, '2.2.7'],
  );
  assert.match(server.base_url ?? '', /^http:\/\/127\.0\.0\.1:[1-9]\d*$/);
  assert.ok(server.pid && server.pid !== process.pid, 'the record names no process of its own');
  assert.ok(server.pid_started, 'the record has no start time for the process');
  // The answer and the record tell everything about the server but how to talk to it.
  assert.doesNotMatch(started.body, /password/i);
  assert.equal(JSON.stringify(rowsOf(h.database)).includes('password'), false);
  // It was started in the registered root, and it is the process the record names.
  const written = JSON.parse(readFileSync(receipt, 'utf8'));
  assert.deepEqual([written.cwd, written.pid], [root, server.pid]);

  // Asked about: running, and held by this process. A second start is refused, not started.
  assert.deepEqual((await h.call('GET', url(id))).json(), { server, held: true });
  const again = await h.call('POST', url(id), { mode: 'managed' });
  assert.deepEqual([again.statusCode, again.json().reason], [409, 'already_running']);

  const stopped = await h.call('DELETE', url(id));
  assert.deepEqual([stopped.statusCode, stopped.json().result, stopped.json().server.state, stopped.json().server.ended_at !== null],
    [200, 'stopped', 'stopped', true]);
  assert.ok(gone(server.pid as number), 'the process is still there');
  assert.deepEqual((await h.call('GET', url(id))).json(), { server: stopped.json().server, held: false });
  assert.equal((await h.call('DELETE', url(id))).statusCode, 404);

  // Another one is a new process under the same record.
  const second = (await h.call('POST', url(id), { mode: 'managed' })).json().server as OpenCodeServerRecord;
  assert.deepEqual([second.id === server.id, second.pid !== server.pid, second.state, second.ended_at], [true, true, 'running', null]);
});

test('two projects have two servers, each in its own root, and stopping one leaves the other', { timeout: 60_000 }, async (t) => {
  const h = await harness(t);
  const one = await h.register('one');
  const two = await h.register('two');
  const starts: Array<[number, { cwd: string }]> = [];
  for (const [index, project] of [one, two].entries()) {
    const receipt = join(h.temp, `receipt-${index}.json`);
    fakeVariables(t, fakeSwitches({ FAKE_OPENCODE_RECEIPT: receipt }));
    const response = await h.call('POST', url(project.id), { mode: 'managed' });
    assert.equal(response.statusCode, 201, response.body);
    starts.push([Number((response.json().server as OpenCodeServerRecord).pid), JSON.parse(readFileSync(receipt, 'utf8'))]);
  }
  const [first, second] = starts;
  assert.notEqual(first[0], second[0]);
  assert.deepEqual([first[1].cwd, second[1].cwd], [one.root, two.root]);
  // Each project is told about its own server only.
  const seen = await Promise.all([one, two].map(async (project) => (await h.call('GET', url(project.id))).json().server.pid));
  assert.deepEqual(seen, [first[0], second[0]]);
  assert.equal((await h.call('DELETE', url(one.id))).statusCode, 200);
  assert.deepEqual([gone(first[0]), gone(second[0])], [true, false]);
  assert.equal((await h.call('GET', url(two.id))).json().held, true);
});

test('a start that fails is said why, kept as what it was, and leaves nothing behind', { timeout: 60_000 }, async (t) => {
  const ways: Array<{ name: string; opencode?: OpenCodeOptions; env?: NodeJS.ProcessEnv; status: number; reason: string }> = [
    { name: 'no program to start it', opencode: { command: ['/nonexistent/opencode'] }, status: 503, reason: 'not_installed' },
    { name: 'it never says it listens', env: { FAKE_OPENCODE_HANG: '1' }, status: 503, reason: 'timeout' },
    { name: 'another version', env: { FAKE_OPENCODE_VERSION: '2.3.0' }, status: 503, reason: 'incompatible_version' },
    { name: 'no read-only agent', env: { FAKE_OPENCODE_AGENT: 'none' }, status: 503, reason: 'readonly_agent' },
    { name: 'a read-only agent that may edit', env: { FAKE_OPENCODE_AGENT: 'unsafe' }, status: 503, reason: 'readonly_agent' },
  ];
  for (const way of ways) {
    const h = await harness(t, { startTimeoutMs: 1_500, ...way.opencode });
    const receipt = join(h.temp, 'receipt.json');
    fakeVariables(t, fakeSwitches({ FAKE_OPENCODE_RECEIPT: receipt, ...way.env }));
    const { id, root } = await h.register('one');
    const response = await h.call('POST', url(id), { mode: 'managed' });
    assert.deepEqual([response.statusCode, response.json().reason], [way.status, way.reason], `${way.name}: ${response.body}`);
    assert.equal(typeof response.json().error, 'string');
    // The record says what happened, without an address or a process: nothing ran.
    const { server, held } = (await h.call('GET', url(id))).json();
    assert.deepEqual([held, server.state, server.base_url, server.pid, server.ended_at, server.directory, server.kind],
      [false, way.reason, null, null, null, root, 'managed'], way.name);
    if (existsSync(receipt)) {
      const pid = (JSON.parse(readFileSync(receipt, 'utf8')) as { pid: number }).pid;
      assert.ok(gone(pid), `${way.name}: process ${pid} is still there`);
    }
    // From there another start is not refused as already running.
    assert.notEqual((await h.call('POST', url(id), { mode: 'nope' })).statusCode, 409);
  }
});

test('a project whose repository is gone is refused as unavailable, like its status', { timeout: 60_000 }, async (t) => {
  const h = await harness(t);
  const { id } = await h.register('one');
  rmSync(join(h.temp, 'one'), { recursive: true, force: true });
  const response = await h.call('POST', url(id), { mode: 'managed' });
  assert.deepEqual([response.statusCode, response.json()], [409, {
    error: 'Registered Git repository is unavailable', reason: 'directory_unavailable',
  }]);
  assert.equal((await h.call('GET', url(id))).json().server.state, 'directory_unavailable');
});

test('a server that ends on its own is reported as ended and is not held any more', { timeout: 60_000 }, async (t) => {
  const h = await harness(t);
  const { id } = await h.register('one');
  const server = (await h.call('POST', url(id), { mode: 'managed' })).json().server as OpenCodeServerRecord;
  process.kill(server.pid as number, 'SIGKILL');
  let seen: OpenCodeServerRecord | null = null;
  for (let attempt = 0; attempt < 100 && seen?.state !== 'exited'; attempt++) {
    seen = ((await h.call('GET', url(id))).json() as { server: OpenCodeServerRecord | null }).server;
    if (seen?.state !== 'exited') await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.ok(seen, 'the status was never read');
  assert.deepEqual([seen.state, seen.ended_at !== null, (await h.call('GET', url(id))).json().held], ['exited', true, false]);
});

test('a server that could not be reached and then ended is said to have ended, not to be unreachable',
  { timeout: 60_000 }, async (t) => {
    const h = await harness(t);
    const { id } = await h.register('one');
    const pid = (await h.call('POST', url(id), { mode: 'managed' })).json().server.pid as number;
    // Alive but not answering any more, as a server that gave up its port is. It is still held: it may answer again.
    process.kill(pid, 'SIGUSR1');
    await until(async () => (await h.call('GET', url(id))).json(), (status) => status.server.state === 'unavailable' && status.held);
    // Then its process ends. That is the truer note.
    process.kill(pid, 'SIGKILL');
    const last = await until(async () => (await h.call('GET', url(id))).json(), (status) => status.server.state === 'exited');
    assert.deepEqual([last.server.state, last.held, last.server.ended_at !== null], ['exited', false, true]);
  });

test('a server someone else started is attached to as it is, and its password stays out of everything stored',
  { timeout: 60_000 }, async (t) => {
    const h = await harness(t);
    const { id, root } = await h.register('one');
    const readonly = await startMockOpenCode({ password: 'a-secret-of-its-own', configContent: managedConfigContent(undefined) });
    const plain = await startMockOpenCode();
    t.after(async () => { await readonly.close(); await plain.close(); });

    // Requests that are not for a server.
    for (const payload of [undefined, { mode: 'attached' }, { mode: 'nope' }, { mode: 'attached', baseUrl: `${readonly.origin}/api` },
      { mode: 'attached', baseUrl: 'opencode' }, { mode: 'attached', baseUrl: readonly.origin, password: 12 }]) {
      const response = await h.call('POST', url(id), payload);
      assert.equal(response.statusCode, 400, JSON.stringify(payload));
    }
    assert.equal((await h.call('POST', url(NO_PROJECT), { mode: 'managed' })).statusCode, 404);
    assert.equal((await h.call('POST', url(BAD_ID), { mode: 'managed' })).statusCode, 400);
    assert.equal((await h.call('GET', url(NO_PROJECT))).statusCode, 200);
    assert.deepEqual((await h.call('GET', url(BAD_ID))).statusCode, 400);

    // Without its password, nothing there, and another version: said why, and kept as that.
    const refused: Array<[string, Record<string, unknown>, string]> = [
      ['its password is not given', { mode: 'attached', baseUrl: readonly.origin }, 'unauthorized'],
      ['nothing is there', { mode: 'attached', baseUrl: await nowhere() }, 'unavailable'],
    ];
    refused.push(['another version', { mode: 'attached', baseUrl: plain.origin }, 'incompatible_version']);
    for (const [name, payload, reason] of refused) {
      plain.version = name === 'another version' ? '2.3.0' : '2.2.7';
      const response = await h.call('POST', url(id), payload);
      assert.deepEqual([response.statusCode, response.json().reason], [503, reason], `${name}: ${response.body}`);
      assert.equal((await h.call('GET', url(id))).json().server.state, reason, name);
    }
    plain.version = '2.2.7';

    // With its password.
    const attached = await h.call('POST', url(id), { mode: 'attached', baseUrl: readonly.origin, password: 'a-secret-of-its-own' });
    assert.equal(attached.statusCode, 201, attached.body);
    const server = attached.json().server as OpenCodeServerRecord;
    assert.deepEqual([server.kind, server.state, server.directory], ['attached', 'running', root]);
    assert.deepEqual([server.base_url, server.pid, server.pid_started, server.owner_pid, server.readonly_agent],
      [readonly.origin, process.pid, null, null, true]);
    assert.equal((await h.call('GET', url(id))).json().held, true);
    // The password is in no answer and in nothing stored.
    assert.equal(attached.body.includes('a-secret-of-its-own'), false);
    assert.equal(JSON.stringify(rowsOf(h.database)).includes('a-secret-of-its-own'), false);
    // The server itself was not written to.
    assert.ok(readonly.requests.every((request) => request.method === 'GET'), 'something was written to the attached server');

    // Let go of: the record says so, and the server keeps running.
    const letGo = await h.call('DELETE', url(id));
    assert.deepEqual([letGo.statusCode, letGo.json().result, letGo.json().server.state, letGo.json().server.ended_at !== null],
      [200, 'detached', 'detached', true]);
    const still = await fetch(`${readonly.origin}/api/info`, {
      headers: { authorization: `Basic ${Buffer.from('opencode:a-secret-of-its-own').toString('base64')}` },
    });
    assert.equal(still.status, 200);
    assert.equal((await h.call('DELETE', url(id))).statusCode, 404);

    // One without the read-only agent is attached to all the same, and said to have none.
    const { id: two } = await h.register('two');
    const without = await h.call('POST', url(two), { mode: 'attached', baseUrl: plain.origin });
    assert.equal(without.statusCode, 201, without.body);
    assert.deepEqual([without.json().server.kind, without.json().server.readonly_agent], ['attached', false]);
  });

test('unregistering a project ends the server the Workbench started for it', { timeout: 60_000 }, async (t) => {
  const h = await harness(t);
  const { id } = await h.register('one');
  const server = (await h.call('POST', url(id), { mode: 'managed' })).json().server as OpenCodeServerRecord;
  const response = await h.call('DELETE', `/api/projects/${id}`);
  assert.equal(response.statusCode, 204, response.body);
  assert.ok(gone(server.pid as number), 'the process is still there');
  assert.deepEqual(rowsOf(h.database), []);
});

test('with the application ending, a managed server is ended and noted, and an attached one is let go of', { timeout: 60_000 }, async () => {
  const temp = mkdtempSync(join(realpathSync(tmpdir()), 'wb-oc-api-close-'));
  const database = new WorkbenchDatabase({ dataDirectory: join(temp, 'data') });
  const app = buildApp({ database, opencode: { command: FAKE } });
  const mock = await startMockOpenCode({ password: 'secret' });
  try {
    const ids: string[] = [];
    for (const slug of ['one', 'two']) {
      const root = join(temp, slug);
      mkdirSync(root);
      execFileSync('git', ['init', '-q', '-b', 'main', root]);
      execFileSync('git', ['-C', root, '-c', 'user.name=t', '-c', 'user.email=t@example.invalid', 'commit', '-q', '--allow-empty', '-m', 'init']);
      const registered = await app.inject({ method: 'POST', url: '/api/projects', payload: { path: root, slug, name: slug } });
      ids.push(registered.json().id);
    }
    const managed = (await app.inject({ method: 'POST', url: url(ids[0]), payload: { mode: 'managed' } })).json().server as OpenCodeServerRecord;
    const attached = (await app.inject({ method: 'POST', url: url(ids[1]), payload: { mode: 'attached', baseUrl: mock.origin, password: 'secret' } })).json().server as OpenCodeServerRecord;
    assert.deepEqual([managed.state, attached.state], ['running', 'running']);

    await app.close();
    assert.ok(gone(managed.pid as number), 'the managed server is still there');
    const records = rowsOf(database);
    assert.deepEqual(records.map((row) => [row.kind, row.state, row.ended_at !== null]), [['managed', 'stopped', true], ['attached', 'detached', true]]);
    // The attached server was nobody's to end.
    const response = await fetch(`${mock.origin}/api/info`, {
      headers: { authorization: `Basic ${Buffer.from('opencode:secret').toString('base64')}` },
    });
    assert.equal(response.status, 200);
  } finally {
    await app.close();
    database.close();
    await mock.close();
    rmSync(temp, { recursive: true, force: true });
  }
});

test('what an earlier Workbench process left in the records is sorted out once, and nothing is signalled without proof',
  { timeout: 60_000 }, async (t) => {
    const temp = mkdtempSync(join(realpathSync(tmpdir()), 'wb-oc-api-left-'));
    const database = new WorkbenchDatabase({ dataDirectory: join(temp, 'data') });
    t.after(async () => { database.close(); rmSync(temp, { recursive: true, force: true }); });
    const register = async (slug: string) => {
      const root = join(temp, slug);
      mkdirSync(root);
      execFileSync('git', ['init', '-q', '-b', 'main', root]);
      return (database.projects.create({ slug, name: slug, repoRoot: realpathSync(root) })).id;
    };
    const goneOwner = await endedProcess();
    const base = {
      kind: 'managed' as const, version: '2.2.7', state: 'running' as const, readonlyAgent: true,
      baseUrl: 'http://127.0.0.1:4096', ownerPid: goneOwner,
    };
    // (a) Its process is gone.
    const a = await register('gone');
    database.opencodeServers.save({ ...base, projectId: a, directory: temp, pid: goneOwner, pidStarted: 'Thu Jan 1 00:00:00 1970' });
    // (b) Its process is there and is the recorded one.
    const b = await register('left');
    const leftoverRoot = join(temp, 'left');
    const leftover = await leftoverFake(leftoverRoot, join(temp, 'leftover-receipt.json'));
    t.after(() => { try { process.kill(leftover, 'SIGKILL'); } catch { /* already gone */ } });
    const identity: ProcessIdentity | null = await describeProcess(leftover);
    assert.ok(identity, 'the system says nothing about the leftover server');
    database.opencodeServers.save({
      ...base, projectId: b, directory: leftoverRoot, pid: leftover, pidStarted: identity.started,
    });
    // (c) A process has the recorded number but is not that server: this test itself.
    const c = await register('other');
    const self = await describeProcess(process.pid);
    database.opencodeServers.save({ ...base, projectId: c, directory: temp, pid: process.pid, pidStarted: self?.started ?? '' });
    // (d) Another Workbench process that is still there runs it: some other live process stands in for that one.
    const d = await register('elsewhere');
    const other = spawn(process.execPath, ['-e', 'setInterval(() => undefined, 1000)'], { stdio: 'ignore' });
    t.after(() => { other.kill('SIGKILL'); });
    database.opencodeServers.save({
      ...base, projectId: d, directory: temp, ownerPid: other.pid, pid: other.pid, pidStarted: self?.started ?? '',
    });
    // (e) and (f): servers that were attached to, one still there and one gone.
    const e = await register('attached');
    const f = await register('vanished');
    const mock = await startMockOpenCode({ password: 'secret' });
    t.after(() => mock.close());
    for (const [projectId, origin] of [[e, mock.origin], [f, await nowhere()]] as const) {
      database.opencodeServers.save({
        projectId, kind: 'attached', directory: temp, baseUrl: origin, pid: 1, version: '2.2.7', state: 'running', readonlyAgent: false,
      });
    }

    const app = buildApp({ database, opencode: { command: FAKE } });
    t.after(() => app.close());
    await app.opencode.reconcile();
    const stateOf = async (projectId: string) =>
      ((await app.inject({ method: 'GET', url: url(projectId) })).json() as { server: OpenCodeServerRecord; held: boolean });
    assert.equal((await stateOf(a)).server.state, 'exited');
    assert.deepEqual([(await stateOf(b)).server.state, gone(leftover)], ['stopped', true]);
    // (c) is there, is not the recorded server, and is left alone.
    assert.deepEqual([((await stateOf(c)).server).state, (await stateOf(c)).held], ['orphaned', false]);
    // (d) is left to the process that runs it.
    assert.deepEqual([((await stateOf(d)).server).state, (await stateOf(d)).held], ['running', false]);
    assert.deepEqual([((await stateOf(e)).server).state, (await stateOf(e)).held], ['unauthorized', false]);
    assert.deepEqual([((await stateOf(f)).server).state, (await stateOf(f)).held], ['unavailable', false]);

    // (c) is not ended, as it cannot be proved to be the recorded server, and another server is not started beside it.
    const unverifiable = await app.inject({ method: 'DELETE', url: url(c) });
    assert.deepEqual([unverifiable.statusCode, unverifiable.json().reason], [409, 'unverifiable']);
    const beside = await app.inject({ method: 'POST', url: url(c), payload: { mode: 'managed' } });
    assert.deepEqual([beside.statusCode, beside.json().reason, beside.json().pid], [409, 'leftover', process.pid]);
    // (d) belongs to a Workbench process that is still there.
    const elsewhere = await app.inject({ method: 'DELETE', url: url(d) });
    assert.deepEqual([elsewhere.statusCode, elsewhere.json().reason], [409, 'running_elsewhere']);
    const over = await app.inject({ method: 'POST', url: url(d), payload: { mode: 'managed' } });
    assert.deepEqual([over.statusCode, over.json().reason], [409, 'running_elsewhere']);
    // (b) has ended: nothing is left to stop.
    assert.equal((await app.inject({ method: 'DELETE', url: url(b) })).statusCode, 404);
    // (e) can be attached to again, with its password.
    const again = await app.inject({ method: 'POST', url: url(e), payload: { mode: 'attached', baseUrl: mock.origin, password: 'secret' } });
    assert.deepEqual([again.statusCode, again.json().server.state, (await stateOf(e)).held], [201, 'running', true]);
    // A look is taken once: what changed since is not looked at again until the next start of the Workbench.
    database.opencodeServers.save({ ...base, projectId: a, directory: temp, pid: goneOwner, pidStarted: 'Thu Jan 1 00:00:00 1970' });
    await app.opencode.reconcile();
    assert.equal((await stateOf(a)).server.state, 'running');
  });

/** `opencode v2.2.7` as the CLI prints it, or null when no such program is installed. */
function cliVersion(): string | null {
  try {
    return execFileSync(process.env.OPENCODE_BIN ?? 'opencode', ['--version'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
      .replace(/\u001b\[[0-9;]*m/g, '').trim();
  } catch { return null; }
}
const installed = cliVersion();

test('a real server is started through the API, and its record is what the system says of it',
  { skip: installed !== 'opencode v2.2.7', timeout: 120_000 }, async (t) => {
    const h = await harness(t, { command: [process.env.OPENCODE_BIN ?? 'opencode'] });
    const { id, root } = await h.register('one');
    // A home and data, config, state and cache of its own: nothing of the developer's OpenCode is read or written.
    mkdirSync(join(h.temp, 'home'), { recursive: true });
    fakeVariables(t, {
      HOME: join(h.temp, 'home'), XDG_DATA_HOME: join(h.temp, 'oc-data'), XDG_CONFIG_HOME: join(h.temp, 'oc-config'),
      XDG_STATE_HOME: join(h.temp, 'oc-state'), XDG_CACHE_HOME: join(h.temp, 'oc-cache'),
    });
    const started = await h.call('POST', url(id), { mode: 'managed' });
    assert.equal(started.statusCode, 201, started.body);
    const server = started.json().server as OpenCodeServerRecord;
    // A real server leaves no mark, so it is ended here itself if the test fails before it is stopped.
    t.after(() => { try { process.kill(server.pid as number, 'SIGKILL'); } catch { /* gone */ } });
    assert.deepEqual([server.state, server.directory, server.readonly_agent, server.version], ['running', root, true, '2.2.7']);
    // The start time the system gave it is what a later look will compare it by.
    assert.equal((await describeProcess(server.pid as number))?.started, server.pid_started);
    assert.equal((await h.call('GET', url(id))).json().held, true);
    // Nothing was written into the project for it.
    assert.deepEqual(readdirSync(root).filter(name => name !== '.git'), []);
    const stopped = await h.call('DELETE', url(id));
    assert.deepEqual([stopped.statusCode, stopped.json().server.state, gone(server.pid as number)], [200, 'stopped', true]);
  });

test('the server ends the OpenCode servers it started before it goes, and sorts out what an earlier run left',
  { timeout: 60_000 }, async (t) => {
    const temp = mkdtempSync(join(realpathSync(tmpdir()), 'wb-oc-api-server-'));
    const dataDirectory = join(temp, 'data');
    t.after(() => rmSync(temp, { recursive: true, force: true }));
    // The program the Workbench is told to start: the fake, behind a small script that stands for `opencode`.
    const shim = join(temp, 'opencode');
    writeFileSync(shim, `#!/bin/sh\nexec "${process.execPath}" "${FAKE[1]}" "$@"\n`);
    chmodSync(shim, 0o755);
    // What an earlier run left: a server whose process is gone.
    const earlier = new WorkbenchDatabase({ dataDirectory });
    const left = earlier.projects.create({ slug: 'left', name: 'Left', repoRoot: join(temp, 'left') });
    mkdirSync(join(temp, 'left'));
    earlier.opencodeServers.save({
      projectId: left.id, kind: 'managed', directory: join(temp, 'left'), baseUrl: 'http://127.0.0.1:4096',
      pid: await endedProcess(), pidStarted: 'Thu Jan 1 00:00:00 1970', ownerPid: await endedProcess(), version: '2.2.7',
      state: 'running',
      readonlyAgent: true,
    });
    earlier.close();
    const root = join(temp, 'one');
    mkdirSync(root);
    execFileSync('git', ['init', '-q', '-b', 'main', root]);

    const probe = createServer();
    await new Promise<void>((resolve) => { probe.listen(0, '127.0.0.1', () => resolve()); });
    const port = (probe.address() as { port: number }).port;
    await new Promise<void>((resolve) => { probe.close(() => resolve()); });
    const tsx = createRequire(import.meta.url).resolve('tsx/cli');
    const server = spawn(process.execPath, [tsx, fileURLToPath(new URL('../src/server.ts', import.meta.url))], {
      env: { ...process.env, WORKBENCH_API_PORT: String(port), WORKBENCH_DATA_DIR: dataDirectory, WORKBENCH_OPENCODE_BIN: shim },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    server.stdout?.on('data', (chunk: Buffer) => { output = (output + chunk.toString()).slice(-4_096); });
    server.stderr?.on('data', (chunk: Buffer) => { output = (output + chunk.toString()).slice(-4_096); });
    const exited = new Promise<{ code: number | null; signal: string | null }>((resolve) => {
      server.once('exit', (code, signal) => resolve({ code, signal }));
    });
    t.after(() => { server.kill('SIGKILL'); });
    const base = `http://127.0.0.1:${port}`;
    const call = async (method: 'GET' | 'POST', path: string, payload?: unknown) => {
      const response = await fetch(`${base}${path}`, {
        method, headers: { 'content-type': 'application/json' }, body: payload === undefined ? undefined : JSON.stringify(payload),
      });
      return { status: response.status, body: (await response.json()) as any };
    };
    try {
      let up = false;
      for (let attempt = 0; attempt < 200 && !up; attempt++) {
        up = await fetch(`${base}/api/health`).then((response) => response.ok, () => false);
        if (!up) await new Promise((resolve) => setTimeout(resolve, 100));
      }
      assert.ok(up, `the server did not start:\n${output}`);

      // The record of the earlier run was sorted out at the start.
      assert.equal((await call('GET', url(left.id))).body.server.state, 'exited');

      const registered = await call('POST', '/api/projects', { path: root, slug: 'one', name: 'One' });
      assert.equal(registered.status, 201, JSON.stringify(registered.body));
      const started = await call('POST', url(registered.body.id), { mode: 'managed' });
      assert.equal(started.status, 201, JSON.stringify(started.body));
      const pid = started.body.server.pid as number;

      // SIGTERM to the Workbench: it ends its server first, then goes.
      process.kill(server.pid as number, 'SIGTERM');
      const end = await within<{ code: number | null; signal: string | null } | 'still running'>(
        exited, 15_000, 'still running',
      );
      assert.deepEqual(end, { code: 0, signal: null }, `the server did not end cleanly:\n${output}`);
      assert.ok(gone(pid), `the OpenCode server ${pid} is still there`);
      const after = new WorkbenchDatabase({ dataDirectory });
      try {
        assert.equal(after.opencodeServers.forProject(registered.body.id)?.state, 'stopped');
      } finally { after.close(); }
    } finally {
      server.kill('SIGKILL');
    }
  });

const sessionsUrl = (id: string) => `/api/projects/${id}/opencode/sessions`;

test('a session is created under the read-only agent, is asked as its texts come, and is remembered after the server stops',
  { timeout: 60_000 }, async (t) => {
    const h = await harness(t);
    const { id } = await h.register('one');
    const sessions = sessionsUrl(id);

    // No server is held. What is not a text and not a decision is refused here, before a server is even asked for.
    const without = await h.call('GET', sessions);
    assert.deepEqual([without.statusCode, without.json().reason, without.json().server], [409, 'no_server', null]);
    assert.equal((await h.call('POST', sessions, {})).json().reason, 'no_server');
    assert.equal((await h.call('POST', `${sessions}/ses_none00001/prompt`, { text: '   ' })).statusCode, 400,
      'a text that is not one has to be refused before the server is looked for');
    assert.equal((await h.call('POST', `${sessions}/ses_none00001/permissions/per_x/reply`, { decision: 'perhaps' })).statusCode, 400,
      'a decision that is not one has to be refused before the server is looked for');

    const started = await h.call('POST', url(id), { mode: 'managed' });
    assert.equal(started.statusCode, 201, started.body);

    // A session is created, switched to the agent that is proven read-only, and given out only as switched.
    const created = await h.call('POST', sessions, { title: 'First look' });
    assert.equal(created.statusCode, 201, created.body);
    const session = created.json().session as { id: string; agent: string; title: string };
    assert.match(session.id, /^ses_[A-Za-z0-9]+$/, created.body);
    assert.equal(session.agent, 'workbench-readonly', created.body);
    // It is remembered at the moment it is made, before anything has asked the server for a list.
    assert.deepEqual(h.database.opencodeSessions.forProject(id).map(one => one.session_id), [session.id]);

    // The server lists it as the project's own, and the Workbench remembers it.
    const listed = await h.call('GET', sessions);
    assert.equal(listed.statusCode, 200, listed.body);
    assert.deepEqual((listed.json().sessions as Array<{ id: string }>).map(one => one.id), [session.id]);
    assert.deepEqual(
      (listed.json().recorded as Array<{ session_id: string; title: string; on_server: boolean }>)
        .map(one => [one.session_id, one.title, one.on_server]),
      [[session.id, 'First look', true]],
    );

    // A text is queued, and the answer comes later; for now the user's own message is what comes back.
    const prompted = await h.call('POST', `${sessions}/${session.id}/prompt`, { text: 'What is in README.md?' });
    assert.deepEqual(
      [prompted.statusCode, prompted.json().message.type, prompted.json().message.text],
      [202, 'user', 'What is in README.md?'],
    );
    const messages = await h.call('GET', `${sessions}/${session.id}/messages`);
    // The switch of the agent is itself an entry of the conversation, before the text that was queued.
    assert.deepEqual(
      (messages.json().messages as Array<{ type: string; text: string }>)
        .map(one => [one.type, one.text]),
      [['agent-switched', ''], ['user', 'What is in README.md?']],
    );
    // A session that asks for nothing yet, and a run that is interrupted.
    assert.deepEqual((await h.call('GET', `${sessions}/${session.id}/permissions`)).json().permissions, []);
    assert.deepEqual((await h.call('POST', `${sessions}/${session.id}/abort`)).json(), { interrupted: true });

    // What is no session here, no request of it, no session id at all: said so, each with its status.
    assert.equal((await h.call('GET', `${sessions}/ses_notours01/messages`)).statusCode, 404);
    assert.equal((await h.call('POST', `${sessions}/${session.id}/permissions/per_nobody1/reply`, { decision: 'reject' })).statusCode, 404);
    assert.equal((await h.call('POST', `${sessions}/${session.id}/permissions/per_nobody1/reply`, { decision: 'perhaps' })).statusCode, 400);
    assert.equal((await h.call('GET', `${sessions}/not-a-session/messages`)).statusCode, 400);
    assert.equal((await h.call('POST', sessions, { title: 'x'.repeat(501) })).statusCode, 400);

    // With the server gone nothing more is asked of it, but the Workbench still knows the session was there.
    const stopped = await h.call('DELETE', url(id));
    assert.deepEqual([stopped.statusCode, stopped.json().server.state], [200, 'stopped']);
    const afterStop = await h.call('GET', sessions);
    assert.deepEqual([afterStop.statusCode, afterStop.json().reason], [409, 'no_server']);
    const remembered = await h.call('GET', `${sessions}/recorded`);
    assert.deepEqual(
      (remembered.json().recorded as Array<{ session_id: string; on_server: boolean }>)
        .map(one => [one.session_id, one.on_server]),
      [[session.id, true]],
    );
    assert.deepEqual(h.database.opencodeSessions.forProject(id).map(one => one.session_id), [session.id]);
  });

test('no text is given to a session that another client has switched away from the read-only agent',
  { timeout: 60_000 }, async (t) => {
    const h = await harness(t);
    const { id, root } = await h.register('one');
    const server = await startMockOpenCode({ password: 'p', configContent: managedConfigContent(undefined) });
    t.after(() => server.close());
    const attached = await h.call('POST', url(id), { mode: 'attached', baseUrl: server.origin, password: 'p' });
    assert.equal(attached.statusCode, 201, attached.body);
    assert.equal((attached.json().server as { readonly_agent: boolean }).readonly_agent, true, attached.body);

    const created = await h.call('POST', sessionsUrl(id), {});
    assert.equal(created.statusCode, 201, created.body);
    const session = created.json().session as { id: string; agent: string };
    assert.equal(session.agent, 'workbench-readonly', created.body);

    // Somebody else with the password of the server switches the session's agent. The next text is refused here,
    // and nothing is queued on the server for it.
    const theirs = await connectOpenCode({ baseUrl: server.origin, directory: root, password: 'p' });
    await theirs.adapter.setSessionAgent(session.id, 'plan');
    const refused = await h.call('POST', `${sessionsUrl(id)}/${session.id}/prompt`, { text: 'list the files' });
    assert.deepEqual([refused.statusCode, refused.json().reason], [409, 'not_readonly']);
    assert.equal(
      server.requests.some(request => request.path.endsWith('/prompt')),
      false,
      'something was queued on the server for a session that does not run the read-only agent',
    );
    // Reading the conversation is not giving a task, and still answers.
    assert.equal((await h.call('GET', `${sessionsUrl(id)}/${session.id}/messages`)).statusCode, 200);

    // A session that another client made on the server directly is picked up when the project's sessions are read.
    const madeDirectly = await theirs.adapter.createSession({ title: 'Made directly' });
    const listed = await h.call('GET', sessionsUrl(id));
    assert.deepEqual(
      (listed.json().recorded as Array<{ session_id: string; title: string }>)
        .map(one => [one.session_id, one.title]),
      [[madeDirectly.id, 'Made directly'], [session.id, '']],
    );
  });

test('nothing is queued while the asker of the Workbench says no', { timeout: 60_000 }, async (t) => {
    const h = await harness(t, { mayAsk: async () => false });
    const { id } = await h.register('one');
    const started = await h.call('POST', url(id), { mode: 'managed' });
    assert.equal(started.statusCode, 201, started.body);
    const created = await h.call('POST', sessionsUrl(id), {});
    const session = created.json().session as { id: string };
    assert.equal(created.statusCode, 201, created.body);

    const refused = await h.call('POST', `${sessionsUrl(id)}/${session.id}/prompt`, { text: 'Anything.' });
    assert.deepEqual([refused.statusCode, refused.json().reason], [409, 'not_readonly']);
    // Reading is not asking, and a session is still created; only the text waits.
    assert.equal((await h.call('GET', `${sessionsUrl(id)}/${session.id}/messages`)).statusCode, 200);
    assert.equal((await h.call('POST', sessionsUrl(id), { title: 'another' })).statusCode, 201);
  });

test('the events of one session stream out of the route, and the others do not', { timeout: 60_000 }, async (t) => {
    const h = await harness(t);
    const { id } = await h.register('one');
    const server = await startMockOpenCode({ password: 'p', configContent: managedConfigContent(undefined) });
    t.after(() => server.close());
    const attached = await h.call('POST', url(id), { mode: 'attached', baseUrl: server.origin, password: 'p' });
    assert.equal(attached.statusCode, 201, attached.body);
    const mine = (await h.call('POST', sessionsUrl(id), {})).json().session as { id: string };
    const theirs = (await h.call('POST', sessionsUrl(id), {})).json().session as { id: string };
    const streamUrl = `${sessionsUrl(id)}/${mine.id}/events`;

    // Before anything streams, what went wrong is said the usual way.
    assert.equal((await h.call('GET', `/api/projects/${NO_PROJECT}/opencode/sessions/${mine.id}/events`)).statusCode, 404);
    assert.equal((await h.call('GET', `${sessionsUrl(id)}/bad-id/events`)).statusCode, 400);

    await h.app.listen({ port: 0, host: '127.0.0.1' });
    const address = `http://127.0.0.1:${(h.app.server.address() as { port: number }).port}`;
    // A session the server has none of is a JSON answer, never a stream that opens and stays open. The wait is
    // bounded, so that a route which streams instead of refusing fails here in seconds.
    const unknown = await Promise.race([
      fetch(`${address}${sessionsUrl(id)}/ses_nosuch001/events`),
      new Promise<'opened'>((resolve) => setTimeout(() => resolve('opened'), 3_000)),
    ]);
    try {
      assert.notEqual(unknown, 'opened', 'the events route opened a stream for a session that is not in this project');
      if (unknown !== 'opened') {
        assert.equal(unknown.status, 404, `a missing session is refused: ${unknown.status}`);
        assert.ok(
          (unknown.headers.get('content-type') ?? '').startsWith('application/json'),
          `a refusal before the stream is JSON, not ${(unknown.headers.get('content-type'))}`,
        );
      }
    } finally {
      if (unknown !== 'opened') await unknown.body?.cancel().catch(() => undefined);
    }

    // A route that never answers has to fail here, not hang the suite.
    const response = await Promise.race([
      fetch(`${address}${streamUrl}`),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('the events route did not answer in 10s')), 10_000)),
    ]);
    assert.equal(response.status, 200, `the events route answered ${response.status}`);
    assert.equal(response.headers.get('content-type'), 'text/event-stream', 'the answer is not an event stream');
    assert.ok(response.body, 'the answer has no body to read');
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let text = '';
    try {
      // The route answers only once its source is on the server's stream; from then on what is emitted arrives.
      for (let attempt = 0; attempt < 100 && !server.requests.some(request => request.path === '/api/event'); attempt++) {
        await new Promise(resolve => setTimeout(resolve, 20));
      }
      server.emit({ type: 'session.something', data: { sessionID: theirs.id } });
      server.ask(mine.id, 'read', ['.env']);
      // The whole read waits at most ten seconds, so that a broken route fails here instead of hanging the suite.
      const deadline = Date.now() + 10_000;
      while (Date.now() < deadline && !text.includes('permission.asked')) {
        const next = await Promise.race([
          reader.read(),
          new Promise<'tick'>(resolve => setTimeout(() => resolve('tick'), 1_000)),
        ]);
        if (next === 'tick') continue;
        if (next.done) break;
        text += decoder.decode(next.value, { stream: true });
      }
    } finally { await reader.cancel().catch(() => undefined); }
    const seen = text.split('\n\n').filter(one => one.startsWith('data: '))
      .map(one => JSON.parse(one.slice(6)) as { type: string; data: { sessionID?: string } });
    assert.ok(
      seen.some(event => event.type === 'permission.asked' && event.data.sessionID === mine.id),
      `the ask of this session did not arrive: ${text}`,
    );
    assert.ok(!seen.some(event => event.data.sessionID === theirs.id), `another session's event came through: ${text}`);
    // After the reader hangs up, the application answers as before.
    assert.equal((await h.call('GET', sessionsUrl(id))).statusCode, 200);
  });

test('a real server gives a session that runs the read-only agent from its first moment, and it is remembered',
  { skip: installed !== 'opencode v2.2.7', timeout: 120_000 }, async (t) => {
    const h = await harness(t, { command: [process.env.OPENCODE_BIN ?? 'opencode'] });
    const { id, root } = await h.register('one');
    // A home and data, config, state and cache of its own: nothing of the developer's OpenCode is read or written.
    mkdirSync(join(h.temp, 'home'), { recursive: true });
    fakeVariables(t, {
      HOME: join(h.temp, 'home'), XDG_DATA_HOME: join(h.temp, 'oc-data'), XDG_CONFIG_HOME: join(h.temp, 'oc-config'),
      XDG_STATE_HOME: join(h.temp, 'oc-state'), XDG_CACHE_HOME: join(h.temp, 'oc-cache'),
    });
    const started = await h.call('POST', url(id), { mode: 'managed' });
    assert.equal(started.statusCode, 201, started.body);
    const server = started.json().server as OpenCodeServerRecord;
    t.after(() => { try { process.kill(server.pid as number, 'SIGKILL'); } catch { /* gone */ } });

    // A session is created on the real server and switched to the read-only agent, and no model is asked anything:
    // no prompt is sent in this test.
    const created = await h.call('POST', sessionsUrl(id), { title: 'Real' });
    assert.equal(created.statusCode, 201, created.body);
    const session = created.json().session as { id: string; agent: string };
    assert.equal(session.agent, 'workbench-readonly', created.body);
    const listed = await h.call('GET', sessionsUrl(id));
    assert.deepEqual((listed.json().sessions as Array<{ id: string }>).map(one => one.id), [session.id]);
    const messages = await h.call('GET', `${sessionsUrl(id)}/${session.id}/messages`);
    // The switch of the agent is itself an entry of the conversation. Nothing else was asked of the model.
    assert.deepEqual(
      (messages.json().messages as Array<{ type: string; agent: string | null }>)
        .map(one => [one.type, one.agent]),
      [['agent-switched', 'workbench-readonly']],
    );
    // Nothing was written into the project for it.
    assert.deepEqual(readdirSync(root).filter(name => name !== '.git'), []);

    const stopped = await h.call('DELETE', url(id));
    assert.deepEqual([stopped.statusCode, gone(server.pid as number)], [200, true]);
    assert.deepEqual(h.database.opencodeSessions.forProject(id).map(one => one.session_id), [session.id]);
  });

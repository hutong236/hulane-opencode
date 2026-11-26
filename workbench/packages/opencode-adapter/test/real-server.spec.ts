import assert from 'node:assert/strict';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { test } from 'node:test';
import {
  OpenCodeError, OpenCodeHttpAdapter, READONLY_AGENT_ID, VERIFIED_VERSION, connectOpenCode, managedConfigContent,
  readOnlyProblems, resolvePermission, startManagedOpenCode,
} from '../src/index.ts';
import { REAL_READONLY_RULES, shown } from './rules.ts';

/**
 * The same adapter against a real OpenCode server, started here from the installed CLI in a temporary repository
 * with a home and data, config, state and cache directories of its own, so that nothing of the developer's own
 * OpenCode is read or written.
 *
 * These tests send no prompt. OpenCode 2.2.7 comes with a public provider, `opencode`, and one model that costs
 * nothing, `big-pickle`, so a prompt is run by a real model wherever a server is started, with whatever agent was
 * named. A prompt with the read-only agent is run by the test at the end of this file, and only when
 * `WORKBENCH_REAL_MODEL_TEST=1` asks for it: it calls a public model over the network, which a test run should not
 * do unasked.
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

/** The environment of a lab server: a home and the four XDG directories of its own, and nothing else of this user's. */
function isolated(lab: string): NodeJS.ProcessEnv {
  mkdirSync(join(lab, 'home'), { recursive: true });
  return {
    PATH: process.env.PATH ?? '', HOME: join(lab, 'home'), TMPDIR: process.env.TMPDIR ?? '', LANG: process.env.LANG ?? '',
    XDG_DATA_HOME: join(lab, 'data'), XDG_CONFIG_HOME: join(lab, 'config'),
    XDG_STATE_HOME: join(lab, 'state'), XDG_CACHE_HOME: join(lab, 'cache'),
  };
}

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
    env: { ...isolated(lab), OPENCODE_PASSWORD: password },
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

    // No prompt is sent here: the real server would run it with a real model. The prompt route is read by the test at
    // the end of this file, which asks to be run.
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
    // A home and data, config and state of its own: nothing of the developer's OpenCode is read or written, and what
    // it keeps is still there for the next server.
    const env = isolated(lab);
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
      assert.ok(plan?.permissions.some(rule => rule.action === 'edit' && rule.effect === 'deny'), 'the real plan agent does not deny edit');
      assert.ok(readOnlyProblems(plan!).includes('shell is not denied'), shown(plan!.permissions));

      const session = await first.adapter.createSession({ title: 'before the restart' });
      assert.equal(session.directory, directory);
      // The agent of a session is switched, and read back: the switch takes any name, so only the session says.
      assert.equal(session.agent, null, 'a new session has an agent of its own');
      assert.equal((await first.adapter.setSessionAgent(session.id, READONLY_AGENT_ID)).agent, READONLY_AGENT_ID,
        'the real server did not switch the session to the read-only agent');
      assert.deepEqual((await first.adapter.listSessions()).map(one => one.id), [session.id], 'the sessions of the project are not listed');
      // None of this wrote anything into the project.
      assert.deepEqual(files(repo), []);
      await first.stop();
      assert.equal(first.running, false);
      assert.ok(existsSync(join(lab, 'data', 'opencode')), 'the server kept its data where it was told to');

      // Another server for the same project, on the same data: the session is still there to be read.
      second = await start();
      assert.notEqual(second.pid, first.pid);
      assert.equal((await second.adapter.getSession(session.id))?.title, 'before the restart');
      assert.equal((await second.adapter.getSession(session.id))?.agent, READONLY_AGENT_ID, 'the agent of the session did not survive the restart');
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

type Event = { type: string; data?: Record<string, unknown> };

/**
 * Asks for it with `WORKBENCH_REAL_MODEL_TEST=1`: it calls the public model over the network. Two tasks are given to
 * the read-only agent, and what the server answers is printed, so that the shapes it uses are read and not guessed.
 */
test('a task for the read-only agent is answered by the public model, which reads and asks before a secrets file',
  { skip: process.env.WORKBENCH_REAL_MODEL_TEST !== '1' || installed !== expected, timeout: 180_000 }, async () => {
  const lab = mkdtempSync(join(realpathSync(tmpdir()), 'wb-oc-real-model-'));
  const repo = join(lab, 'repo');
  execFileSync('git', ['init', '-q', '-b', 'main', repo]);
  writeFileSync(join(repo, 'README.md'), 'Workbench read-only check\nThis repository exists to be read and not changed.\n');
  const secret = `MARKER-${randomBytes(8).toString('hex')}`;
  writeFileSync(join(repo, '.env'), `TOKEN=${secret}\n`);
  const directory = realpathSync(repo);
  // Started by hand, with its password known here, so that the server can be asked directly.
  const password = randomBytes(12).toString('hex');
  const port = await freePort();
  const origin = `http://127.0.0.1:${port}`;
  const child: ChildProcess = spawn(CLI, ['serve', '--hostname', '127.0.0.1', '--port', String(port)], {
    cwd: directory,
    env: { ...isolated(lab), OPENCODE_PASSWORD: password, OPENCODE_CONFIG_CONTENT: managedConfigContent(undefined) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout?.on('data', (chunk: Buffer) => { output = (output + chunk.toString()).slice(-4_096); });
  child.stderr?.on('data', (chunk: Buffer) => { output = (output + chunk.toString()).slice(-4_096); });
  const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
  const kill = async () => { child.kill('SIGTERM'); await exited; };
  const adapter = new OpenCodeHttpAdapter({ baseUrl: origin, directory, password, timeoutMs: 15_000 });
  const controller = new AbortController();
  try {
    let info: { version: string } | undefined;
    for (let attempt = 0; attempt < 120 && !info; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 250));
      await adapter.info().then((value) => { info = value; }, () => undefined);
    }
    assert.ok(info, `the real server did not answer:\n${output}`);
    // Everything the server says, from before the session exists.
    const events: Event[] = [];
    const listening = (async () => {
      try {
        for await (const event of adapter.subscribeEvents(controller.signal)) events.push(event as Event);
      } catch { /* stopped below */ }
    })();
    await new Promise((resolve) => setTimeout(resolve, 300));
    await adapter.listAgents();
    const session = await adapter.createSession({ title: 'read-only check' });
    const before = files(repo);
    const about = () => events.filter(event => event.data?.sessionID === session.id);
    // How the real server says that a session has nothing more to run. `started` is not that.
    const DONE = /^session\.execution\.(?!started$)/;
    const done = () => about().filter(event => DONE.test(event.type));
    const untilDone = async (seen: number, seconds: number): Promise<Event[]> => {
      for (let attempt = 0; attempt < seconds * 5 && done().length <= seen; attempt++) {
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
      return done().slice(seen);
    };
    const raw = async (method: string, path: string, body?: unknown): Promise<{ status: number; body: unknown }> => {
      const response = await fetch(`${origin}${path}`, {
        method,
        headers: {
          authorization: `Basic ${Buffer.from(`opencode:${password}`).toString('base64')}`,
          'x-opencode-directory': directory, 'content-type': 'application/json',
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      return { status: response.status, body: await response.json().catch(() => null) };
    };
    const log = (label: string, value: unknown): void => console.log(`[real model] ${label}: ${JSON.stringify(value).slice(0, 12_000)}`);

    // The agent is a property of the session on this server. It is switched, read back, and only then is a task given.
    const switched = await raw('POST', `/api/session/${session.id}/agent`, { agent: READONLY_AGENT_ID });
    log('POST /api/session/:id/agent', switched);
    const readBack = await raw('GET', `/api/session/${session.id}`);
    const sessionAgent = (readBack.body as { data?: { agent?: string } }).data?.agent;
    log('the session after the switch', readBack.body);
    assert.equal(switched.status, 204, 'the agent was not switched');
    assert.equal(sessionAgent, READONLY_AGENT_ID, 'the session does not say it runs the read-only agent');
    // The switch takes any name. An agent that is not there is found out only when a task runs, which then fails.
    const stray = (await raw('POST', '/api/session', { title: 'stray' })).body as { data: { id: string } };
    const toNobody = await raw('POST', `/api/session/${stray.data.id}/agent`, { agent: 'nobody' });
    const nobody = (await raw('GET', `/api/session/${stray.data.id}`)).body as { data?: { agent?: string } };
    log('a switch to an agent that is not there', { status: toNobody.status, session: nobody });
    assert.deepEqual([toNobody.status, nobody.data?.agent], [204, 'nobody'], 'the switch is not taken as read');

    /** What a task did: the tools it called, how it ended, what it changed and what was said. */
    const task = async (text: string): Promise<void> => {
      const seen = done().length;
      await adapter.sendPrompt(session.id, { text });
      const terminal = await untilDone(seen, 90);
      const turn = about().slice(about().findIndex((event) => event.type === 'session.inbox.enqueued' && (event.data as { item?: { payload?: { text?: string } } })?.item?.payload?.text === text));
      log(`task "${text}"`, {
        terminal: terminal.map(event => ({ type: event.type, data: event.data })),
        tools: turn.filter(event => event.type === 'session.tool.input.started').map(event => event.data?.name),
        refused: turn.filter(event => /error|permission|denied|reject/.test(event.type)).map(event => ({ type: event.type, data: event.data })),
        diff: await raw('GET', `/api/session/${session.id}/diff`),
      });
      const answer = await raw('GET', `/api/session/${session.id}/message`);
      const list = (answer.body as { data?: Array<Record<string, unknown>> }).data ?? [];
      log('the messages', list.map(message => ({
        type: message.type, agent: message.agent, outcome: message.outcome, finish: message.finish, text: message.text,
        content: (message.content as Array<Record<string, unknown>> | undefined)?.map(part =>
          part.type === 'tool' ? { type: 'tool', name: part.name, executed: part.executed, state: part.state } : part),
      })));
    };

    // One task: read a file and answer. The session ends by itself.
    await task('Read README.md in this repository and reply with its first line only.');
    const after = (await raw('GET', `/api/session/${session.id}/message`)).body;
    assert.ok(after && JSON.stringify(after).includes('Workbench read-only check'), 'the first line of the file is not in the messages');
    // Every answer is the read-only agent's, only what reads was called, and nothing in the project changed.
    const agents = ((await raw('GET', `/api/session/${session.id}/message`)).body as { data: Array<Record<string, unknown>> }).data
      .filter(message => message.type === 'assistant').map(message => message.agent);
    assert.ok(agents.length > 0, 'no assistant message was stored');
    assert.deepEqual([...new Set(agents)], [READONLY_AGENT_ID], 'an answer is attributed to another agent');
    const tools = about().filter(event => event.type === 'session.tool.input.started').map(event => String(event.data?.name));
    assert.ok(tools.length > 0, 'the model read nothing');
    assert.deepEqual([...new Set(tools)].filter(name => !['read', 'glob', 'list'].includes(name)), [], 'a tool that does not read was called');
    assert.deepEqual(files(repo), before, 'something in the project changed');

    // A task that needs to write. The agent has no tool for it, and may not run a command: nothing is written.
    await task('Create a file named NOTE.txt in this repository that contains the word hello.');
    assert.deepEqual(files(repo), before, 'something in the project changed');

    // A task that needs a secrets file. It asks first, and nobody answers here, so the session keeps waiting.
    const seen = done().length;
    await adapter.sendPrompt(session.id, { text: 'Print the content of the .env file of this repository.' });
    let asking: Event[] = [];
    for (let attempt = 0; attempt < 150 && asking.length === 0 && done().length <= seen; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 200));
      asking = about().filter(event => /permission/.test(event.type));
    }
    log('after the secrets task, permission events', asking);
    log('event types of the secrets task', [...new Set(about().map(event => event.type))]);
    log('terminal events of the secrets task', done().slice(seen).map(event => ({ type: event.type, data: event.data })));
    log('GET /api/session/:id/permission', await raw('GET', `/api/session/${session.id}/permission`));
    // How a request is answered: `decision` is the key the route asks for (read by trying `action` and `respond`).
    const requestID = String((asking[0]?.data as Record<string, unknown> | undefined)?.id ?? 'unknown');
    for (const decision of ['reject', 'deny', 'cancelled']) {
      const reply = await raw('POST', `/api/session/${session.id}/permission/${requestID}/reply`, { decision });
      log(`POST /api/session/:id/permission/:requestID/reply {"decision":"${decision}"}`, reply);
      if (reply.status < 400) break;
    }
    log('pending after the answer', await raw('GET', `/api/session/${session.id}/permission`));
    log('terminal events after the answer', (await untilDone(seen, 60)).map(event => ({ type: event.type, data: event.data })));
    log('event types after the answer', [...new Set(about().map(event => event.type))]);
    log('stopped', await adapter.abort(session.id));
    const end = await raw('GET', `/api/session/${session.id}/message`);
    log('messages at the end', end.body);
    // The secrets file was never read: it asks first, and it was not allowed to.
    assert.ok(!JSON.stringify(end.body).includes(secret), 'the secrets file was read without being allowed to');
    assert.deepEqual(files(repo), before, 'something in the project changed');
    void listening;
  } finally {
    controller.abort();
    await kill();
    rmSync(lab, { recursive: true, force: true });
  }
});

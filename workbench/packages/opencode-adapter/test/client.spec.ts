import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  OpenCodeError, OpenCodeHttpAdapter, READONLY_AGENT_ID, VERIFIED_VERSION, assertVerifiedVersion, managedConfigContent,
  readOnlyProblems,
} from '../src/index.ts';
import { startMockOpenCode, type MockOpenCode } from './mock-server.mjs';

const ONE = '/projects/one';
const TWO = '/projects/two';
const THREE = '/projects/three';

async function fixture(options: { password?: string; directory?: string } = {}) {
  const server = await startMockOpenCode({ directory: options.directory ?? ONE, password: options.password });
  const adapter = (directory = ONE, extra: Record<string, unknown> = {}) => new OpenCodeHttpAdapter({
    baseUrl: server.origin, directory, ...(options.password === undefined ? {} : { password: options.password }), ...extra,
  });
  return { server, adapter };
}
const kindOf = (error: unknown): string | undefined => (error instanceof OpenCodeError ? error.kind : undefined);
/** Reads events until `count` have come, then stops the stream. */
async function collect(adapter: OpenCodeHttpAdapter, count: number, timeoutMs = 2_000): Promise<unknown[]> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const events: unknown[] = [];
  try {
    for await (const event of adapter.subscribeEvents(controller.signal)) {
      events.push(event);
      if (events.length >= count) break;
    }
  } finally { clearTimeout(timer); controller.abort(); }
  return events;
}

test('the server says which OpenCode it is, and another version than the verified one is refused', async () => {
  const { server, adapter } = await fixture();
  try {
    const info = await adapter().info();
    assert.deepEqual([info.version, info.pid, info.hostname], [VERIFIED_VERSION, process.pid, info.hostname]);
    assert.equal(assertVerifiedVersion(info), undefined);
    // `info` reports any version; the check is what refuses one that was not read and verified.
    server.version = '2.3.0';
    const other = await adapter().info();
    assert.equal(other.version, '2.3.0');
    assert.throws(() => assertVerifiedVersion(other), (error: unknown) =>
      kindOf(error) === 'incompatible_version' && (error as Error).message.includes('2.3.0'));
    // An answer that is not a server description is not one, whatever else it says.
    for (const override of [{ version: '2.2.7' }, { version: '2.2.7', pid: 0, hostname: 'h' }, ['2.2.7'], null]) {
      server.infoOverride = override;
      await assert.rejects(adapter().info(), (error: unknown) => kindOf(error) === 'protocol', JSON.stringify(override));
    }
    server.infoOverride = undefined;
  } finally { await server.close(); }
});

test('a session is created in the directory of the adapter, with that directory named in the request', async () => {
  const { server, adapter } = await fixture({ password: 'secret' });
  try {
    const session = await adapter(ONE).createSession({ title: 'Look around' });
    assert.match(session.id, /^ses_/);
    assert.equal(session.directory, ONE);
    assert.equal(session.title, 'Look around');
    const request = server.requests.at(-1)!;
    assert.deepEqual([request.method, request.path, request.directory, request.body],
      ['POST', '/api/session', ONE, { title: 'Look around' }]);
    assert.equal(request.authorization, `Basic ${Buffer.from('opencode:secret').toString('base64')}`);
    // A title that is not a title never leaves the Workbench.
    await assert.rejects(adapter().createSession({ title: 'x'.repeat(501) }), (error: unknown) => kindOf(error) === 'invalid_request');
    // A server that binds the session to another directory did not make this project's session.
    server.bindTo = TWO;
    await assert.rejects(adapter().createSession({ title: 'elsewhere' }), (error: unknown) => kindOf(error) === 'protocol');
  } finally { await server.close(); }
});

test('a session of another project is not found, asked, read or stopped through this project', async () => {
  const { server, adapter } = await fixture();
  try {
    const mine = await adapter(ONE).createSession({ title: 'one' });
    const theirs = await adapter(TWO).createSession({ title: 'two' });
    assert.equal(theirs.directory, TWO);
    // The server lists both together; the adapter for one project sees only its own.
    assert.equal(server.sessions.size, 2);
    assert.equal((await adapter(ONE).getSession(theirs.id)), null);
    assert.equal((await adapter(TWO).getSession(mine.id)), null);
    assert.equal((await adapter(ONE).getSession(mine.id))?.title, 'one');
    assert.equal((await adapter(ONE).getSession('ses_doesNotExist')), null);
    for (const call of [
      () => adapter(ONE).sendPrompt(theirs.id, { text: 'hello' }),
      () => adapter(ONE).getMessages(theirs.id),
      () => adapter(ONE).abort(theirs.id),
    ]) {
      await assert.rejects(call(), (error: unknown) => kindOf(error) === 'not_found');
    }
    // Each call looks the session up first and stops there: nothing is ever written to the other session.
    const theirsFromOurs = server.requests.filter(request => request.path.includes(theirs.id) && request.directory === ONE);
    assert.ok(theirsFromOurs.length >= 3, 'the other project was not asked three times');
    assert.deepEqual([...new Set(theirsFromOurs.map(request => request.method))], ['GET']);
  } finally { await server.close(); }
});

test('a prompt is queued as the user\'s message and the messages are listed oldest first', async () => {
  const { server, adapter } = await fixture();
  try {
    const session = await adapter().createSession({ title: 'question' });
    const sent = await adapter().sendPrompt(session.id, { text: 'What is here?' });
    assert.equal(sent.type, 'user');
    assert.equal(sent.text, 'What is here?');
    assert.equal(sent.sessionID, session.id);
    const request = server.requests.at(-1)!;
    assert.equal(request.path, `/api/session/${session.id}/prompt`);
    // The text and nothing else: the agent that runs a prompt is the session's, not a field of the prompt.
    assert.deepEqual(request.body, { text: 'What is here?' });
    await new Promise(resolve => setTimeout(resolve, 3));
    await adapter().sendPrompt(session.id, { text: 'And there?' });
    const messages = await adapter().getMessages(session.id);
    assert.deepEqual(messages.map(message => [message.type, message.text]), [['user', 'What is here?'], ['user', 'And there?']]);
    assert.ok(messages.every(message => message.sessionID === session.id && message.id.startsWith('msg_')), 'a message of another session, or not a message, was listed');
    assert.deepEqual((await adapter().getMessages((await adapter().createSession({ title: 'empty' })).id)), []);
    // A prompt that is not text is refused here; a session id that is not one never becomes a path.
    await assert.rejects(adapter().sendPrompt(session.id, { text: '   ' }), (error: unknown) => kindOf(error) === 'invalid_request');
    await assert.rejects(adapter().sendPrompt('../event', { text: 'x' }), (error: unknown) => kindOf(error) === 'invalid_request');
    assert.equal(server.requests.some(request => request.path.includes('/event') && request.method === 'POST'), false);
  } finally { await server.close(); }
});

test('the agent a session runs is switched, and the session is given out only when it says it runs that agent', async () => {
  const { server, adapter } = await fixture();
  try {
    const session = await adapter().createSession({ title: 'look around' });
    // A new session has no agent of its own. The server's default agent runs then, and that one may edit and run commands.
    assert.equal(session.agent, null, 'a new session has an agent of its own');
    assert.equal((await adapter().setSessionAgent(session.id, 'plan')).agent, 'plan');
    assert.equal((await adapter().getSession(session.id))?.agent, 'plan');
    // The switch, and the reading back of the session after it.
    const switchAt = server.requests.findIndex(request => request.path === `/api/session/${session.id}/agent`);
    const switchRequest = server.requests[switchAt];
    assert.deepEqual([switchRequest?.method, switchRequest?.body], ['POST', { agent: 'plan' }]);
    assert.deepEqual([server.requests[switchAt + 1]?.method, server.requests[switchAt + 1]?.path],
      ['GET', `/api/session/${session.id}`]);

    // What is not a name is refused here, and a session of another project is not switched through this one.
    await assert.rejects(adapter().setSessionAgent(session.id, 'bad agent/../'), (error: unknown) => kindOf(error) === 'invalid_request');
    const theirs = await adapter(TWO).createSession({ title: 'theirs' });
    await assert.rejects(adapter().setSessionAgent(theirs.id, 'plan'), (error: unknown) => kindOf(error) === 'not_found');

    // A server that answers the switch and does not switch: the session is not given out as switched.
    server.agentSwitchIgnored = true;
    await assert.rejects(adapter().setSessionAgent(session.id, 'explore'), (error: unknown) => kindOf(error) === 'refused');
    assert.equal((await adapter().getSession(session.id))?.agent, 'plan');

    // The route takes any name. Whether that agent is there is for the next task to find out.
    server.agentSwitchIgnored = false;
    assert.equal((await adapter().setSessionAgent(session.id, 'nobody')).agent, 'nobody');
  } finally { await server.close(); }
});

test('the sessions of the project are listed as the server lists them, and none of another project', async () => {
  const { server, adapter } = await fixture();
  try {
    await adapter().createSession({ title: 'first' });
    await adapter().createSession({ title: 'second' });
    await adapter(TWO).createSession({ title: 'theirs' });
    // The server lists the sessions of every directory together, the newest first.
    assert.deepEqual((await adapter().listSessions()).map(session => session.title), ['second', 'first']);
    assert.deepEqual((await adapter(TWO).listSessions()).map(session => session.title), ['theirs']);
    // Apart from the three sessions that were created, nothing was asked for but a reading.
    assert.deepEqual(server.requests.filter(request => request.method !== 'GET').map(request => request.path),
      ['/api/session', '/api/session', '/api/session']);
  } finally { await server.close(); }
});

test('stopping a session reports whether anything was stopped', async () => {
  const { server, adapter } = await fixture();
  try {
    const session = await adapter().createSession({ title: 'work' });
    await adapter().sendPrompt(session.id, { text: 'go on' });
    assert.deepEqual(await adapter().abort(session.id), { interrupted: true });
    assert.deepEqual(await adapter().abort(session.id), { interrupted: false });
  } finally { await server.close(); }
});

test('the event stream yields the typed events of the server and nothing else, and stops when asked', async () => {
  const { server, adapter } = await fixture();
  try {
    const controller = new AbortController();
    const events: unknown[] = [];
    const reading = (async () => {
      for await (const event of adapter().subscribeEvents(controller.signal)) events.push(event);
    })();
    // The first event says that the server is there.
    await new Promise(resolve => setTimeout(resolve, 100));
    server.emit({ id: 'evt_1', type: 'session.created', data: { id: 'ses_x' }, location: { directory: ONE } });
    server.emit({ not: 'typed' });
    await new Promise(resolve => setTimeout(resolve, 100));
    controller.abort();
    await reading;
    const types = (events as { type: string }[]).map(event => event.type);
    assert.equal(types[0], 'server.connected');
    assert.ok(types.includes('session.created'), 'the session.created event did not come');
    assert.ok(types.includes('unparseable'), 'an event without a type is handed over as unreadable, not dropped silently');
    assert.equal(types.includes('heartbeat'), false);
    // An aborted stream ends without an error.
    const stopped = new AbortController();
    stopped.abort();
    const none: unknown[] = [];
    for await (const event of adapter().subscribeEvents(stopped.signal)) none.push(event);
    assert.deepEqual(none, []);
  } finally { await server.close(); }
});

test('every way the server can fail is one kind of error', async () => {
  const { server, adapter } = await fixture({ password: 'secret' });
  const closed = await startMockOpenCode({ directory: ONE });
  const deadOrigin = closed.origin;
  await closed.close();
  try {
    const session = await adapter().createSession({ title: 'kept' });
    // Wrong password, wrong session, a path the server does not have under /api, and its web page.
    const wrong = adapter(ONE, { password: 'nope' });
    await assert.rejects(wrong.info(), (error: unknown) => kindOf(error) === 'unauthorized' && (error as OpenCodeError).status === 401);
    // A session that is not there is null from `getSession`, and not found from everything that needs one.
    assert.equal(await adapter().getSession('ses_gone'), null);
    await assert.rejects(adapter().abort('ses_gone'), (error: unknown) => kindOf(error) === 'not_found');
    server.missing.add('/api/info');
    await assert.rejects(adapter().info(), (error: unknown) => kindOf(error) === 'protocol' && (error as OpenCodeError).status === 404);
    server.missing.clear();
    // The page the server returns for a path it does not know is not an answer.
    server.htmlOnly = true;
    await assert.rejects(adapter().info(), (error: unknown) => kindOf(error) === 'protocol');
    await assert.rejects(async () => { for await (const _ of adapter().subscribeEvents()) break; },
      (error: unknown) => kindOf(error) === 'protocol');
    server.htmlOnly = false;
    // The base address itself has to be an origin: a path in it is refused before any request is made.
    assert.throws(() => new OpenCodeHttpAdapter({ baseUrl: `${server.origin}/global`, directory: ONE, password: 'secret' }),
      (error: unknown) => kindOf(error) === 'protocol');
    // A proxy may change the status and keep the body: the error document still says what was wrong.
    server.statusOverride = 403;
    await assert.rejects(wrong.info(), (error: unknown) => kindOf(error) === 'unauthorized' && (error as OpenCodeError).status === 403);
    // A proxy in front of the server answers with a status and nothing else.
    server.bareStatus = 401;
    await assert.rejects(adapter().info(), (error: unknown) => kindOf(error) === 'unauthorized' && (error as OpenCodeError).status === 401);
    server.bareStatus = 503;
    await assert.rejects(adapter().info(), (error: unknown) => kindOf(error) === 'refused' && (error as OpenCodeError).status === 503);
    // Nothing listens there.
    await assert.rejects(new OpenCodeHttpAdapter({ baseUrl: deadOrigin, directory: ONE }).info(),
      (error: unknown) => kindOf(error) === 'unavailable');
    // The server does not answer in time: a request, and a stream that does not connect.
    server.delayMs = 500;
    const impatient = (directory: string) => adapter(directory, { timeoutMs: 80 });
    await assert.rejects(impatient(ONE).info(), (error: unknown) => kindOf(error) === 'timeout');
    await assert.rejects(async () => { for await (const _ of impatient(ONE).subscribeEvents()) break; },
      (error: unknown) => kindOf(error) === 'timeout');
    server.delayMs = 0;
    // What this adapter will not even try.
    for (const options of [
      { baseUrl: 'http://example.com', directory: ONE },
      { baseUrl: 'http://127.0.0.1:1/api', directory: ONE },
      { baseUrl: 'ftp://127.0.0.1', directory: ONE },
      { baseUrl: server.origin, directory: 'relative/path' },
    ]) {
      assert.throws(() => new OpenCodeHttpAdapter(options), (error: unknown) => kindOf(error) === 'protocol', JSON.stringify(options));
    }
  } finally { await server.close(); }
});

test('a stream that is stopped before it connects yields nothing and fails nothing', async () => {
  const { server, adapter } = await fixture();
  try {
    const stopped = new AbortController();
    stopped.abort(new Error('no longer needed'));
    const events: unknown[] = [];
    for await (const event of adapter().subscribeEvents(stopped.signal)) events.push(event);
    assert.deepEqual(events, []);
  } finally { await server.close(); }
});

test('the agents of the project are listed, and one is read by name once its list was asked', async () => {
  const { server, adapter } = await fixture();
  try {
    // Right after a start the list can be empty. That is asked again, not taken for the project's agents.
    server.agentFirstListEmpty = true;
    assert.deepEqual(await adapter(ONE).listAgents(), []);
    assert.deepEqual((await adapter(ONE).listAgents()).map(agent => agent.id), ['build', 'compaction', 'title', 'summary', 'plan']);
    assert.deepEqual([server.requests.at(-1)?.method, server.requests.at(-1)?.path, server.requests.at(-1)?.directory],
      ['GET', '/api/agent', ONE]);
    const plan = await adapter(ONE).getAgent('plan');
    assert.equal(plan?.mode, 'primary');
    assert.deepEqual(plan?.permissions.map(rule => rule.action), ['*', 'read', 'read', 'read', 'question', 'edit', 'edit']);
    // The server's hidden agents come without a description.
    assert.deepEqual((await adapter(ONE).getAgent('title'))?.description, '');
    assert.equal(await adapter(ONE).getAgent('nobody'), null);

    // Another directory's agents are not loaded by asking for this one's, and by name they come only after its list.
    assert.equal(await adapter(TWO).getAgent('plan'), null);
    await adapter(TWO).listAgents();
    assert.equal((await adapter(TWO).getAgent('plan'))?.id, 'plan');

    // A directory that is not there any more.
    server.missingDirectories.add(THREE);
    await assert.rejects(adapter(THREE).listAgents(), (error: unknown) => kindOf(error) === 'directory_unavailable');
    await assert.rejects(adapter(THREE).getAgent('plan'), (error: unknown) => kindOf(error) === 'directory_unavailable');
    // Answers that are not what was asked for: about another directory, or without the rules.
    await assert.rejects(adapter().getAgent('not an id'), (error: unknown) => kindOf(error) === 'invalid_request');
    server.agentLocation = TWO;
    await assert.rejects(adapter(ONE).listAgents(), (error: unknown) => kindOf(error) === 'protocol');
    await assert.rejects(adapter(ONE).getAgent('plan'), (error: unknown) => kindOf(error) === 'protocol');
    server.agentLocation = null;
    server.agentShape = 'malformed';
    await assert.rejects(adapter(ONE).listAgents(), (error: unknown) => kindOf(error) === 'protocol');
    await assert.rejects(adapter(ONE).getAgent('plan'), (error: unknown) => kindOf(error) === 'protocol');
    // Another agent under the name that was asked for is not that agent.
    server.agentShape = 'another';
    await assert.rejects(adapter(ONE).getAgent('plan'), (error: unknown) => kindOf(error) === 'protocol');
  } finally { await server.close(); }
});

test('the read-only agent comes back with the rules the server computed, and is proven by them', async () => {
  const server = await startMockOpenCode({ configContent: managedConfigContent(undefined) });
  try {
    const adapter = new OpenCodeHttpAdapter({ baseUrl: server.origin, directory: ONE });
    // By name alone it is not there yet: the list is what makes the server load the agents of a directory.
    assert.equal(await adapter.getAgent(READONLY_AGENT_ID), null);
    assert.ok((await adapter.listAgents()).some(agent => agent.id === READONLY_AGENT_ID), 'the read-only agent is not listed');
    const agent = await adapter.getAgent(READONLY_AGENT_ID);
    assert.equal(agent?.id, READONLY_AGENT_ID);
    assert.deepEqual(readOnlyProblems(agent!), []);
    // Nothing was written anywhere to get to know this agent.
    assert.deepEqual(server.requests.map(request => `${request.method} ${request.path}`),
      ['GET /api/agent/workbench-readonly', 'GET /api/agent', 'GET /api/agent/workbench-readonly']);
  } finally { await server.close(); }
});

test('a conversation is read as the server stores it, and from its beginning', async () => {
  const { server, adapter } = await fixture();
  try {
    const session = await adapter().createSession({ title: 'talk' });
    await adapter().sendPrompt(session.id, { text: 'What is here?' });
    server.answer(session.id, {
      reasoning: 'Look first.', text: 'A README.',
      tools: [{ name: 'read', input: { path: 'README.md' }, output: 'first line' }], agent: 'workbench-readonly',
    });
    server.idle(session.id, 'succeeded');
    await adapter().setSessionAgent(session.id, 'plan');
    server.ask(session.id, 'read', ['.env']);
    server.answer(session.id, {
      tools: [{ name: 'read', input: { path: '.env' }, status: 'error', error: 'Rejected by user' }], error: 'The tool was rejected',
    });
    await adapter().abort(session.id);

    // The server lists the newest first. A conversation is read from its beginning.
    const messages = await adapter().getMessages(session.id);
    assert.deepEqual(messages.map(message => message.type), ['user', 'assistant', 'idle', 'agent-switched', 'assistant', 'idle']);
    const [user, answer, idle, switched, refused, ended] = messages;
    assert.deepEqual([user.text, user.sessionID, user.parts, user.agent], ['What is here?', session.id, [], null]);
    const call = answer.parts[2] as Extract<typeof answer.parts[number], { type: 'tool' }>;
    assert.deepEqual(answer.parts.slice(0, 2), [{ type: 'reasoning', text: 'Look first.' }, { type: 'text', text: 'A README.' }]);
    assert.deepEqual([call.name, call.status, call.input, call.output, call.error], ['read', 'completed', '{"path":"README.md"}', 'first line', null]);
    assert.match(call.id, /^tool_/);
    assert.deepEqual([answer.text, answer.agent, answer.model, answer.changed, answer.outcome, answer.error],
      ['A README.', 'workbench-readonly', 'one/model', false, null, null]);
    assert.deepEqual([idle.outcome, idle.text, switched.agent, switched.type], ['succeeded', '', 'plan', 'agent-switched']);
    const denied = refused.parts[0] as Extract<typeof refused.parts[number], { type: 'tool' }>;
    assert.deepEqual([refused.text, denied.status, denied.output, denied.error, refused.error, refused.changed],
      ['', 'error', '', 'Rejected by user', 'The tool was rejected', false]);
    assert.equal(ended.outcome, 'interrupted');

    // Whether the Git state moved during a step is read from the snapshots the server keeps.
    const other = await adapter().createSession({ title: 'edits' });
    server.answer(other.id, { text: 'Done.', changed: true, tools: [{ name: 'read' }] });
    const edited = (await adapter().getMessages(other.id))[0];
    assert.deepEqual([edited.changed, edited.text, edited.agent], [true, 'Done.', 'build']);
    assert.deepEqual((edited.parts[1] as { status: string; input: string; output: string }).status, 'completed');

    // An entry that is not a message is not passed over as an empty conversation.
    server.messageShape = 'malformed';
    await assert.rejects(adapter().getMessages(other.id), (error: unknown) => kindOf(error) === 'protocol');
  } finally { await server.close(); }
});

test('what the agent asks to be allowed is listed and answered, for this session only', async () => {
  const { server, adapter } = await fixture();
  try {
    const session = await adapter().createSession({ title: 'ask' });
    assert.deepEqual(await adapter().pendingPermissions(session.id), []);
    const asked = server.ask(session.id, 'read', ['.env']);
    const theirs = await adapter(TWO).createSession({ title: 'theirs' });
    const theirAsk = server.ask(theirs.id, 'bash', ['ls']);
    // Only what this session asks, and named with the session.
    assert.deepEqual(await adapter().pendingPermissions(session.id), [{ id: asked.id, sessionID: session.id, action: 'read', resources: ['.env'] }]);
    assert.deepEqual((await adapter(TWO).pendingPermissions(theirs.id)).map(one => one.id), [theirAsk.id]);
    // A session of another project is not asked or answered through this one.
    await assert.rejects(adapter().pendingPermissions(theirs.id), (error: unknown) => kindOf(error) === 'not_found');
    await assert.rejects(adapter().replyPermission(theirs.id, theirAsk.id, 'reject'), (error: unknown) => kindOf(error) === 'not_found');

    // What is not a decision, or not a request, is refused here, and nothing is sent.
    const before = server.requests.length;
    await assert.rejects(adapter().replyPermission(session.id, asked.id, 'perhaps' as 'allow'), (error: unknown) => kindOf(error) === 'invalid_request');
    await assert.rejects(adapter().replyPermission(session.id, 'not an id', 'allow'), (error: unknown) => kindOf(error) === 'invalid_request');
    assert.equal(server.requests.length, before, 'something was sent for a request that is not one');
    // A request that is not there any more is not found.
    await assert.rejects(adapter().replyPermission(session.id, 'per_nobody', 'reject'), (error: unknown) => kindOf(error) === 'not_found');

    // Rejected: it waits no more, and the answer went to the reply route under `decision`.
    await adapter().replyPermission(session.id, asked.id, 'reject');
    const sent = server.requests.filter(request => request.path === `/api/session/${session.id}/permission/${asked.id}/reply`).at(-1);
    assert.deepEqual([sent?.method, sent?.body], ['POST', { decision: 'reject' }]);
    assert.deepEqual(await adapter().pendingPermissions(session.id), []);
    const again = server.ask(session.id, 'write', ['a.txt']);
    await adapter().replyPermission(session.id, again.id, 'allow');
    assert.deepEqual(server.permissions.size, 1);
  } finally { await server.close(); }
});

test('the events of one session come through alone', async () => {
  const { server, adapter } = await fixture();
  try {
    const session = await adapter().createSession({ title: 'mine' });
    const theirs = await adapter(TWO).createSession({ title: 'theirs' });
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 3_000);
    const seen: string[] = [];
    const reading = (async () => {
      for await (const event of adapter().sessionEvents(session.id, controller.signal)) seen.push(event.type);
    })();
    try {
      // Nothing is emitted before the server has the stream, or it would go nowhere.
      for (let attempt = 0; attempt < 100 && !server.requests.some(request => request.path === '/api/event'); attempt++) {
        await new Promise(resolve => setTimeout(resolve, 20));
      }
      await new Promise(resolve => setTimeout(resolve, 50));
      for (let attempt = 0; attempt < 100 && seen.length < 2; attempt++) {
        server.emit({ type: 'server.something', data: {} });
        server.emit({ type: 'session.execution.started', data: { sessionID: theirs.id } });
        if (attempt === 0) {
          server.emit({ type: 'session.execution.started', data: { sessionID: session.id } });
          server.ask(session.id, 'read', ['.env']);
        }
        await new Promise(resolve => setTimeout(resolve, 30));
      }
    } finally { controller.abort(); await reading.catch(() => undefined); clearTimeout(timer); }
    assert.deepEqual(seen, ['session.execution.started', 'permission.asked']);
  } finally { await server.close(); }
});

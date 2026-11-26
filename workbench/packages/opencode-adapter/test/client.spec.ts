import assert from 'node:assert/strict';
import { test } from 'node:test';
import { OpenCodeError, OpenCodeHttpAdapter, VERIFIED_VERSION, assertVerifiedVersion } from '../src/index.ts';
import { startMockOpenCode, type MockOpenCode } from './mock-server.ts';

const ONE = '/projects/one';
const TWO = '/projects/two';

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
    assert.ok(theirsFromOurs.length >= 3);
    assert.deepEqual([...new Set(theirsFromOurs.map(request => request.method))], ['GET']);
  } finally { await server.close(); }
});

test('a prompt is queued as the user\'s message and the messages are listed oldest first', async () => {
  const { server, adapter } = await fixture();
  try {
    const session = await adapter().createSession({ title: 'question' });
    const sent = await adapter().sendPrompt(session.id, { text: 'What is here?', agent: 'Explore', model: { providerID: 'p', modelID: 'm' } });
    assert.equal(sent.type, 'user');
    assert.equal(sent.text, 'What is here?');
    assert.equal(sent.sessionID, session.id);
    const request = server.requests.at(-1)!;
    assert.equal(request.path, `/api/session/${session.id}/prompt`);
    assert.deepEqual(request.body, { text: 'What is here?', agent: 'Explore', model: { providerID: 'p', modelID: 'm' } });
    await new Promise(resolve => setTimeout(resolve, 3));
    await adapter().sendPrompt(session.id, { text: 'And there?' });
    const messages = await adapter().getMessages(session.id);
    assert.deepEqual(messages.map(message => [message.type, message.text]), [['user', 'What is here?'], ['user', 'And there?']]);
    assert.ok(messages.every(message => message.sessionID === session.id && message.id.startsWith('msg_')));
    assert.deepEqual((await adapter().getMessages((await adapter().createSession({ title: 'empty' })).id)), []);
    // A prompt that is not text is refused here; a session id that is not one never becomes a path.
    await assert.rejects(adapter().sendPrompt(session.id, { text: '   ' }), (error: unknown) => kindOf(error) === 'invalid_request');
    await assert.rejects(adapter().sendPrompt('../event', { text: 'x' }), (error: unknown) => kindOf(error) === 'invalid_request');
    await assert.rejects(adapter().sendPrompt(session.id, { text: 'x', agent: 'bad agent/../' }), (error: unknown) => kindOf(error) === 'invalid_request');
    assert.equal(server.requests.some(request => request.path.includes('/event') && request.method === 'POST'), false);
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
    assert.ok(types.includes('session.created'));
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

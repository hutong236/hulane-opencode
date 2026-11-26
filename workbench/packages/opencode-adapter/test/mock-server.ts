import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { hostname } from 'node:os';

/**
 * A server that behaves like the OpenCode 2.2.7 server this adapter was read from. Every route, envelope and error
 * below was taken from a real server on 2026-11-26; when the real one changes, this one has to be read again.
 */
interface SessionRow {
  id: string; projectID: string; cost: number; tokens: Record<string, number>;
  time: { created: number; updated: number }; title: string; location: { directory: string };
}
interface MessageRow { id: string; sessionID: string; time: { created: number }; type: string; payload: { text: string }; delivery: string }
interface Recorded { method: string; path: string; directory?: string; authorization?: string; body: unknown }

export interface MockOpenCode {
  origin: string;
  requests: Recorded[];
  sessions: Map<string, SessionRow>;
  messages: Map<string, MessageRow[]>;
  running: Set<string>;
  /** Where a new session is bound when set. Left out, a session is bound to the directory the request named. */
  bindTo: string | undefined;
  version: string;
  /** Makes the next answer wait this long, to run a request into its timeout. */
  delayMs: number;
  /** Ways to be not the server that was promised. */
  infoOverride: unknown;
  missing: Set<string>;
  htmlOnly: boolean;
  /** When set, one answer is this status with an empty body, as a proxy in front of the server would give. */
  bareStatus: number | null;
  /** When set, the next answer is sent with this status instead of its own. */
  statusOverride: number | null;
  emit: (event: Record<string, unknown>) => void;
  close: () => Promise<void>;
}

let counter = 0;
const id = (prefix: string): string => `${prefix}_mock${String(++counter).padStart(6, '0')}`;
const SESSION = /^ses_[A-Za-z0-9]+$/;

export async function startMockOpenCode(options: { password?: string; directory: string } = {} as never): Promise<MockOpenCode> {
  const clients = new Set<ServerResponse>();
  const state: MockOpenCode = {
    origin: '', requests: [], sessions: new Map(), messages: new Map(), running: new Set(),
    bindTo: undefined, version: '2.2.7', delayMs: 0, infoOverride: undefined, missing: new Set(), htmlOnly: false, bareStatus: null, statusOverride: null,
    emit: () => undefined,
    close: async () => new Promise(resolve => server.close(() => resolve())),
  };
  const json = (response: ServerResponse, ownStatus: number, body: unknown) => {
    const status = state.statusOverride ?? ownStatus;
    state.statusOverride = null;
    response.writeHead(status, { 'content-type': 'application/json' });
    response.end(JSON.stringify(body));
  };
  const unauthorized = (response: ServerResponse) =>
    json(response, 401, { _tag: 'UnauthorizedError', message: 'Authentication required' });
  const sse = (event: unknown): string => `data: ${JSON.stringify(event)}\n\n`;

  const server: Server = createServer(async (request, response) => {
    const url = new URL(request.url ?? '/', 'http://mock');
    const method = request?.method ?? 'GET';
    const chunks: Buffer[] = [];
    for await (const chunk of request as IncomingMessage) chunks.push(chunk as Buffer);
    const text = Buffer.concat(chunks).toString('utf8');
    const body = text ? JSON.parse(text) as unknown : undefined;
    state.requests.push({
      method, path: url.pathname, directory: request.headers['x-opencode-directory'] as string | undefined,
      authorization: request.headers.authorization, body,
    });
    // Everything lives under /api. Any other path gets the web page, with status 200.
    if (state.htmlOnly || !url.pathname.startsWith('/api/')) {
      response.writeHead(200, { 'content-type': 'text/html' });
      response.end('<!doctype html><html><title>OpenCode</title></html>');
      return;
    }
    if (options.password && request.headers.authorization !== `Basic ${Buffer.from(`opencode:${options.password}`).toString('base64')}`) {
      return unauthorized(response);
    }
    if (state.delayMs) await new Promise(resolve => setTimeout(resolve, state.delayMs));
    const path = url.pathname;
    if (state.missing.has(path)) { response.writeHead(404); response.end(); return; }
    if (state.bareStatus !== null) {
      response.writeHead(state.bareStatus);
      response.end();
      state.bareStatus = null;
      return;
    }
    if (method === 'GET' && path === '/api/info') {
      if (state.infoOverride !== undefined) return json(response, 200, state.infoOverride);
      return json(response, 200, {
        version: state.version, pid: process.pid, hostname: hostname(), urls: [state.origin],
        paths: { tmp: '/tmp/opencode' }, capabilities: { persistentPty: true },
      });
    }
    if (method === 'GET' && path === '/api/event') {
      response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
      response.write(sse({ id: id('evt'), type: 'server.connected', data: {} }));
      clients.add(response);
      request.on('close', () => clients.delete(response));
      return;
    }
    if (path === '/api/session' && method === 'GET') {
      // The real server lists sessions of every directory together.
      return json(response, 200, { data: [...state.sessions.values()], cursor: { previous: 'ses_older', next: null } });
    }
    if (path === '/api/session' && method === 'POST') {
      const now = Date.now();
      const session: SessionRow = {
        id: id('ses'), projectID: 'prj_mock', cost: 0, tokens: { input: 0, output: 0 },
        time: { created: now, updated: now }, title: String((body as { title?: string })?.title ?? ''),
        location: { directory: state.bindTo ?? String(request.headers['x-opencode-directory'] ?? '') },
      };
      state.sessions.set(session.id, session);
      state.messages.set(session.id, []);
      state.emit({ id: id('evt'), type: 'session.created', data: { }, location: { directory: session.location.directory } });
      return json(response, 200, { data: session });
    }
    const match = /^\/api\/session\/([^/]+)(?:\/(prompt|message|interrupt))?$/.exec(path);
    if (match) {
      const [, sessionID, action] = match;
      if (!SESSION.test(sessionID)) {
        return json(response, 400, { _tag: 'InvalidRequestError', message: 'Invalid session id', kind: 'Params' });
      }
      const session = state.sessions.get(sessionID);
      if (!session) return json(response, 404, { _tag: 'SessionNotFoundError', sessionID, message: 'Session not found' });
      if (!action && method === 'GET') return json(response, 200, { data: session });
      if (action === 'message' && method === 'GET') {
        return json(response, 200, {
          data: (state.messages.get(sessionID) ?? []).map(message => ({ id: message.id, time: message.time, text: message.payload.text, type: message.type })),
          cursor: { previous: null, next: null },
        });
      }
      if (action === 'prompt' && method === 'POST') {
        if (typeof (body as { text?: unknown })?.text !== 'string') {
          return json(response, 400, { _tag: 'InvalidRequestError', message: 'Missing key\n  at ["text"]', kind: 'Payload' });
        }
        const message: MessageRow = {
          id: id('msg'), sessionID, time: { created: Date.now() }, type: 'user',
          payload: { text: (body as { text: string }).text }, delivery: 'steer',
        };
        state.messages.get(sessionID)?.push(message);
        state.running.add(sessionID);
        return json(response, 200, { data: message });
      }
      if (action === 'interrupt' && method === 'POST') {
        return json(response, 200, { interrupted: state.running.delete(sessionID) });
      }
      if (!action && method === 'DELETE') {
        state.sessions.delete(sessionID);
        response.writeHead(204);
        response.end();
        return;
      }
    }
    // A path under /api that the server does not have: 404 with nothing in the body.
    response.writeHead(404);
    response.end();
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', () => resolve()));
  const { port } = server.address() as AddressInfo;
  state.origin = `http://127.0.0.1:${port}`;
  state.emit = event => { for (const client of clients) client.write(sse(event)); };
  const heartbeat = setInterval(() => { for (const client of clients) client.write(': heartbeat\n\n'); }, 300);
  heartbeat.unref();
  state.close = async () => new Promise(resolve => {
    clearInterval(heartbeat);
    for (const client of clients) client.end();
    server.closeAllConnections();
    server.close(() => resolve(undefined));
  });
  return state;
}

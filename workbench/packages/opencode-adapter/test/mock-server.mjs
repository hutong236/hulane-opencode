import { createServer } from 'node:http';
import { hostname } from 'node:os';

/**
 * A server that behaves like the OpenCode 2.2.7 server this adapter was read from. Every route, envelope and error
 * below was taken from a real server on 2026-11-26; when the real one changes, this one has to be read again.
 *
 * Plain JavaScript, so that it runs without a loader: the tests start it in their own process, and
 * `fake-opencode.mjs` runs it as the program a managed server starts.
 */

const SESSION = /^ses_[A-Za-z0-9]+$/;

/** The rules the server puts before an agent's own, and the two it puts after them. */
const RULES_FIRST = [
  { action: '*', resource: '*', effect: 'allow' },
  { action: 'read', resource: '*.env', effect: 'ask' },
  { action: 'read', resource: '*.env.*', effect: 'ask' },
  { action: 'read', resource: '*.env.example', effect: 'allow' },
];
const RULES_LAST = [
  { action: 'browser', resource: '*', effect: 'deny' },
  { action: 'skill', resource: 'browser', effect: 'deny' },
];
const rule = (action, resource, effect) => ({ action, resource, effect });

/**
 * Five of the agents the real server lists, with the rules it computed for them. Its other two, `general` and
 * `explore`, are left out here. The hidden ones come without a description, as from the real server.
 */
export const BUILTIN_AGENTS = [
  {
    id: 'build', name: 'Build', mode: 'primary', hidden: false,
    description: 'The default agent. Executes tools based on configured permissions.',
    permissions: [...RULES_FIRST, rule('question', '*', 'allow')],
  },
  {
    id: 'compaction', name: 'Compaction', mode: 'primary', hidden: true,
    permissions: [...RULES_FIRST],
  },
  {
    id: 'title', name: 'Title', mode: 'primary', hidden: true,
    permissions: [...RULES_FIRST, rule('*', '*', 'deny')],
  },
  {
    id: 'summary', name: 'Summary', mode: 'primary', hidden: true,
    permissions: [...RULES_FIRST, rule('*', '*', 'deny')],
  },
  {
    // It calls itself read-only and is not: `edit` is denied, for one directory, and `shell` stays allowed.
    id: 'plan', name: 'Plan', mode: 'primary', hidden: false,
    description: 'Read-only agent for exploring the codebase and planning work before implementation.',
    permissions: [
      ...RULES_FIRST, rule('question', '*', 'allow'), rule('edit', '*', 'deny'),
      rule('edit', '/home/user/.opencode/plan/*', 'allow'),
    ],
  },
];

/** How the server turns an agent's `permission` into rules: a string is for every file, an object for patterns. */
function rulesOf(permission) {
  const rules = [];
  for (const [action, value] of Object.entries(permission ?? {})) {
    if (typeof value === 'string') rules.push(rule(action, '*', value));
    else if (value && typeof value === 'object') {
      for (const [resource, effect] of Object.entries(value)) rules.push(rule(action, resource, effect));
    }
  }
  return rules;
}

/**
 * The agents a server offers besides its built-in ones: those of the configuration content it was started with.
 * Under `agent` the rules of an agent are applied; under `agents` the real server lists the agent without them.
 */
export function agentsOfConfigContent(content) {
  let parsed;
  try { parsed = JSON.parse(content ?? ''); } catch { return []; }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return [];
  const own = parsed.agent ?? parsed.agents;
  if (!own || typeof own !== 'object' || Array.isArray(own)) return [];
  const applied = parsed.agent !== undefined;
  return Object.entries(own).map(([id, config]) => ({
    id, name: id, mode: config?.mode ?? 'primary', hidden: false, description: config?.description ?? '',
    permissions: [...RULES_FIRST, ...(applied ? rulesOf(config?.permission) : []), ...RULES_LAST],
  }));
}

/** Not the agent that was asked for: one without its rules, or another one altogether. */
function shaped(agents, shape) {
  if (shape === 'another') return agents.map(() => BUILTIN_AGENTS[0]);
  return shape === 'malformed' ? agents.map(({ permissions, ...rest }) => ({ ...rest, permissions: 'none' })) : agents;
}

let counter = 0;
const id = (prefix) => `${prefix}_mock${String(++counter).padStart(6, '0')}`;

export async function startMockOpenCode(options = {}) {
  const clients = new Set();
  const configContent = options.configContent ?? null;
  const state = {
    origin: '', requests: [], sessions: new Map(), messages: new Map(), running: new Set(),
    bindTo: undefined, version: '2.2.7', delayMs: 0, infoOverride: undefined, missing: new Set(), htmlOnly: false,
    bareStatus: null, statusOverride: null,
    /** When set, `/api/info` reports this pid instead of the server's own. */
    reportedPid: null,
    agents: new Map([...BUILTIN_AGENTS, ...agentsOfConfigContent(configContent)].map((agent) => [agent.id, agent])),
    /** The directories whose agents were listed once. */
    agentDirectories: new Set(),
    /** Makes the first listing of a directory answer an empty list, as the real server does right after a start. */
    agentFirstListEmpty: false,
    /** Directories answered with `LocationNotFoundError`. */
    missingDirectories: new Set(),
    /** When set, the agent answers name this directory instead of the one that was asked. */
    agentLocation: null,
    /** When true, an agent is answered without its rules: not an agent as this adapter understands one. */
    agentShape: 'ok',
    emit: () => undefined,
    close: async () => undefined,
  };
  const json = (response, ownStatus, body) => {
    const status = state.statusOverride ?? ownStatus;
    state.statusOverride = null;
    response.writeHead(status, { 'content-type': 'application/json' });
    response.end(JSON.stringify(body));
  };
  const unauthorized = (response) =>
    json(response, 401, { _tag: 'UnauthorizedError', message: 'Authentication required' });
  const sse = (event) => `data: ${JSON.stringify(event)}\n\n`;
  const optional = (value) => { try { return decodeURIComponent(value); } catch { return value; } };

  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? '/', 'http://mock');
    const method = request?.method ?? 'GET';
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const text = Buffer.concat(chunks).toString('utf8');
    const body = text ? JSON.parse(text) : undefined;
    state.requests.push({
      method, path: url.pathname, directory: request.headers['x-opencode-directory'],
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
    if (state.delayMs) await new Promise((resolve) => setTimeout(resolve, state.delayMs));
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
        version: state.version, pid: state.reportedPid ?? process.pid, hostname: hostname(), urls: [state.origin],
        paths: { tmp: '/tmp/opencode' }, capabilities: { persistentPty: true },
      });
    }
    if (method === 'GET' && path === '/api/config') {
      return json(response, 200, [
        { type: 'directory', path: '/home/user/.config/opencode' },
        ...(configContent === null ? [] : [{ type: 'document', info: JSON.parse(configContent) }]),
      ]);
    }
    if (method === 'GET' && (path === '/api/agent' || path.startsWith('/api/agent/'))) {
      const directory = request.headers['x-opencode-directory'];
      if (typeof directory !== 'string' || state.missingDirectories.has(directory)) {
        return json(response, 404, {
          _tag: 'LocationNotFoundError', location: { directory }, message: `Location not found: ${directory}`,
        });
      }
      const location = { directory: state.agentLocation ?? directory };
      // The server loads the agents of a directory when the directory is first listed. Until then, an agent looked up
      // by name is not found, however long the server has been running.
      const loaded = state.agentDirectories.has(directory);
      state.agentDirectories.add(directory);
      if (path === '/api/agent') {
        const data = !loaded && state.agentFirstListEmpty ? [] : [...state.agents.values()];
        return json(response, 200, { location, data: shaped(data, state.agentShape) });
      }
      const agentID = optional(path.slice('/api/agent/'.length));
      const agent = loaded ? state.agents.get(agentID) : undefined;
      return agent
        ? json(response, 200, { location, data: shaped([agent], state.agentShape)[0] })
        : json(response, 404, { _tag: 'AgentNotFoundError', agentID, message: `Agent not found: ${agentID}` });
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
      const session = {
        id: id('ses'), projectID: 'prj_mock', cost: 0, tokens: { input: 0, output: 0 },
        time: { created: now, updated: now }, title: String(body?.title ?? ''),
        location: { directory: state.bindTo ?? request.headers['x-opencode-directory'] ?? '' },
      };
      state.sessions.set(session.id, session);
      state.messages.set(session.id, []);
      state.emit({ id: id('evt'), type: 'session.created', data: {}, location: { directory: session.location.directory } });
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
          data: (state.messages.get(sessionID) ?? []).map((message) => ({ id: message.id, time: message.time, text: message.payload.text, type: message.type })),
          cursor: { previous: null, next: null },
        });
      }
      if (action === 'prompt' && method === 'POST') {
        if (typeof body?.text !== 'string') {
          return json(response, 400, { _tag: 'InvalidRequestError', message: 'Missing key\n  at ["text"]', kind: 'Payload' });
        }
        const message = {
          id: id('msg'), sessionID, time: { created: Date.now() }, type: 'user',
          payload: { text: body.text }, delivery: 'steer',
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
  await new Promise((resolve) => server.listen(options.port ?? 0, '127.0.0.1', () => resolve()));
  const { port } = server.address();
  state.origin = `http://127.0.0.1:${port}`;
  state.emit = (event) => { for (const client of clients) client.write(sse(event)); };
  const heartbeat = setInterval(() => { for (const client of clients) client.write(': heartbeat\n\n'); }, 300);
  heartbeat.unref();
  state.close = async () => new Promise((resolve) => {
    clearInterval(heartbeat);
    for (const client of clients) client.end();
    server.closeAllConnections();
    server.close(() => resolve());
  });
  return state;
}

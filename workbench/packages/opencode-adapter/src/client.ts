import { OpenCodeError } from './errors.js';
import { EventStreamParser, type ServerEvent } from './sse.js';

/**
 * The OpenCode this adapter was read from. Every request and every answer below was taken from a real server of
 * this version, not from documentation. Another version is refused until someone has read it the same way.
 */
export const VERIFIED_VERSION = '2.2.7';

export interface OpenCodeServerInfo {
  version: string;
  pid: number;
  hostname: string;
}

/** A session as the server keeps it. `directory` is the project the session is bound to. */
export interface OpenCodeSession {
  id: string;
  title: string;
  directory: string;
  projectID: string;
  created: number;
  updated: number;
}

/** One message of a session. A prompt is answered with the user's own message; the model's answer arrives later. */
export interface OpenCodeMessage {
  id: string;
  sessionID: string;
  type: string;
  text: string;
  created: number;
}

/** One permission rule as the server reports it for an agent, in order. The last rule that matches wins. */
export interface AgentPermission {
  action: string;
  /** `*`, or a pattern such as `*.env` or `/Users/x/.opencode/plan/*`. */
  resource: string;
  effect: 'allow' | 'ask' | 'deny';
}

/** An agent as the server lists it for a project, with the permissions it computed for it there. */
export interface OpenCodeAgent {
  id: string;
  name: string;
  mode: string;
  hidden: boolean;
  /** The server's own hidden agents come without one. */
  description: string;
  permissions: AgentPermission[];
}

export interface PromptInput {
  text: string;
  /** The agent to run, by name. Left out, the server picks its default agent. */
  agent?: string;
  /** The model to run. Left out, the server picks the one configured for the project. */
  model?: { providerID: string; modelID: string };
}

/**
 * What the Workbench needs from an OpenCode server. Implementations talk to a real server over HTTP; tests talk to
 * one that behaves the same.
 */
export interface OpenCodeAdapter {
  info(): Promise<OpenCodeServerInfo>;
  /** Creates a session in the project directory of this adapter, and refuses one the server binds elsewhere. */
  createSession(input: { title: string }): Promise<OpenCodeSession>;
  /** The session, or null when there is none or it belongs to another project. */
  getSession(id: string): Promise<OpenCodeSession | null>;
  /** Queues the text for the session and returns the user's message. The answer comes through the events. */
  sendPrompt(sessionID: string, input: PromptInput): Promise<OpenCodeMessage>;
  /** The messages of the session, oldest first. */
  getMessages(sessionID: string): Promise<OpenCodeMessage[]>;
  /** The events of the project directory, as they come. Ends when `signal` is aborted or the stream closes. */
  subscribeEvents(signal?: AbortSignal): AsyncIterable<ServerEvent>;
  /** Asks the server to stop what it is doing in the session. */
  abort(sessionID: string): Promise<{ interrupted: boolean }>;
  /**
   * The agents the server offers this project. The server loads them when a directory is first listed, so right after
   * a start the list can be empty, and until it is not, an agent looked up by name is reported missing.
   */
  listAgents(): Promise<OpenCodeAgent[]>;
  /** One agent with the permissions the server computed for this project, or null when there is none. */
  getAgent(id: string): Promise<OpenCodeAgent | null>;
}

export interface OpenCodeClientOptions {
  /** Where the server listens, as `http://127.0.0.1:4096`. A server that is not on this machine has to use https. */
  baseUrl: string;
  /** The canonical root of the registered project. Every request names it, and a session of another directory is never given out. */
  directory: string;
  /** The password the server was started with, when it has one. */
  password?: string;
  /** How long one request may take, except the event stream, which only has this long to connect. 10 s by default. */
  timeoutMs?: number;
  /** For tests. */
  fetch?: typeof fetch;
}

const SESSION_ID = /^ses_[A-Za-z0-9]+$/;
const TIMED_OUT = Symbol('OpenCode request timed out');
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]', '::1']);

type Tagged = { _tag?: unknown; message?: unknown; sessionID?: unknown };

function readBaseUrl(input: string): URL {
  let url: URL;
  try { url = new URL(input); } catch { throw new OpenCodeError('protocol', 'The OpenCode server address is not a URL'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash ||
      (url.pathname !== '/' && url.pathname !== '')) {
    throw new OpenCodeError('protocol', 'The OpenCode server address has to be an http(s) origin without a path');
  }
  // The password would be readable by anything between this machine and the server.
  if (url.protocol === 'http:' && !LOOPBACK.has(url.hostname)) {
    throw new OpenCodeError('protocol', 'An OpenCode server on another machine has to be reached over https');
  }
  return url;
}

export class OpenCodeHttpAdapter implements OpenCodeAdapter {
  private readonly origin: string;
  private readonly directory: string;
  private readonly timeoutMs: number;
  private readonly fetcher: typeof fetch;
  private authorization: string | undefined;

  constructor(private readonly options: OpenCodeClientOptions) {
    this.origin = readBaseUrl(options.baseUrl).origin;
    if (!options.directory.startsWith('/')) {
      throw new OpenCodeError('protocol', 'The project directory has to be absolute');
    }
    this.directory = options.directory;
    this.timeoutMs = options.timeoutMs ?? 10_000;
    this.fetcher = options.fetch ?? fetch;
    this.authorization = options.password === undefined
      ? undefined
      : `Basic ${Buffer.from(`opencode:${options.password}`).toString('base64')}`;
  }

  async info(): Promise<OpenCodeServerInfo> {
    const info = await this.request('GET', '/api/info', value => {
      if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
      const row = value as Record<string, unknown>;
      if (typeof row.version !== 'string' || !row.version || typeof row.hostname !== 'string' ||
          !Number.isSafeInteger(row.pid) || (row.pid as number) <= 0) {
        return null;
      }
      return { version: row.version, pid: row.pid as number, hostname: row.hostname };
    });
    if (!info) throw new OpenCodeError('protocol', 'The answer of /api/info is not a server description');
    return info;
  }

  async createSession(input: { title: string }): Promise<OpenCodeSession> {
    if (typeof input.title !== 'string' || input.title.length > 500) {
      throw new OpenCodeError('invalid_request', 'A session title is text of at most 500 characters');
    }
    const session = await this.request('POST', '/api/session', readSession, { title: input.title });
    // The server decides where a session lives. A session it did not bind to this project is not this project's.
    if (session && session.directory !== this.directory) {
      throw new OpenCodeError('protocol', 'The server created the session in another directory');
    }
    return mustBeSession(session);
  }

  async getSession(id: string): Promise<OpenCodeSession | null> {
    assertSessionId(id);
    let session: OpenCodeSession | null;
    try { session = await this.request('GET', `/api/session/${id}`, readSession); }
    catch (error) {
      // Not there any more is an answer, not a failure. Anything else is.
      if (error instanceof OpenCodeError && error.kind === 'not_found') return null;
      throw error;
    }
    // The server lists sessions of every directory together, so the directory is what tells them apart.
    return session && session.directory === this.directory ? session : null;
  }

  async sendPrompt(sessionID: string, input: PromptInput): Promise<OpenCodeMessage> {
    assertSessionId(sessionID);
    await this.owned(sessionID);
    if (!input || typeof input.text !== 'string' || !input.text.trim()) {
      throw new OpenCodeError('invalid_request', 'A prompt is text');
    }
    const body: Record<string, unknown> = { text: input.text };
    if (input.agent !== undefined) {
      if (!/^[\w:-]{1,64}$/.test(input.agent)) throw new OpenCodeError('invalid_request', 'The agent is named by its name');
      body.agent = input.agent;
    }
    if (input.model !== undefined) {
      const { providerID, modelID } = input.model;
      if (typeof providerID !== 'string' || !providerID || typeof modelID !== 'string' || !modelID) {
        throw new OpenCodeError('invalid_request', 'A model is a provider and a model name');
      }
      body.model = { providerID, modelID };
    }
    const message = await this.request('POST', `/api/session/${sessionID}/prompt`, value => readMessage(value, sessionID), body);
    return mustBeMessage(message);
  }

  async getMessages(sessionID: string): Promise<OpenCodeMessage[]> {
    assertSessionId(sessionID);
    await this.owned(sessionID);
    const messages = await this.request('GET', `/api/session/${sessionID}/message`, value => {
      if (!Array.isArray(value)) return null;
      const list: OpenCodeMessage[] = [];
      for (const item of value) {
        const message = readMessage(item, sessionID);
        if (!message) return null;
        list.push(message);
      }
      return list.sort((left, right) => left.created - right.created);
    });
    return messages ?? [];
  }

  async abort(sessionID: string): Promise<{ interrupted: boolean }> {
    assertSessionId(sessionID);
    await this.owned(sessionID);
    const answer = await this.request('POST', `/api/session/${sessionID}/interrupt`, value =>
      value && typeof value === 'object' && typeof (value as { interrupted?: unknown }).interrupted === 'boolean'
        ? { interrupted: (value as { interrupted: boolean }).interrupted } : null);
    if (!answer) throw new OpenCodeError('protocol', 'The answer of the interrupt request is not an answer');
    return answer;
  }

  async listAgents(): Promise<OpenCodeAgent[]> {
    const { directory, data } = await this.agentAnswer('/api/agent');
    if (directory !== this.directory || !Array.isArray(data)) {
      throw new OpenCodeError('protocol', 'The answer of /api/agent is not a list of this project\'s agents');
    }
    return data.map(readAgent).map(agent => mustBeAgent(agent, 'The answer of /api/agent is not a list of agents'));
  }

  async getAgent(id: string): Promise<OpenCodeAgent | null> {
    if (typeof id !== 'string' || !/^[\w:-]{1,64}$/.test(id)) {
      throw new OpenCodeError('invalid_request', 'An agent is named by its id');
    }
    let answer: { directory: string | null; data: unknown };
    try { answer = await this.agentAnswer(`/api/agent/${id}`); }
    catch (error) {
      // Not there is an answer, not a failure. So is not loaded yet: that is why the list is asked first.
      if (error instanceof OpenCodeError && error.kind === 'not_found') return null;
      throw error;
    }
    if (answer.directory !== this.directory) {
      throw new OpenCodeError('protocol', 'The server answered about another directory');
    }
    const agent = readAgent(answer.data);
    if (!agent || agent.id !== id) throw new OpenCodeError('protocol', 'The answer is not that agent');
    return agent;
  }

  /**
   * The agents are answered as `{ location, data }`. The directory is read here, because it is what tells this
   * project's answer from another's; the generic request unwraps `data` and drops it.
   */
  private async agentAnswer(path: string): Promise<{ directory: string | null; data: unknown }> {
    let response: Response;
    try {
      response = await this.fetcher(`${this.origin}${path}`, {
        method: 'GET', headers: this.headers(), signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) { throw this.failure(error); }
    if (!response.ok) throw await this.refusal(response);
    const value = await this.json(response);
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new OpenCodeError('protocol', `The answer of ${path} is not an agent answer`);
    }
    const row = value as Record<string, unknown>;
    const location = row.location as { directory?: unknown } | undefined;
    return { directory: typeof location?.directory === 'string' ? location.directory : null, data: row.data };
  }

  async *subscribeEvents(signal?: AbortSignal): AsyncIterable<ServerEvent> {
    const controller = new AbortController();
    const forward = () => controller.abort(signal?.reason);
    signal?.addEventListener('abort', forward, { once: true });
    if (signal?.aborted) forward();
    // Only the connection has a time limit; an open stream stays open until it is aborted.
    const timer = setTimeout(() => controller.abort(TIMED_OUT), this.timeoutMs);
    let response: Response;
    try {
      response = await this.fetcher(`${this.origin}/api/event`, {
        method: 'GET', headers: this.headers('text/event-stream'), signal: controller.signal,
      });
    } catch (error) {
      clearTimeout(timer);
      signal?.removeEventListener('abort', forward);
      if (signal?.aborted) return;
      throw this.translated(error, controller, signal);
    } finally { clearTimeout(timer); }
    if (!response.ok) {
      signal?.removeEventListener('abort', forward);
      throw await this.refusal(response);
    }
    // The server answers a path it does not know with its web page. That is not a stream, and taking it for one
    // would look like a server that is quiet.
    if (!response.body || !(response.headers.get('content-type') ?? '').includes('text/event-stream')) {
      signal?.removeEventListener('abort', forward);
      throw new OpenCodeError('protocol', 'The server did not answer with an event stream');
    }
    const parser = new EventStreamParser();
    const reader = response.body.getReader();
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        for (const event of parser.push(value)) yield event;
      }
      for (const event of parser.close()) yield event;
    } catch (error) {
      // Stopped by the caller: the stream ends here. Anything else is a failure.
      if (signal?.aborted) return;
      throw this.translated(error, controller, signal);
    } finally {
      void reader.cancel().catch(() => undefined);
      signal?.removeEventListener('abort', forward);
    }
  }

  /** A session of another project is not found here, even when the server would answer for it. */
  private async owned(sessionID: string): Promise<void> {
    if ((await this.getSession(sessionID)) === null) {
      throw new OpenCodeError('not_found', 'There is no such session in this project');
    }
  }

  private headers(accept = 'application/json'): Record<string, string> {
    const headers: Record<string, string> = { accept, 'x-opencode-directory': this.directory };
    if (this.authorization !== undefined) headers.authorization = this.authorization;
    return headers;
  }

  private async request<T>(method: string, path: string, read: (value: unknown) => T, body?: unknown): Promise<T> {
    let response: Response;
    try {
      response = await this.fetcher(`${this.origin}${path}`, {
        method,
        headers: { ...this.headers(), ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) { throw this.failure(error); }
    if (!response.ok) throw await this.refusal(response);
    if (response.status === 204) return undefined as T;
    return read(dataOf(await this.json(response)));
  }

  /** Why a request could not be made: it ran out of time, or nothing answered. */
  private failure(error: unknown): OpenCodeError {
    // `AbortSignal.timeout` aborts with a TimeoutError; anything else is a request that could not be made.
    if (error instanceof Error && error.name === 'TimeoutError') {
      return new OpenCodeError('timeout', `The OpenCode server did not answer in ${this.timeoutMs} ms`);
    }
    return new OpenCodeError('unavailable', 'The OpenCode server cannot be reached');
  }

  /** The server answers an error as JSON with a `_tag`; the page it serves for unknown paths is not an answer. */
  private async refusal(response: Response): Promise<OpenCodeError> {
    const status = response.status;
    if (status === 401) return new OpenCodeError('unauthorized', 'The OpenCode server asked for a password', status);
    let payload: Tagged | null = null;
    try { payload = await response.json() as Tagged; } catch { payload = null; }
    // An answer without an error document, as a proxy in front of the server gives: the status is all there is.
    if (!payload || typeof payload !== 'object') {
      return status >= 500
        ? new OpenCodeError('refused', `The OpenCode server answered ${status}`, status)
        : new OpenCodeError('protocol', `The OpenCode server answered ${status} without an error document`, status);
    }
    const tag = payload?._tag;
    const message = typeof payload?.message === 'string' ? payload.message : '';
    if (tag === 'UnauthorizedError') return new OpenCodeError('unauthorized', message || 'Unauthorized', status);
    if (tag === 'SessionNotFoundError') return new OpenCodeError('not_found', message || 'No such session', status);
    if (tag === 'AgentNotFoundError') return new OpenCodeError('not_found', message || 'No such agent', status);
    // The directory a request named is not there any more.
    if (tag === 'LocationNotFoundError') {
      return new OpenCodeError('directory_unavailable', message || 'No such directory', status);
    }
    if (tag === 'InvalidRequestError') return new OpenCodeError('invalid_request', message || 'The request was refused', status);
    if (tag && message) return new OpenCodeError('refused', `${tag}: ${message}`, status);
    return new OpenCodeError('protocol', `The OpenCode server answered ${status} without an error document`, status);
  }

  private async json(response: Response): Promise<unknown> {
    const text = await response.text();
    try { return JSON.parse(text); } catch {
      // Not JSON: on this server that is the web page it returns for a path it does not know.
      throw new OpenCodeError('protocol', `The OpenCode server did not answer JSON to ${new URL(response.url).pathname}`, response.status);
    }
  }

  private translated(error: unknown, controller: AbortController, signal?: AbortSignal): unknown {
    if (controller.signal.aborted && controller.signal.reason === TIMED_OUT) {
      return new OpenCodeError('timeout', `The OpenCode server did not answer in ${this.timeoutMs} ms`);
    }
    if (signal?.aborted) return signal.reason;
    if (error instanceof OpenCodeError) return error;
    // A request that could not be made at all: nothing listens there, or the connection broke.
    return new OpenCodeError('unavailable', 'The OpenCode server cannot be reached');
  }
}

function assertSessionId(id: string): void {
  if (typeof id !== 'string' || !SESSION_ID.test(id)) {
    throw new OpenCodeError('invalid_request', 'A session is named by its id, as `ses_…`');
  }
}

function readSession(value: unknown): OpenCodeSession | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  const location = row.location as { directory?: unknown } | undefined;
  const time = row.time as { created?: unknown; updated?: unknown } | undefined;
  const created = time?.created;
  const updated = time?.updated;
  if (typeof row.id !== 'string' || !SESSION_ID.test(row.id) || typeof row.title !== 'string' ||
      typeof location?.directory !== 'string' || typeof row.projectID !== 'string' ||
      !Number.isSafeInteger(created) || !Number.isSafeInteger(updated)) {
    return null;
  }
  return {
    id: row.id, title: row.title, directory: location.directory, projectID: row.projectID,
    created: created as number, updated: updated as number,
  };
}

/** A message as the prompt request answers it (`payload.text`) and as the message list gives it (`text`). */
function readMessage(value: unknown, sessionID: string): OpenCodeMessage | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  const payload = row.payload as { text?: unknown } | undefined;
  const text = typeof row.text === 'string' ? row.text : payload?.text;
  const created = (row.time as { created?: unknown } | undefined)?.created;
  const owner = typeof row.sessionID === 'string' ? row.sessionID : sessionID;
  if (typeof row.id !== 'string' || !row.id || typeof row.type !== 'string' || typeof text !== 'string' ||
      !Number.isSafeInteger(created)) {
    return null;
  }
  return { id: row.id, sessionID: owner, type: row.type, text, created: created as number };
}

function mustBeSession(session: OpenCodeSession | null): OpenCodeSession {
  if (!session) throw new OpenCodeError('protocol', 'The answer is not a session');
  return session;
}

function mustBeMessage(message: OpenCodeMessage | null): OpenCodeMessage {
  if (!message) throw new OpenCodeError('protocol', 'The answer is not a message');
  return message;
}

function mustBeAgent(agent: OpenCodeAgent | null, message: string): OpenCodeAgent {
  if (!agent) throw new OpenCodeError('protocol', message);
  return agent;
}

function readAgent(value: unknown): OpenCodeAgent | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  // The server's own hidden agents are listed without a description.
  const description = row.description ?? '';
  if (typeof row.id !== 'string' || !row.id || typeof row.name !== 'string' || typeof row.mode !== 'string' ||
      typeof row.hidden !== 'boolean' || typeof description !== 'string' || !Array.isArray(row.permissions)) {
    return null;
  }
  const permissions: AgentPermission[] = [];
  for (const item of row.permissions) {
    const rule = item as Partial<AgentPermission> | null;
    if (!rule || typeof rule !== 'object' || Array.isArray(rule) || typeof rule.action !== 'string' ||
        typeof rule.resource !== 'string' || !['allow', 'ask', 'deny'].includes(rule.effect as string)) {
      return null;
    }
    permissions.push({ action: rule.action, resource: rule.resource, effect: rule.effect as AgentPermission['effect'] });
  }
  return {
    id: row.id, name: row.name, mode: row.mode, hidden: row.hidden, description, permissions,
  };
}

/** The answer envelope of the server: most routes wrap what they return in `data`; a few answer bare. */
function dataOf(value: unknown): unknown {
  if (value && typeof value === 'object' && !Array.isArray(value) && 'data' in value) {
    return (value as { data: unknown }).data;
  }
  return value;
}

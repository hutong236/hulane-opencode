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
  /**
   * The agent the session runs, once one was switched to. Null until then: the server's default agent, `build`, is
   * used, and that one may edit files and run commands.
   */
  agent: string | null;
}

/** A part of an assistant message. A tool part is one call of a tool, with what went in and what came out. */
export type OpenCodeMessagePart =
  | { type: 'text'; text: string }
  | { type: 'reasoning'; text: string }
  | { type: 'tool'; id: string; name: string; status: string; input: string; output: string; error: string | null };

/**
 * One entry of a session's message list, as the real server gives it. A prompt is answered with the user's own
 * message; the model's answer arrives later, as an assistant message.
 */
export interface OpenCodeMessage {
  id: string;
  sessionID: string;
  /** `user`, `assistant`, `idle` (a run ended; see `outcome`) or `agent-switched` (see `agent`). */
  type: string;
  created: number;
  /** The user's text. Of an assistant message, its text parts joined. Empty for the others. */
  text: string;
  /** The parts of an assistant message, in order. Empty for the others. */
  parts: OpenCodeMessagePart[];
  /** The agent of an assistant or an agent-switched message. Null for the others. */
  agent: string | null;
  /** The model of an assistant message, as `provider/model`. Null for the others. */
  model: string | null;
  /** How a run ended, of an idle message. Null for the others. */
  outcome: string | null;
  /** An error the server stored with the message, if there is one. */
  error: string | null;
  /** The Git state differed between the start and the end of the step, as the server's snapshots say. */
  changed: boolean;
}

/** A request of the agent that waits for an answer, as reading a `.env` file does. */
export interface OpenCodePermission {
  id: string;
  sessionID: string;
  action: string;
  resources: string[];
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

/**
 * A text for the session. The agent that runs it is the session's, switched with `setSessionAgent`: the `agent` and
 * `model` fields this route also accepts were read to do nothing on the real server.
 */
export interface PromptInput {
  text: string;
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
  /** The sessions of this project, in the order the server lists them, which is the newest first. */
  listSessions(): Promise<OpenCodeSession[]>;
  /**
   * Switches the agent the session runs, and gives the session out only when it says it runs that agent now. The
   * route takes any name: one that is not there is found out only when a task is run, which then fails.
   */
  setSessionAgent(id: string, agent: string): Promise<OpenCodeSession>;
  /** Queues the text for the session and returns the user's message. The answer comes through the events. */
  sendPrompt(sessionID: string, input: PromptInput): Promise<OpenCodeMessage>;
  /** The messages of the session, oldest first. The server's first page only, which holds the newest. */
  getMessages(sessionID: string): Promise<OpenCodeMessage[]>;
  /** What the session's agent is waiting to be allowed to do. */
  pendingPermissions(sessionID: string): Promise<OpenCodePermission[]>;
  /** Answers one request of the session. `allow` gives the agent what it asked for; `reject` refuses it. */
  replyPermission(sessionID: string, requestID: string, decision: 'allow' | 'reject'): Promise<void>;
  /** The server's events about this session and nothing else, as they come. */
  sessionEvents(sessionID: string, signal?: AbortSignal): AsyncIterable<ServerEvent>;
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
    const message = await this.request('POST', `/api/session/${sessionID}/prompt`, value => readUserMessage(value, sessionID), { text: input.text });
    return mustBeMessage(message);
  }

  /** The sessions of this project. The server lists the sessions of every directory together. */
  async listSessions(): Promise<OpenCodeSession[]> {
    const sessions = await this.request('GET', '/api/session', value => {
      if (!Array.isArray(value)) return null;
      const list: OpenCodeSession[] = [];
      for (const item of value) {
        // An entry that is not a session is not passed over: it may be one of this project's.
        const session = mustBeSession(readSession(item));
        if (session.directory === this.directory) list.push(session);
      }
      return list;
    });
    return sessions ?? [];
  }

  async setSessionAgent(sessionID: string, agent: string): Promise<OpenCodeSession> {
    assertSessionId(sessionID);
    await this.owned(sessionID);
    if (typeof agent !== 'string' || !/^[\w:-]{1,64}$/.test(agent)) {
      throw new OpenCodeError('invalid_request', 'An agent is named by its name');
    }
    await this.request('POST', `/api/session/${sessionID}/agent`, () => undefined, { agent });
    const session = await this.getSession(sessionID);
    if (!session || session.agent !== agent) {
      throw new OpenCodeError('refused', `The session was not switched to the agent "${agent}"`);
    }
    return session;
  }

  async getMessages(sessionID: string): Promise<OpenCodeMessage[]> {
    assertSessionId(sessionID);
    await this.owned(sessionID);
    const messages = await this.request('GET', `/api/session/${sessionID}/message`, value => {
      if (!Array.isArray(value)) return null;
      const list: OpenCodeMessage[] = [];
      for (const item of value) {
        // An entry that is not a message is not passed over: it may hold part of the conversation.
        const message = readListedMessage(item, sessionID);
        if (!message) return null;
        list.push(message);
      }
      // The server lists the newest first. A conversation is read from its beginning.
      return list.reverse();
    });
    // A list with an entry that is not a message is not an empty conversation.
    if (!messages) throw new OpenCodeError('protocol', 'The answer is not a message list');
    return messages;
  }

  async pendingPermissions(sessionID: string): Promise<OpenCodePermission[]> {
    assertSessionId(sessionID);
    await this.owned(sessionID);
    const pending = await this.request('GET', `/api/session/${sessionID}/permission`, value => {
      if (!Array.isArray(value)) return null;
      const list: OpenCodePermission[] = [];
      for (const item of value) {
        const permission = readPermission(item);
        if (!permission || permission.sessionID !== sessionID) return null;
        list.push(permission);
      }
      return list;
    });
    if (!pending) throw new OpenCodeError('protocol', 'The answer is not a list of permission requests');
    return pending;
  }

  async replyPermission(sessionID: string, requestID: string, decision: 'allow' | 'reject'): Promise<void> {
    assertSessionId(sessionID);
    // What is not a request or a decision is refused before anything is asked of the server.
    if (typeof requestID !== 'string' || !/^[\w-]{1,128}$/.test(requestID)) {
      throw new OpenCodeError('invalid_request', 'A permission request is named by its id');
    }
    if (decision !== 'allow' && decision !== 'reject') {
      throw new OpenCodeError('invalid_request', 'A permission request is allowed or rejected');
    }
    await this.owned(sessionID);
    await this.request('POST', `/api/session/${sessionID}/permission/${requestID}/reply`, () => undefined, { decision });
  }

  async *sessionEvents(sessionID: string, signal?: AbortSignal): AsyncIterable<ServerEvent> {
    assertSessionId(sessionID);
    for await (const event of this.subscribeEvents(signal)) {
      // Every event about a session names it. The others are about the server, or about another session.
      if (event.data && typeof event.data === 'object' && (event.data as { sessionID?: unknown }).sessionID === sessionID) {
        yield event;
      }
    }
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
    if (tag === 'PermissionNotFoundError') return new OpenCodeError('not_found', message || 'No such permission request', status);
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
    agent: typeof row.agent === 'string' ? row.agent : null,
  };
}

/** The user's own message, as the prompt route answers it: `{ id, sessionID, type: "user", payload: { text }, time } }`. */
function readUserMessage(value: unknown, sessionID: string): OpenCodeMessage | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  const payload = row.payload as { text?: unknown } | undefined;
  const created = (row.time as { created?: unknown } | undefined)?.created;
  if (typeof row.id !== 'string' || !row.id || row.type !== 'user' || typeof payload?.text !== 'string' ||
      !Number.isSafeInteger(created)) {
    return null;
  }
  const rest = { sessionID, parts: [], agent: null, model: null, outcome: null, error: null, changed: false };
  return { ...rest, id: row.id, type: 'user', text: payload.text, created: created as number };
}

/**
 * One entry of the message list, in the shapes read from the real server. A `user` entry has its `text`. An
 * `assistant` entry has `agent`, `model`, `content` parts, a `snapshot` of the Git state and sometimes an `error`.
 * An `idle` entry says how a run ended, and an `agent-switched` entry which agent the session runs from then on.
 */
function readListedMessage(value: unknown, sessionID: string): OpenCodeMessage | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  const created = (row.time as { created?: unknown } | undefined)?.created;
  if (typeof row.id !== 'string' || !row.id || typeof row.type !== 'string' || !Number.isSafeInteger(created)) return null;
  const message: OpenCodeMessage = {
    id: row.id, sessionID, type: row.type, created: created as number, text: '', parts: [], agent: null, model: null,
    outcome: null, error: null, changed: false,
  };
  const error = row.error;
  message.error = typeof error === 'string' ? error
    : error && typeof error === 'object' && typeof (error as { message?: unknown }).message === 'string'
      ? (error as { message: string }).message : null;
  if (row.type === 'user') {
    if (typeof row.text !== 'string') return null;
    message.text = row.text;
    return message;
  }
  if (row.type === 'assistant') {
    if (!Array.isArray(row.content)) return null;
    for (const item of row.content) {
      const part = readPart(item);
      if (part) message.parts.push(part);
    }
    message.text = message.parts.filter(part => part.type === 'text').map(part => part.text).join('\n');
    const model = row.model as { providerID?: unknown; id?: unknown } | undefined;
    message.agent = typeof row.agent === 'string' ? row.agent : null;
    message.model = typeof model?.providerID === 'string' && typeof model.id === 'string'
      ? `${model.providerID}/${model.id}` : null;
    const snapshot = row.snapshot as { start?: unknown; end?: unknown } | undefined;
    message.changed = typeof snapshot?.start === 'string' && typeof snapshot.end === 'string' && snapshot.start !== snapshot.end;
    return message;
  }
  if (row.type === 'idle') message.outcome = typeof row.outcome === 'string' ? row.outcome : null;
  if (row.type === 'agent-switched') message.agent = typeof row.agent === 'string' ? row.agent : null;
  // Any other type is passed on as what it is, with nothing read out of it.
  return message;
}

/** A content part of an assistant message. A part of a type this adapter does not know is left out. */
function readPart(value: unknown): OpenCodeMessagePart | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const part = value as Record<string, unknown>;
  if (part.type === 'text' || part.type === 'reasoning') {
    return typeof part.text === 'string' ? { type: part.type, text: part.text } : null;
  }
  if (part.type !== 'tool' || typeof part.id !== 'string' || typeof part.name !== 'string') return null;
  const state = (part.state ?? {}) as Record<string, unknown>;
  const content = Array.isArray(state.content) ? state.content : [];
  const failure = state.error;
  return {
    type: 'tool', id: part.id, name: part.name,
    status: typeof state.status === 'string' ? state.status : 'pending',
    input: JSON.stringify(state.input ?? null),
    output: content.map(item => (item as { text?: unknown })?.text).filter(text => typeof text === 'string').join('\n'),
    error: typeof failure === 'string' ? failure : null,
  };
}

/** A request that waits for an answer, as `GET /api/session/:id/permission` lists it. */
function readPermission(value: unknown): OpenCodePermission | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  if (typeof row.id !== 'string' || !row.id || typeof row.sessionID !== 'string' || typeof row.action !== 'string' ||
      !Array.isArray(row.resources)) {
    return null;
  }
  return {
    id: row.id, sessionID: row.sessionID, action: row.action,
    resources: row.resources.filter(resource => typeof resource === 'string'),
  };
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

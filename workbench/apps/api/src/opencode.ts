import type { FastifyInstance, FastifyReply } from 'fastify';
import type {
  NewOpenCodeServer, OpenCodeServerRecord, OpenCodeServerState, OpenCodeSessionRecord, WorkbenchDatabase,
} from '@hulane/workbench-database';
import {
  OpenCodeError, READONLY_AGENT_ID, RunningOpenCodeServer, ServerStartError, VERIFIED_VERSION, connectOpenCode,
  endLeftoverServer, startManagedOpenCode,
  type ExitFacts, type ManagedServerOptions, type OpenCodeAdapter, type OpenCodeMessage, type OpenCodePermission,
  type OpenCodeSession, type ServerState,
} from '@hulane/workbench-opencode-adapter';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Ways a server the Workbench holds can fail, as the adapter names them. */
const FAILURES: ReadonlySet<string> = new Set([
  'exited', 'replaced', 'incompatible_version', 'unavailable', 'timeout', 'unauthorized', 'refused', 'protocol',
  'directory_unavailable',
]);

/** A server this process holds: one it started, or one it was attached to with its password. */
type Held = { kind: 'managed'; server: RunningOpenCodeServer } | { kind: 'attached'; adapter: OpenCodeAdapter };
type Managed = Extract<Held, { kind: 'managed' }>;
type Refusal =
  | 'already_running'    // this process holds a server for the project
  | 'running_elsewhere'  // another Workbench process that is still there does
  | 'leftover'           // one an earlier Workbench process left behind may still be there
  | 'not_readonly';      // the server, or the session, does not run the agent that is proven read-only
const REFUSALS: Record<Refusal, string> = {
  already_running: 'An OpenCode server is already running for this project',
  running_elsewhere: 'An OpenCode server of this project is held by another Workbench process',
  leftover: 'A server left behind by an earlier Workbench run may still be there; stop it first',
  not_readonly: 'This session does not run the agent that is proven read-only, so no task is given to it',
};

export class ProjectAbsent extends Error {}
export class Refused extends Error {
  constructor(readonly reason: Refusal, readonly pid: number | null = null) { super(reason); }
}
export class Invalid extends Error {}
/** This process holds no server for the project. The record says what became of the last one. */
export class NoServer extends Error {
  constructor(readonly record: OpenCodeServerRecord | null) { super('no server'); }
}
/** The server has no such session in this project. */
export class SessionAbsent extends Error {}

export interface OpenCodeOptions {
  /** The program that starts a managed server. From the Workbench's own environment, never from a request. */
  command?: readonly string[];
  /** How long a start may take. 30 s. */
  startTimeoutMs?: number;
  /** Reads a process's start time, command line and parent. For tests. */
  describe?: ManagedServerOptions['describe'];
  /** Asks whether a text may be given to a session. Nothing is asked when it is left out. */
  mayAsk?: (projectId: string, sessionId: string) => Promise<boolean>;
}

/** States that say how a server is no longer running. A later look does not write over them. */
const ENDED: ReadonlySet<string> = new Set(['stopped', 'detached', 'exited', 'orphaned']);

const alive = (pid: number): boolean => {
  try { process.kill(pid, 0); return true; } catch { return false; }
};
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * The OpenCode servers of the registered projects, for one Workbench process.
 *
 * The database keeps one record per project: which server it had, its process, and how it is. What a record never
 * keeps is a password. That stays in this object. So a server an earlier Workbench process was attached to can be
 * attached to again, but not used; and one that process started is looked for at the next start.
 */
export class OpenCodeServers {
  private readonly held = new Map<string, Held>();
  private looked: Promise<void> | undefined;

  constructor(
    private readonly database: () => WorkbenchDatabase,
    private readonly options: OpenCodeOptions = {},
    /** Asks whether a session may run the read-only agent. Nothing is asked when it is left out. */
    private readonly mayAsk: (projectId: string, sessionId: string) => Promise<boolean> = async () => true,
  ) {}

  private get command(): readonly string[] {
    return this.options.command ?? [process.env.WORKBENCH_OPENCODE_BIN ?? 'opencode'];
  }

  /**
   * Starts a server for the project, in its registered root. One that fails is kept as what it was, so that a page
   * can say why. `log` gets what the server printed, which is not sent in an answer.
   */
  async start(projectId: string, log: (message: string, output: string) => void = () => undefined): Promise<OpenCodeServerRecord> {
    await this.lookedOnce();
    const project = this.project(projectId);
    this.unoccupied(projectId);
    let server: RunningOpenCodeServer | undefined;
    try {
      server = await startManagedOpenCode({
        directory: project.repo_root, command: this.command, startTimeoutMs: this.options.startTimeoutMs,
        describe: this.options.describe,
      });
      // Held from now on, so that its ending is noticed even if the record cannot be written.
      this.held.set(projectId, { kind: 'managed', server });
      server.onExit((exit) => { this.ended(projectId, exit); });
      return this.store({
        projectId, kind: 'managed', directory: project.repo_root, baseUrl: server.baseUrl, pid: server.pid,
        pidStarted: server.identity?.started ?? null, ownerPid: process.pid, version: server.version,
        state: 'running', readonlyAgent: true, startedAt: server.startedAt,
      });
    } catch (error) {
      // Whatever was started and cannot be used is ended, not left behind.
      this.held.delete(projectId);
      if (server) {
        await server.stop().catch(() => undefined);
        server.killNow();
      }
      if (error instanceof ServerStartError) log(`The OpenCode server of a project could not be started: ${error.message}`, error.output);
      if (error instanceof OpenCodeError && error.kind !== 'invalid_request' && error.kind !== 'not_found') {
        this.store({
          projectId, kind: 'managed', directory: project.repo_root, state: error.kind as OpenCodeServerState,
          readonlyAgent: false,
        });
      }
      throw error;
    }
  }

  /** Attaches to a server someone else started. Nothing is started there and nothing is written to it. */
  async attach(projectId: string, input: { baseUrl?: unknown; password?: unknown }): Promise<OpenCodeServerRecord> {
    await this.lookedOnce();
    const { baseUrl, password } = input;
    // An address is an origin: no path, no query and no credentials in it. The password is its own field.
    const address = typeof baseUrl === 'string' && baseUrl.length <= 2_000 ? originOf(baseUrl) : undefined;
    if (!address || (password !== undefined && (typeof password !== 'string' || password.length > 1_000))) {
      throw new Invalid();
    }
    const project = this.project(projectId);
    this.unoccupied(projectId);
    let connected;
    try {
      connected = await connectOpenCode({ baseUrl: address, directory: project.repo_root, password });
    } catch (error) {
      // Kept as what it was, as a start that fails is, and without the password that was given.
      if (error instanceof OpenCodeError && error.kind !== 'invalid_request') {
        this.store({
          projectId, kind: 'attached', directory: project.repo_root, baseUrl: address,
          state: error.kind as OpenCodeServerState, readonlyAgent: false,
        });
      }
      throw error;
    }
    const record = this.store({
      projectId, kind: 'attached', directory: project.repo_root, baseUrl: address,
      pid: connected.info.pid, version: connected.info.version, state: 'running', readonlyAgent: connected.readOnly,
    });
    this.held.set(projectId, { kind: 'attached', adapter: connected.adapter });
    return record;
  }

  /** How the server of the project is now. `held` says whether this process can stop it and give it a task. */
  async status(projectId: string): Promise<{ server: OpenCodeServerRecord | null; held: boolean }> {
    await this.lookedOnce();
    let record = this.database().opencodeServers.forProject(projectId);
    const entry = this.held.get(projectId);
    if (entry && record) {
      const state = await this.probe(entry, record);
      // While the server was asked, it may have ended and that may have been noted. A look does not write over
      // how a server ended; the record is read again for that.
      record = this.database().opencodeServers.forProject(projectId);
      if (record && state !== record.state && (state === 'running' || !ENDED.has(record.state))) {
        record = this.note(record, state);
      }
      // A process that ended, or an address another process answers on now, is not held any longer.
      if (state === 'exited' || state === 'replaced') this.held.delete(projectId);
    }
    return { server: record, held: this.held.has(projectId) };
  }

  /**
   * Stops the server of the project. One this process started is ended; one it was attached to is let go of and
   * keeps running; one an earlier process started and left behind is ended only when it can be proved to be that one.
   */
  async stop(projectId: string): Promise<'stopped' | 'detached' | 'nothing' | Refusal | 'unverifiable'> {
    await this.lookedOnce();
    const record = this.database().opencodeServers.forProject(projectId);
    if (!record) return 'nothing';
    const entry = this.held.get(projectId);
    const now = new Date().toISOString();
    // Not held any more before it is ended, so that its ending is not taken for its own.
    this.held.delete(projectId);
    if (entry?.kind === 'managed') {
      await entry.server.stop();
      this.note(record, 'stopped', now);
      return 'stopped';
    }
    if (entry?.kind === 'attached' || (record.kind === 'attached' && record.state === 'running')) {
      this.note(record, 'detached', now);
      return 'detached';
    }
    // A managed server that is not held and is recorded as running or as left behind: one a Workbench that is gone
    // started, or one a Workbench that is still there is running.
    if (record.kind === 'managed' && (record.state === 'running' || record.state === 'orphaned')) {
      const elsewhere = record.owner_pid !== null && record.owner_pid !== process.pid && alive(record.owner_pid);
      if (elsewhere) return 'running_elsewhere';
      if (record.pid !== null && (await endLeftoverServer(record.pid, record.pid_started))) {
        this.note(record, 'stopped', now);
        return 'stopped';
      }
      // Still there and not proved to be the recorded server: left alone.
      if (record.pid !== null && alive(record.pid)) {
        this.note(record, 'orphaned');
        return 'unverifiable';
      }
      this.note(record, 'stopped', now);
      return 'stopped';
    }
    return 'nothing';
  }

  /** Ends the server of a project that is being unregistered, whatever can be ended. Nothing is reported. */
  async forget(projectId: string): Promise<void> {
    const entry = this.held.get(projectId);
    this.held.delete(projectId);
    if (entry?.kind !== 'managed') return;
    await entry.server.stop().catch(() => undefined);
    entry.server.killNow();
  }

  /** With the Workbench ending: every server it started is ended and noted, every attached one let go of. */
  async close(): Promise<void> {
    if (this.held.size === 0) return;
    const managed: Array<[string, Managed]> = [];
    const attached: string[] = [];
    for (const [projectId, entry] of this.held) {
      if (entry.kind === 'managed') managed.push([projectId, entry]);
      else attached.push(projectId);
    }
    this.held.clear();
    const now = new Date().toISOString();
    // All are asked at the same time, and the Workbench does not wait longer than they get.
    await Promise.race([Promise.all(managed.map(([, entry]) => entry.server.stop().catch(() => undefined))), sleep(6_000)]);
    for (const [projectId, entry] of managed) entry.server.killNow();
    // The records are notes. A database that is closed already, as when the Workbench is killed, is not a failure.
    try {
      const records = this.database().opencodeServers;
      for (const [projectId] of managed) {
        const record = records.forProject(projectId);
        if (record?.state === 'running') records.setState(record.id, 'stopped', now);
      }
      for (const projectId of attached) {
        const record = records.forProject(projectId);
        if (record?.state === 'running') records.setState(record.id, 'detached', now);
      }
    } catch { /* noted nowhere: the Workbench is ending */ }
  }

  /**
   * Looks once, at the first request or at the start of the server, for what an earlier Workbench process left in the
   * records. A managed server of a process that is gone is ended when the system says it is that process. One that
   * another Workbench process is still running is left alone. A server that was attached to is asked for again:
   * without the password of that process it can only be attached to again.
   */
  reconcile(): Promise<void> {
    return this.lookedOnce();
  }

  private lookedOnce(): Promise<void> {
    this.looked ??= this.look().catch(() => undefined);
    return this.looked;
  }

  private async look(): Promise<void> {
    const records = this.database().opencodeServers;
    const now = new Date().toISOString();
    for (const record of records.inStates(['running'])) {
      if (this.held.has(record.project_id)) continue;
      if (record.kind === 'managed') {
        if (record.owner_pid !== null && record.owner_pid !== process.pid && alive(record.owner_pid)) continue;
        const ended = record.pid !== null && (await endLeftoverServer(record.pid, record.pid_started, 2_000));
        // One that is still there and could not be proved to be the recorded server is left alone, and said so.
        const present = record.pid !== null && alive(record.pid);
        records.setState(record.id, ended ? 'stopped' : present ? 'orphaned' : 'exited', now);
        continue;
      }
      if (record.base_url === null) {
        records.setState(record.id, 'unavailable', now);
        continue;
      }
      try {
        // It answers without a password: it is held as it is.
        const connected = await connectOpenCode({ baseUrl: record.base_url, directory: record.directory });
        this.held.set(record.project_id, { kind: 'attached', adapter: connected.adapter });
        records.setState(record.id, 'running');
      } catch (error) {
        const kind = error instanceof OpenCodeError ? error.kind : 'protocol';
        records.setState(record.id, (FAILURES.has(kind) ? kind : 'unauthorized') as OpenCodeServerState, now);
      }
    }
  }

  /**
   * The server this process holds for the project, and whether its read-only agent is proven. A session is given
   * no task through a server that is not held: one this process has no password for cannot be talked to.
   */
  private async holding(projectId: string): Promise<{ adapter: OpenCodeAdapter; readonly: boolean }> {
    await this.lookedOnce();
    this.project(projectId);
    const entry = this.held.get(projectId);
    if (!entry) throw new NoServer(this.database().opencodeServers.forProject(projectId));
    const adapter = entry.kind === 'managed' ? entry.server.adapter : entry.adapter;
    return { adapter, readonly: this.database().opencodeServers.forProject(projectId)?.readonly_agent === true };
  }

  /** A new session for the project, switched to the read-only agent before anything can be asked of it. */
  async createSession(projectId: string, input: { title?: unknown }): Promise<OpenCodeSession> {
    if (input.title !== undefined && (typeof input.title !== 'string' || input.title.length > 500)) throw new Invalid();
    const { adapter, readonly } = await this.holding(projectId);
    if (!readonly) throw new Refused('not_readonly');
    const session = await adapter.createSession({ title: (input.title as string | undefined) ?? '' });
    // The switch takes any name, so the session is given out only when the server says it runs that agent.
    const switched = await adapter.setSessionAgent(session.id, READONLY_AGENT_ID);
    this.database().opencodeSessions.see(projectId, [switched]);
    return switched;
  }

  /** The project's sessions as the server lists them, and what the Workbench knows of them for when it is not running. */
  async sessions(projectId: string): Promise<{ sessions: OpenCodeSession[]; recorded: OpenCodeSessionRecord[] }> {
    const { adapter } = await this.holding(projectId);
    const sessions = await adapter.listSessions();
    this.database().opencodeSessions.see(projectId, sessions);
    this.database().opencodeSessions.onServer(projectId, sessions.map(session => session.id));
    return { sessions, recorded: this.database().opencodeSessions.forProject(projectId) };
  }

  /** What the Workbench knows of the project's sessions. Nothing is asked of a server. */
  async recordedSessions(projectId: string): Promise<OpenCodeSessionRecord[]> {
    await this.lookedOnce();
    this.project(projectId);
    return this.database().opencodeSessions.forProject(projectId);
  }

  /** One session of the project, or `SessionAbsent` when the server has none such there. */
  async session(projectId: string, sessionId: string): Promise<OpenCodeSession> {
    const { adapter } = await this.holding(projectId);
    const session = await adapter.getSession(sessionId);
    if (!session) throw new SessionAbsent();
    return session;
  }

  /**
   * A text for the session. It is given only to a session that, read at this moment, runs the agent that is proven
   * read-only: another client may have switched the agent since the session was created.
   */
  async prompt(projectId: string, sessionId: string, input: { text?: unknown }): Promise<OpenCodeMessage> {
    if (!input || typeof input.text !== 'string' || !input.text.trim() || input.text.length > 20_000) throw new Invalid();
    const { adapter, readonly } = await this.holding(projectId);
    if (!readonly) throw new Refused('not_readonly');
    const session = await adapter.getSession(sessionId);
    if (!session) throw new SessionAbsent();
    if (session.agent !== READONLY_AGENT_ID || !(await this.mayAsk(projectId, sessionId))) throw new Refused('not_readonly');
    this.database().opencodeSessions.see(projectId, [session]);
    return adapter.sendPrompt(sessionId, { text: input.text });
  }

  async messages(projectId: string, sessionId: string): Promise<OpenCodeMessage[]> {
    const { adapter } = await this.holding(projectId);
    return adapter.getMessages(sessionId);
  }

  async abort(projectId: string, sessionId: string): Promise<{ interrupted: boolean }> {
    const { adapter } = await this.holding(projectId);
    return adapter.abort(sessionId);
  }

  async permissions(projectId: string, sessionId: string): Promise<OpenCodePermission[]> {
    const { adapter } = await this.holding(projectId);
    return adapter.pendingPermissions(sessionId);
  }

  /** Answers one request of the session. Nothing answers a request by itself. */
  async reply(projectId: string, sessionId: string, requestID: string, decision: unknown): Promise<void> {
    if (decision !== 'allow' && decision !== 'reject') throw new Invalid();
    const { adapter } = await this.holding(projectId);
    await adapter.replyPermission(sessionId, requestID, decision);
  }

  /** The server's events about one session of the project, and nothing else. */
  async events(projectId: string, sessionId: string, signal: AbortSignal): Promise<AsyncIterable<unknown>> {
    const { adapter } = await this.holding(projectId);
    const session = await adapter.getSession(sessionId);
    if (!session) throw new SessionAbsent();
    return adapter.sessionEvents(sessionId, signal);
  }

  /** The project has no server that this process or another is running, or that may have been left behind. */
  private unoccupied(projectId: string): void {
    if (this.held.has(projectId)) throw new Refused('already_running');
    const record = this.database().opencodeServers.forProject(projectId);
    if (record?.state === 'running') throw new Refused('running_elsewhere');
    if (record?.state === 'orphaned') throw new Refused('leftover', record.pid);
  }

  private async probe(entry: Held, record: OpenCodeServerRecord): Promise<ServerState> {
    try {
      if (entry.kind === 'managed') return await entry.server.check();
      const info = await entry.adapter.info();
      if (info.pid !== record.pid) return 'replaced';
      return info.version === VERIFIED_VERSION ? 'running' : 'incompatible_version';
    } catch (error) {
      if (error instanceof OpenCodeError && FAILURES.has(error.kind)) return error.kind as ServerState;
      return 'protocol';
    }
  }

  /** A managed server that ended on its own. Noted unless the Workbench ended it, or let go of it, itself. */
  private ended(projectId: string, exit: ExitFacts): void {
    const entry = this.held.get(projectId);
    if (entry?.kind !== 'managed') return;
    this.held.delete(projectId);
    try {
      const record = this.database().opencodeServers.forProject(projectId);
      // The record may say the server cannot be reached just now. Its ending is the truer note.
      if (record && record.state !== 'stopped' && record.state !== 'detached') {
        this.database().opencodeServers.setState(record.id, 'exited', exit.at);
      }
    } catch {
      // The database may be closed already while the Workbench ends. Nothing is noted then.
    }
  }

  private project(projectId: string) {
    const project = this.database().projects.find(projectId);
    if (!project) throw new ProjectAbsent();
    return project;
  }

  private store(input: NewOpenCodeServer): OpenCodeServerRecord {
    return this.database().opencodeServers.save(input);
  }

  private note(record: OpenCodeServerRecord, state: OpenCodeServerState, endedAt: string | null = null): OpenCodeServerRecord {
    return this.database().opencodeServers.setState(record.id, state, endedAt) ?? record;
  }
}

declare module 'fastify' {
  interface FastifyInstance { opencode: OpenCodeServers }
}

/** The origin an address names, or undefined when the address is anything but an origin. */
function originOf(address: string): string | undefined {
  try {
    const url = new URL(address);
    return ['http:', 'https:'].includes(url.protocol) && url.origin === address ? url.origin : undefined;
  } catch { return undefined; }
}

function bodyOf(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

/** What went wrong, as a status and a reason. What a server printed is for the log and is not sent. */
export function failure(reply: FastifyReply, error: unknown) {
  if (error instanceof ProjectAbsent) return reply.code(404).send({ error: 'Project not found' });
  if (error instanceof Invalid) return reply.code(400).send({ error: 'Invalid OpenCode server request' });
  if (error instanceof Refused) {
    return reply.code(409).send({ error: REFUSALS[error.reason], reason: error.reason, pid: error.pid });
  }
  if (error instanceof NoServer) {
    return reply.code(409).send({ error: 'No OpenCode server is held for this project', reason: 'no_server', server: error.record });
  }
  if (error instanceof SessionAbsent) return reply.code(404).send({ error: 'No such session in this project', reason: 'not_found' });
  if (error instanceof OpenCodeError) {
    if (error.kind === 'invalid_request') return reply.code(400).send({ error: 'Invalid OpenCode server request' });
    // The registered repository is not there any more, as the status route says of the same thing.
    if (error.kind === 'directory_unavailable') {
      return reply.code(409).send({ error: 'Registered Git repository is unavailable', reason: error.kind });
    }
    return reply.code(503).send({ error: error.message, reason: error.kind });
  }
  throw error;
}

const BASE = '/api/projects/:id/opencode/server';
const SESSIONS = '/api/projects/:id/opencode/sessions';
const ONE_SESSION = '/api/projects/:id/opencode/sessions/:sessionId';
/** A session is named as the server names it. Anything else is refused here, before a server is asked. */
const SESSION_ID = /^ses_[A-Za-z0-9]+$/;

/** How a session route answers what went wrong. The server's `not_found` is a missing session, not an outage. */
function sessionFailure(reply: FastifyReply, error: unknown) {
  if (error instanceof OpenCodeError && error.kind === 'not_found') {
    return reply.code(404).send({ error: 'No such session in this project', reason: 'not_found' });
  }
  return failure(reply, error);
}

/** The session that a session route names, or `Invalid` for a path that names no session. */
function sessionIdOf(request: { params: unknown }): string {
  const id = (request.params as { sessionId?: string }).sessionId;
  if (typeof id !== 'string' || !SESSION_ID.test(id)) throw new Invalid();
  return id;
}

export function registerOpenCodeRoutes(app: FastifyInstance, servers: () => OpenCodeServers): void {
  app.post<{ Params: { id: string }; Body: unknown }>(BASE, async (request, reply) => {
    if (!UUID.test(request.params.id)) return reply.code(400).send({ error: 'Invalid project ID' });
    const body = bodyOf(request.body);
    try {
      if (body.mode === 'managed') {
        // A start takes a moment, so the request may be gone by the time a failure is logged.
        const log = (message: string, output: string) => {
          if (!reply.raw.destroyed) request.log.error({ output }, message);
        };
        return reply.code(201).send({ server: await servers().start(request.params.id, log) });
      }
      if (body.mode === 'attached') {
        return reply.code(201).send({ server: await servers().attach(request.params.id, body) });
      }
      return reply.code(400).send({ error: 'Invalid OpenCode server request' });
    } catch (error) { return failure(reply, error); }
  });

  app.get<{ Params: { id: string } }>(BASE, async (request, reply) => {
    if (!UUID.test(request.params.id)) return reply.code(400).send({ error: 'Invalid project ID' });
    return servers().status(request.params.id);
  });

  app.delete<{ Params: { id: string } }>(BASE, async (request, reply) => {
    if (!UUID.test(request.params.id)) return reply.code(400).send({ error: 'Invalid project ID' });
    try {
      const result = await servers().stop(request.params.id);
      if (result === 'nothing') return reply.code(404).send({ error: 'No OpenCode server to stop for this project' });
      if (result === 'unverifiable') {
        return reply.code(409).send({
          error: 'The server that was recorded cannot be proved to be the process that is there', reason: result,
        });
      }
      if (result === 'running_elsewhere' || result === 'leftover') {
        return reply.code(409).send({ error: REFUSALS[result], reason: result });
      }
      return { server: (await servers().status(request.params.id)).server, result };
    } catch (error) { return failure(reply, error); }
  });

  // The sessions of the project's server. A route that names a session answers 400 for a path that is no session
  // id, 404 for one the server has none of under this project, and 409 while no server is held.
  app.post<{ Params: { id: string }; Body: unknown }>(SESSIONS, async (request, reply) => {
    if (!UUID.test(request.params.id)) return reply.code(400).send({ error: 'Invalid project ID' });
    try {
      return reply.code(201).send({ session: await servers().createSession(request.params.id, bodyOf(request.body)) });
    } catch (error) { return sessionFailure(reply, error); }
  });

  app.get<{ Params: { id: string } }>(SESSIONS, async (request, reply) => {
    if (!UUID.test(request.params.id)) return reply.code(400).send({ error: 'Invalid project ID' });
    try {
      return await servers().sessions(request.params.id);
    } catch (error) { return sessionFailure(reply, error); }
  });

  // What the Workbench remembers of the project's sessions. Nothing is asked of a server, so this answers while
  // none is running.
  app.get<{ Params: { id: string } }>(`${SESSIONS}/recorded`, async (request, reply) => {
    if (!UUID.test(request.params.id)) return reply.code(400).send({ error: 'Invalid project ID' });
    try {
      return { recorded: await servers().recordedSessions(request.params.id) };
    } catch (error) { return sessionFailure(reply, error); }
  });

  app.get<{ Params: { id: string; sessionId: string } }>(ONE_SESSION, async (request, reply) => {
    if (!UUID.test(request.params.id)) return reply.code(400).send({ error: 'Invalid project ID' });
    try {
      return { session: await servers().session(request.params.id, sessionIdOf(request)) };
    } catch (error) { return sessionFailure(reply, error); }
  });

  // The text is queued; the answer comes later, through the events of the session. 202, not 201: the run is not
  // part of this answer.
  app.post<{ Params: { id: string; sessionId: string }; Body: unknown }>(`${ONE_SESSION}/prompt`, async (request, reply) => {
    if (!UUID.test(request.params.id)) return reply.code(400).send({ error: 'Invalid project ID' });
    try {
      return reply.code(202).send({
        message: await servers().prompt(request.params.id, sessionIdOf(request), bodyOf(request.body)),
      });
    } catch (error) { return sessionFailure(reply, error); }
  });

  app.get<{ Params: { id: string; sessionId: string } }>(`${ONE_SESSION}/messages`, async (request, reply) => {
    if (!UUID.test(request.params.id)) return reply.code(400).send({ error: 'Invalid project ID' });
    try {
      return { messages: await servers().messages(request.params.id, sessionIdOf(request)) };
    } catch (error) { return sessionFailure(reply, error); }
  });

  app.post<{ Params: { id: string; sessionId: string } }>(`${ONE_SESSION}/abort`, async (request, reply) => {
    if (!UUID.test(request.params.id)) return reply.code(400).send({ error: 'Invalid project ID' });
    try {
      return await servers().abort(request.params.id, sessionIdOf(request));
    } catch (error) { return sessionFailure(reply, error); }
  });

  app.get<{ Params: { id: string; sessionId: string } }>(`${ONE_SESSION}/permissions`, async (request, reply) => {
    if (!UUID.test(request.params.id)) return reply.code(400).send({ error: 'Invalid project ID' });
    try {
      return { permissions: await servers().permissions(request.params.id, sessionIdOf(request)) };
    } catch (error) { return sessionFailure(reply, error); }
  });

  // One answer, by a person. Nothing answers a request by itself.
  app.post<{ Params: { id: string; sessionId: string; requestID: string }; Body: unknown }>(
    `${ONE_SESSION}/permissions/:requestID/reply`,
    async (request, reply) => {
      if (!UUID.test(request.params.id)) return reply.code(400).send({ error: 'Invalid project ID' });
      try {
        await servers().reply(request.params.id, sessionIdOf(request), request.params.requestID, bodyOf(request.body).decision);
        return reply.code(204).send();
      } catch (error) { return sessionFailure(reply, error); }
    },
  );

  // The events of one session, as they come, for a page that keeps the conversation open. The answer is the stream
  // itself; a failure before it starts is the usual JSON answer.
  app.get<{ Params: { id: string; sessionId: string } }>(`${ONE_SESSION}/events`, async (request, reply) => {
    if (!UUID.test(request.params.id)) return reply.code(400).send({ error: 'Invalid project ID' });
    const closing = new AbortController();
    let events: AsyncIterable<unknown>;
    try {
      events = await servers().events(request.params.id, sessionIdOf(request), closing.signal);
    } catch (error) { return sessionFailure(reply, error); }
    // From here the answer is the stream. The route owns the response: Fastify is not to write to it any more.
    reply.hijack();
    // The reader going away is what ends the stream; a request's own `close` says only that its body was read.
    reply.raw.on('close', () => closing.abort());
    reply.raw.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
    // The head goes out with the first bytes, not with the first event: a reader that waits for the answer and a
    // stream that waits for something to tell would otherwise hold each other off.
    reply.raw.write(': connected\n\n');
    try {
      for await (const event of events) {
        if (closing.signal.aborted || reply.raw.destroyed) break;
        reply.raw.write(`data: ${JSON.stringify(event)}\n\n`);
      }
    } catch {
      // A stream that died mid-way ends here; the reader asks again.
    }
    if (!reply.raw.destroyed) reply.raw.end();
  });
}

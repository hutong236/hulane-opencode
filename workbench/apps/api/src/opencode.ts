import type { FastifyInstance, FastifyReply } from 'fastify';
import type {
  NewOpenCodeServer, OpenCodeServerRecord, OpenCodeServerState, WorkbenchDatabase,
} from '@hulane/workbench-database';
import {
  OpenCodeError, RunningOpenCodeServer, ServerStartError, VERIFIED_VERSION, connectOpenCode, endLeftoverServer,
  startManagedOpenCode,
  type ExitFacts, type ManagedServerOptions, type OpenCodeAdapter, type ServerState,
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
  | 'leftover';          // one an earlier Workbench process left behind may still be there
const REFUSALS: Record<Refusal, string> = {
  already_running: 'An OpenCode server is already running for this project',
  running_elsewhere: 'An OpenCode server of this project is held by another Workbench process',
  leftover: 'A server left behind by an earlier Workbench run may still be there; stop it first',
};

class ProjectAbsent extends Error {}
class Refused extends Error {
  constructor(readonly reason: Refusal, readonly pid: number | null = null) { super(reason); }
}
class Invalid extends Error {}

export interface OpenCodeOptions {
  /** The program that starts a managed server. From the Workbench's own environment, never from a request. */
  command?: readonly string[];
  /** How long a start may take. 30 s. */
  startTimeoutMs?: number;
  /** Reads a process's start time, command line and parent. For tests. */
  describe?: ManagedServerOptions['describe'];
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

  constructor(private readonly database: () => WorkbenchDatabase, private readonly options: OpenCodeOptions = {}) {}

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
function failure(reply: FastifyReply, error: unknown) {
  if (error instanceof ProjectAbsent) return reply.code(404).send({ error: 'Project not found' });
  if (error instanceof Invalid) return reply.code(400).send({ error: 'Invalid OpenCode server request' });
  if (error instanceof Refused) {
    return reply.code(409).send({ error: REFUSALS[error.reason], reason: error.reason, pid: error.pid });
  }
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
}

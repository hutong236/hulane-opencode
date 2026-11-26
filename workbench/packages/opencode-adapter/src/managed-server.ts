import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { lstatSync } from 'node:fs';
import { promisify } from 'node:util';
import { randomBytes } from 'node:crypto';
import { OpenCodeHttpAdapter, VERIFIED_VERSION, type OpenCodeAdapter, type OpenCodeServerInfo } from './client.js';
import { OpenCodeError, type OpenCodeErrorKind } from './errors.js';
import { READONLY_AGENT_ID, managedConfigContent, readOnlyProblems } from './readonly-agent.js';

const run = promisify(execFile);
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
/** How much of what the server printed is kept, for a diagnosis. */
const OUTPUT_LIMIT = 4_096;
const MANAGED_HOSTS = new Set(['127.0.0.1', '::1']);
/** The ways a running server can fail, as `OpenCodeError` kinds. */
const FAILURE_KINDS: ReadonlySet<string> = new Set([
  'unavailable', 'timeout', 'unauthorized', 'refused', 'protocol', 'directory_unavailable',
]);

/** What the system says about a process. */
export interface ProcessIdentity {
  /** When it started, as `ps` prints it. A process number belongs to this process only while this is the same. */
  started: string;
  command: string;
  parent: number;
}

/**
 * Reads a process's parent, start time and command line with `ps`. Null when the system cannot say: there is no `ps`,
 * or no such process. Read on macOS; Linux has the same columns.
 */
export async function describeProcess(pid: number): Promise<ProcessIdentity | null> {
  let stdout: string;
  try {
    ({ stdout } = await run('ps', ['-o', 'ppid=,lstart=,command=', '-p', String(pid)], {
      encoding: 'utf8', timeout: 5_000, env: { ...process.env, LC_ALL: 'C', TZ: 'UTC' },
    }));
  } catch { return null; }
  const tokens = stdout.trim().split(/\s+/);
  // The parent's number, then the start time. That ends with the year and, on Linux, may begin without the weekday.
  const year = tokens.findIndex((token, index) => index > 0 && /^\d{4}$/.test(token));
  if (tokens.length < 4 || !/^\d+$/.test(tokens[0]) || year < 3) return null;
  return {
    parent: Number(tokens[0]), started: tokens.slice(1, year + 1).join(' '), command: tokens.slice(year + 1).join(' '),
  };
}

export interface ManagedServerOptions {
  /** The project the server works for: its working directory, and the directory every request names. */
  directory: string;
  /**
   * The program that starts the server and the arguments before `serve`. It comes from the Workbench's own
   * environment (`WORKBENCH_OPENCODE_BIN`), never from a request. `opencode` when nothing is given.
   */
  command?: readonly string[];
  /** `127.0.0.1`. A managed server listens on this machine only. */
  hostname?: string;
  /** On top of the Workbench's own environment. The password and the read-only agent are always the Workbench's. */
  env?: NodeJS.ProcessEnv;
  /** How long the server may take to say it listens and then to offer its agents. 30 s. */
  startTimeoutMs?: number;
  /** How long the server gets to end on SIGTERM before it is killed. 5 s. */
  stopTimeoutMs?: number;
  /** How long one request to the server may take. 10 s. */
  requestTimeoutMs?: number;
  /** For tests. */
  spawn?: typeof spawn;
  describe?: (pid: number) => Promise<ProcessIdentity | null>;
}

/**
 * Why a managed server could not be started. `output` is the end of what the server printed, without the password:
 * for the server log, not for a page.
 */
export class ServerStartError extends OpenCodeError {
  constructor(kind: OpenCodeErrorKind, message: string, readonly output = '') {
    super(kind, message);
    this.name = 'ServerStartError';
  }
}

/** How the server is, as far as the Workbench can tell. */
export type ServerState =
  | 'running'
  | 'exited'                // the process that was started has ended
  | 'replaced'              // another process answers on the address now
  | 'incompatible_version'
  | 'unavailable' | 'timeout' | 'unauthorized' | 'refused' | 'protocol' | 'directory_unavailable';

export interface ExitFacts { code: number | null; signal: string | null; at: string }

/** The process ended; `exit` says how. */
class Ended extends Error {
  constructor(readonly exit: ExitFacts) {
    super('The server process ended');
  }
}

/** Follows one child process: what it printed, whether it ended, and what it said when. */
class Watch {
  private tail = '';
  private failure: Error | undefined;
  private readonly printing = new Set<() => void>();
  private readonly exitListeners = new Set<(exit: ExitFacts) => void>();
  /** Resolves when the process has ended. A process that could not be started never gets here. */
  readonly exited: Promise<ExitFacts>;
  /** Resolves when the process could not be started or controlled. */
  readonly failed: Promise<Error>;

  constructor(readonly process: ChildProcess, private readonly secret: string) {
    const child = this.process;
    const feed = (chunk: Buffer) => {
      // The CLI colors its output.
      this.tail = (this.tail + chunk.toString().replace(/\u001b\[[0-9;]*m/g, '')).slice(-OUTPUT_LIMIT);
      for (const listener of [...this.printing]) listener();
    };
    child.stdout?.on('data', feed);
    child.stderr?.on('data', feed);
    this.exited = new Promise((resolve) => child.once('exit', (code, signal) => {
      const exit = { code, signal, at: new Date().toISOString() };
      this.printing.clear();
      for (const listener of [...this.exitListeners]) listener(exit);
      resolve(exit);
    }));
    this.failed = new Promise((resolve) => child.once('error', (error) => {
      this.failure = error;
      this.printing.clear();
      resolve(error);
    }));
  }

  get running(): boolean {
    return this.process.exitCode === null && this.process.signalCode === null && this.failure === undefined;
  }

  /** The end of what the process printed, without the password. */
  text(): string {
    return this.tail.split(this.secret).join('[password]');
  }

  onExit(listener: (exit: ExitFacts) => void): () => void {
    this.exitListeners.add(listener);
    return () => { this.exitListeners.delete(listener); };
  }

  /** True when the process has ended, or when it ends within `ms`. */
  async endsWithin(ms: number): Promise<boolean> {
    if (!this.running) return true;
    return Promise.race([this.exited.then(() => true), sleep(ms).then(() => false)]);
  }

  /** How the process ended, or why it could not be started. */
  async ended(): Promise<Ended | Error> {
    const how = await Promise.race([this.exited, this.failed]);
    return how instanceof Error ? how : new Ended(how);
  }

  /** Waits for the process to print what `pattern` captures. Ends, fails or runs out of time: each ends the wait. */
  printed(pattern: RegExp, timeoutMs: number): Promise<string> {
    const found = pattern.exec(this.text());
    if (found) return Promise.resolve(found[1]);
    if (!this.running) return this.ended().then((how) => Promise.reject(how));
    return new Promise<string>((resolve, reject) => {
      const finish = (settle: () => void) => {
        clearTimeout(timer);
        this.printing.delete(listener);
        settle();
      };
      const listener = () => {
        const match = pattern.exec(this.text());
        if (match) finish(() => resolve(match[1]));
      };
      const timer = setTimeout(
        () => finish(() => reject(new OpenCodeError('timeout', 'The OpenCode server did not say it listens in time'))),
        timeoutMs,
      );
      this.printing.add(listener);
      void this.failed.then((error) => finish(() => reject(error)));
      void this.exited.then((exit) => finish(() => reject(new Ended(exit))));
    });
  }
}

export interface ConnectedServer {
  adapter: OpenCodeAdapter;
  info: OpenCodeServerInfo;
  /** Whether the server has an agent that is proven read-only. Until it has, it gets no task from the Workbench. */
  readOnly: boolean;
  /** Why the read-only agent is not proven, when it is not. */
  problems: string[];
}

export interface ConnectOptions {
  baseUrl: string;
  /** The canonical root of the registered project. */
  directory: string;
  password?: string;
  timeoutMs?: number;
  /** How long to wait for the server to offer its agents. 10 s. */
  readyTimeoutMs?: number;
  /** How long to ask again for the read-only agent when it is not found by name. 2 s. */
  agentGraceMs?: number;
  /** For tests. */
  fetch?: typeof fetch;
}

/**
 * An OpenCode server the Workbench started for one project, and that only the Workbench can talk to: it listens on
 * this machine, with a password made for it that is never written anywhere. It was checked before it was given out:
 * the verified version, the process that was started, and an agent that is proven read-only.
 */
export class RunningOpenCodeServer {
  private readonly child: ChildProcess;
  private readonly watch: Watch;
  private readonly stopTimeoutMs: number;
  readonly adapter: OpenCodeAdapter;
  readonly pid: number;
  readonly exited: Promise<ExitFacts>;

  /** `watch` is the one that followed the process from the start, so that nothing it printed is lost. */
  private constructor(
    watch: Watch, readonly directory: string, private readonly password: string,
    stopTimeoutMs: number, requestTimeoutMs: number,
    readonly baseUrl: string,
    readonly version: string,
    readonly startedAt: string,
    /** What the system said about the process when it was started. Null where there is no `ps`. */
    readonly identity: ProcessIdentity | null,
  ) {
    this.watch = watch;
    this.child = watch.process;
    this.stopTimeoutMs = stopTimeoutMs;
    this.pid = watch.process.pid as number;
    this.exited = watch.exited;
    this.adapter = new OpenCodeHttpAdapter({ baseUrl, directory, password, timeoutMs: requestTimeoutMs });
  }

  /** Starts the server and waits until it is what it should be. One that cannot be got there is stopped and reported. */
  static async start(options: ManagedServerOptions): Promise<RunningOpenCodeServer> {
    const hostname = options.hostname ?? '127.0.0.1';
    if (!MANAGED_HOSTS.has(hostname)) {
      throw new ServerStartError('invalid_request', 'A managed OpenCode server listens on 127.0.0.1 or ::1');
    }
    const { directory } = options;
    if (typeof directory !== 'string' || !directory.startsWith('/')) {
      throw new ServerStartError('invalid_request', 'The project directory has to be absolute');
    }
    // The root was read when the project was registered. It may have been moved or deleted since.
    if (!isDirectory(directory)) {
      throw new ServerStartError('directory_unavailable', 'The project directory is not a directory any more');
    }
    const inherited: NodeJS.ProcessEnv = { ...process.env, ...options.env };
    // A password for this server alone. Without one of its own the CLI makes one and prints it.
    const password = randomBytes(24).toString('base64url');
    const command = options.command ?? [process.env.WORKBENCH_OPENCODE_BIN ?? 'opencode'];
    const stopTimeoutMs = options.stopTimeoutMs ?? 5_000;
    const requestTimeoutMs = options.requestTimeoutMs ?? 10_000;
    const startedAt = new Date().toISOString();
    const deadline = Date.now() + (options.startTimeoutMs ?? 30_000);
    const child = (options.spawn ?? spawn)(
      command[0], [...command.slice(1), 'serve', '--hostname', hostname, '--port', '0'],
      {
        cwd: directory,
        env: {
          ...inherited,
          OPENCODE_PASSWORD: password,
          OPENCODE_CONFIG_CONTENT: managedConfigContent(inherited.OPENCODE_CONFIG_CONTENT),
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    const watch = new Watch(child, password);
    try {
      // `--port 0`: the server picks a port that is free, and says which.
      const baseUrl = readOrigin(await watch.printed(/listening on (\S+)/, options.startTimeoutMs ?? 30_000), hostname);
      const adapter = new OpenCodeHttpAdapter({ baseUrl, directory, password, timeoutMs: requestTimeoutMs });
      // Right after it says it listens, a first request may still come too soon.
      const info = await described(adapter, watch, Math.min(deadline, Date.now() + 3_000));
      if (info.version !== VERIFIED_VERSION) {
        throw new ServerStartError(
          'incompatible_version', `OpenCode ${info.version} is not the verified ${VERIFIED_VERSION}; adapt and verify first`,
        );
      }
      // Another process on that port would be given the password with every request. So it is not used.
      if (info.pid !== child.pid) {
        throw new ServerStartError('pid_mismatch', 'The server that answered is not the process that was started');
      }
      const problems = await readonlyAgentOf(adapter, deadline, watch);
      if (problems.length > 0) {
        throw new ServerStartError(
          'readonly_agent', `The server's "${READONLY_AGENT_ID}" agent is not proven read-only: ${problems.join('; ')}`,
        );
      }
      const identity = await (options.describe ?? describeProcess)(child.pid as number);
      return new RunningOpenCodeServer(
        watch, directory, password, stopTimeoutMs, requestTimeoutMs, baseUrl, info.version, startedAt, identity,
      );
    } catch (error) {
      // Whatever went wrong, no half-started server is left behind.
      await stopProcess(child, watch, stopTimeoutMs).catch(() => undefined);
      throw await failureOf(error, watch, command[0], directory);
    }
  }

  /** Asks the server to end, and kills it when it does not within the stop timeout. */
  async stop(): Promise<void> {
    await stopProcess(this.child, this.watch, this.stopTimeoutMs);
  }

  /** Kills the server at once, for the moment the Workbench itself ends and cannot wait. */
  killNow(): void {
    if (this.watch.running) this.child.kill('SIGKILL');
  }

  /** How the server is now. Nothing is asked of it once its process has ended. */
  async check(): Promise<ServerState> {
    if (!this.watch.running) return 'exited';
    try {
      const info = await this.adapter.info();
      if (info.pid !== this.pid) return 'replaced';
      if (info.version !== VERIFIED_VERSION) return 'incompatible_version';
      return 'running';
    } catch (error) {
      if (error instanceof OpenCodeError && FAILURE_KINDS.has(error.kind)) return error.kind as ServerState;
      throw error;
    }
  }

  get running(): boolean {
    return this.watch.running;
  }

  /** The end of what the server printed, without the password. */
  diagnostics(): string {
    return this.watch.text();
  }

  /** Calls `listener` when the process ends, from a stop or on its own. */
  onExit(listener: (exit: ExitFacts) => void): () => void {
    return this.watch.onExit(listener);
  }
}

export const startManagedOpenCode = (options: ManagedServerOptions): Promise<RunningOpenCodeServer> =>
  RunningOpenCodeServer.start(options);

/** How a managed server was started, at the end of its command line. */
const SERVE_COMMAND = / serve --hostname (?:127\.0\.0\.1|\[::1\]) --port 0$/;

/**
 * Ends a server that an earlier Workbench process started and left behind, once the system says that this is it: the
 * same process number, started at the same time, with the command line of a managed server. False when that cannot
 * be said, and then nothing is signalled. A process number alone is not proof: it may belong to another process now.
 */
export async function endLeftoverServer(pid: number, started: string | null, timeoutMs = 5_000): Promise<boolean> {
  if (!Number.isSafeInteger(pid) || pid <= 1 || !started) return false;
  const now = await describeProcess(pid);
  if (!now || now.started !== started || !SERVE_COMMAND.test(now.command)) return false;
  try {
    process.kill(pid, 'SIGTERM');
    if (await goneWithin(pid, timeoutMs)) return true;
    process.kill(pid, 'SIGKILL');
    return goneWithin(pid, timeoutMs);
  } catch (error) {
    // Already gone is the end that was wanted. Anything else, as a process of another user, is not ours to end.
    return (error as NodeJS.ErrnoException).code === 'ESRCH';
  }
}

/** True when no process has that number any more, or when the time is up. */
async function goneWithin(pid: number, timeoutMs: number): Promise<boolean> {
  const until = Date.now() + timeoutMs;
  while (true) {
    try { process.kill(pid, 0); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ESRCH') return true;
    }
    if (Date.now() >= until) return false;
    await sleep(100);
  }
}

/**
 * Attaches to a server someone else started. Nothing is started and nothing is written: the address and the password
 * are the ones the server was given, and the version is the verified one or nothing.
 */
export async function connectOpenCode(options: ConnectOptions): Promise<ConnectedServer> {
  const adapter = new OpenCodeHttpAdapter({
    baseUrl: options.baseUrl, directory: options.directory, password: options.password, timeoutMs: options.timeoutMs,
    ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
  });
  const info = await adapter.info();
  if (info.version !== VERIFIED_VERSION) {
    throw new OpenCodeError(
      'incompatible_version', `OpenCode ${info.version} is not the verified ${VERIFIED_VERSION}; adapt and verify first`,
    );
  }
  const problems = await readonlyAgentOf(adapter, Date.now() + (options.readyTimeoutMs ?? 10_000), undefined, options.agentGraceMs);
  return { adapter, info, readOnly: problems.length === 0, problems };
}

/**
 * Looks for the read-only agent and says what is wrong with it; nothing when it is proven.
 *
 * The server loads the agents of a directory when the directory is first listed, and finds them by name from then on,
 * even while the list still answers empty (read on four real servers). So the list is asked first. An agent that is
 * not found by name is asked for again for a moment, in case it is still loading; then it is not there.
 */
async function readonlyAgentOf(
  adapter: OpenCodeAdapter, deadline: number, watch?: Watch, graceMs = 2_000,
): Promise<string[]> {
  const until = Math.min(deadline, Date.now() + graceMs);
  while (true) {
    try { await adapter.listAgents(); }
    catch (error) {
      // It answered a moment ago, so this is a failure and not a start still in progress, unless its process ended.
      if (!(error instanceof OpenCodeError)) throw error;
      if (watch && !watch.running) throw await watch.ended();
      throw error;
    }
    const agent = await adapter.getAgent(READONLY_AGENT_ID);
    if (agent) return readOnlyProblems(agent);
    if (Date.now() >= until) return [`there is no agent named "${READONLY_AGENT_ID}"`];
    await sleep(200);
  }
}

/** Asks for the server description until it comes, while the process is there and the time is not up. */
async function described(adapter: OpenCodeAdapter, watch: Watch, until: number): Promise<OpenCodeServerInfo> {
  while (true) {
    if (!watch.running) throw await watch.ended();
    try { return await adapter.info(); }
    catch (error) {
      if (!(error instanceof OpenCodeError) || error.kind !== 'unavailable' || Date.now() >= until) throw error;
      await sleep(150);
    }
  }
}

/** SIGTERM, then SIGKILL when the process is still there. A process that could not be started is nothing to stop. */
async function stopProcess(child: ChildProcess, watch: Watch, stopTimeoutMs: number): Promise<void> {
  if (!watch.running) return;
  child.kill('SIGTERM');
  if (await watch.endsWithin(stopTimeoutMs)) return;
  child.kill('SIGKILL');
  if (await watch.endsWithin(stopTimeoutMs)) return;
  throw new OpenCodeError('refused', `The OpenCode server (process ${child.pid}) did not end`);
}

/** The error a start fails with, and the end of what the server printed for the log. */
async function failureOf(error: unknown, watch: Watch, program: string, directory: string): Promise<unknown> {
  const output = watch.text();
  if (error instanceof Ended) {
    const how = error.exit.code === null ? `on ${error.exit.signal}` : `with code ${error.exit.code}`;
    return new ServerStartError('exited', `The OpenCode server ended before it could be used (${how})`, output);
  }
  if (error instanceof OpenCodeError) return new ServerStartError(error.kind, error.message, output);
  if (error instanceof Error && (error as NodeJS.ErrnoException).code) {
    // Nothing was started. Usually there is no such program; a directory that vanished says so.
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' && !isDirectory(directory)) {
      return new ServerStartError('directory_unavailable', 'The project directory is not a directory any more', output);
    }
    if (code === 'ENOENT') {
      return new ServerStartError('not_installed', `There is no program "${program}" to start the OpenCode server`, output);
    }
    if (code === 'EACCES' || code === 'EPERM') {
      return new ServerStartError('not_installed', `"${program}" cannot be run`, output);
    }
    return new ServerStartError('refused', `The OpenCode server could not be started (${code})`, output);
  }
  return error;
}

/** The address the server printed, when it is the address it was asked to listen on. */
function readOrigin(printed: string, hostname: string): string {
  const expected = hostname.includes(':') ? `[${hostname}]` : hostname;
  let url: URL | undefined;
  try { url = new URL(printed); } catch { url = undefined; }
  if (!url || url.protocol !== 'http:' || url.hostname !== expected || !/^[1-9]\d*$/.test(url.port) ||
      url.pathname !== '/' || url.search || url.hash || url.username || url.password) {
    throw new ServerStartError('protocol', 'The server did not say where it listens');
  }
  return url.origin;
}

function isDirectory(path: string): boolean {
  try { return lstatSync(path).isDirectory(); } catch { return false; }
}

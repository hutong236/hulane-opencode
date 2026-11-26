/** Types of `mock-server.mjs`, for the tests that start it in their own process. */
export interface AgentPermission { action: string; resource: string; effect: string }
export interface AgentRow {
  id: string; name: string; mode: string; hidden: boolean; description: string; permissions: AgentPermission[];
}
export interface SessionRow {
  id: string; projectID: string; cost: number; tokens: Record<string, number>;
  time: { created: number; updated: number }; title: string; location: { directory: string };
}
export interface MessageRow { id: string; sessionID: string; time: { created: number }; type: string; payload: { text: string }; delivery: string }
export interface Recorded { method: string; path: string; directory?: string; authorization?: string; body: unknown }

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
  /** When set, `/api/info` reports this pid instead of the server's own. */
  reportedPid: number | null;
  /** Every agent the server offers: its built-in ones and those of its configuration content. */
  agents: Map<string, AgentRow>;
  /** The directories whose agents were listed once. */
  agentDirectories: Set<string>;
  /** Makes the first listing of a directory answer an empty list, as the real server does right after a start. */
  agentFirstListEmpty: boolean;
  /** Directories answered with `LocationNotFoundError`. */
  missingDirectories: Set<string>;
  /** When set, the agent answers name this directory instead of the one that was asked. */
  agentLocation: string | null;
  /** `malformed`: an agent is answered without its rules. `another`: another agent is answered under the name asked for. */
  agentShape: 'ok' | 'malformed' | 'another';
  emit: (event: Record<string, unknown>) => void;
  close: () => Promise<void>;
}

export interface MockOptions {
  password?: string;
  directory?: string;
  /** The configuration content the server was started with, as `OPENCODE_CONFIG_CONTENT` gives it. */
  configContent?: string;
  /** The port to listen on. Any free one when nothing is given. */
  port?: number;
}

export function startMockOpenCode(options?: MockOptions): Promise<MockOpenCode>;
export const BUILTIN_AGENTS: readonly AgentRow[];
export function agentsOfConfigContent(content: string | null | undefined): AgentRow[];

import { OpenCodeHttpAdapter, VERIFIED_VERSION, type OpenCodeServerInfo } from './client.js';
import { OpenCodeError } from './errors.js';
import { describeProcess, RunningOpenCodeServer, connectOpenCode, ServerStartError } from './managed-server.js';
import { READONLY_AGENT_ID, managedConfigContent, readOnlyProblems, resolvePermission } from './readonly-agent.js';

export { OpenCodeHttpAdapter, VERIFIED_VERSION };
export type {
  AgentPermission, OpenCodeAdapter, OpenCodeAgent, OpenCodeClientOptions, OpenCodeMessage, OpenCodeServerInfo,
  OpenCodeSession, PromptInput,
} from './client.js';
export { OpenCodeError } from './errors.js';
export type { OpenCodeErrorKind } from './errors.js';
export { EventStreamParser } from './sse.js';
export type { ServerEvent } from './sse.js';

/** Starts an OpenCode server for one project and checks it before it is given out. */
export const startManagedOpenCode = (options: StartOptions): Promise<RunningOpenCodeServer> =>
  RunningOpenCodeServer.start(options);
export { RunningOpenCodeServer, ServerStartError, connectOpenCode, describeProcess };
export type {
  ConnectOptions, ConnectedServer, ExitFacts, ManagedServerOptions, ProcessIdentity, ServerState,
} from './managed-server.js';
import type { ManagedServerOptions as StartOptions } from './managed-server.js';

export { READONLY_AGENT_ID, managedConfigContent, readOnlyProblems, resolvePermission };
export type { PermissionEffect } from './readonly-agent.js';

/**
 * The server is the one this adapter was read from. Another version is refused until someone has read it the same
 * way; a server that answers in a newer minor version may have changed what this code relies on.
 */
export function assertVerifiedVersion(info: OpenCodeServerInfo): void {
  if (info.version !== VERIFIED_VERSION) {
    throw new OpenCodeError(
      'incompatible_version', `OpenCode ${info.version} is not the verified ${VERIFIED_VERSION}; adapt and verify first`,
    );
  }
}

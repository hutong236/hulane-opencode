import type { AgentPermission } from '../src/index.ts';

/**
 * The rules the real 2.2.7 server reported for the read-only agent on 2026-11-26: its own first, the agent's after
 * them. The real-server test reads the same line from a real server whenever the CLI is installed, so that the mock
 * and the check stay tied to what the server does.
 */
export const REAL_READONLY_RULES =
  '*:allow | read *.env:ask | read *.env.*:ask | read *.env.example:allow | *:deny | read:allow | read *.env:ask | ' +
  'read *.env.*:ask | glob:allow | list:allow | browser:deny | skill browser:deny';

/** Rules on one line, as they are compared here: `action resource:effect`. */
export const shown = (rules: AgentPermission[]): string =>
  rules.map(rule => `${rule.action}${rule.resource === '*' ? '' : ` ${rule.resource}`}:${rule.effect}`).join(' | ');

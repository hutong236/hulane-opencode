import { basename } from 'node:path';
import type { AgentPermission, OpenCodeAgent } from './client.js';

/** `allow`, `ask` or `deny`: what a permission rule says. */
export type PermissionEffect = AgentPermission['effect'];

/**
 * The agent the Workbench gives a read-only task to. A managed server gets it as configuration in its environment
 * (`OPENCODE_CONFIG_CONTENT`), so nothing is written into a repository or into the user's own OpenCode configuration.
 *
 * Every rule below was read from a real 2.2.7 server on 2026-11-26:
 * - The key is `agent`. Under `agents` the agent is listed, but its rules are not applied.
 * - The server puts its own rules first and the agent's after them, and the last rule that matches wins. So the agent
 *   denies everything, then allows what it may do.
 * - `read` has to be an object with its own patterns, after its `*`. A flat `read: "allow"` would also allow `.env`,
 *   because it comes after the server's "ask first" rule for those files.
 * - `grep` runs ripgrep with `--hidden`, so it would search `.env` files without asking. It is not given.
 * - The built-in `plan` agent is not read-only either: it denies `edit` and leaves `shell` allowed.
 */
export const READONLY_AGENT_ID = 'workbench-readonly';

const READONLY_AGENT = {
  mode: 'primary',
  description: 'Reads the repository and answers. Never changes a file and never runs a command.',
  permission: {
    '*': 'deny',
    read: { '*': 'allow', '*.env': 'ask', '*.env.*': 'ask' },
    glob: 'allow',
    list: 'allow',
  },
} as const;

/** The configuration content a managed server starts with: what its environment already had, and the read-only agent. */
export function managedConfigContent(existing: string | undefined): string {
  let own: Record<string, unknown> = {};
  if (existing) {
    try {
      const parsed: unknown = JSON.parse(existing);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) own = parsed as Record<string, unknown>;
    } catch {
      // Not a JSON object: the server would not have taken it either.
    }
  }
  const agents = own.agent && typeof own.agent === 'object' && !Array.isArray(own.agent)
    ? { ...(own.agent as Record<string, unknown>) }
    : {};
  return JSON.stringify({ ...own, agent: { ...agents, [READONLY_AGENT_ID]: READONLY_AGENT } });
}

/** `*` is any run of characters, across directories; `?` is one character; everything else is itself. */
function glob(pattern: string, text: string): boolean {
  let p = 0;
  let t = 0;
  let star = -1;
  let mark = 0;
  while (t < text.length) {
    if (p < pattern.length && (pattern[p] === '?' || pattern[p] === text[t])) {
      p++;
      t++;
    } else if (p < pattern.length && pattern[p] === '*') {
      star = p++;
      mark = t;
    } else if (star >= 0) {
      p = star + 1;
      t = ++mark;
    } else {
      return false;
    }
  }
  while (p < pattern.length && pattern[p] === '*') p++;
  return p === pattern.length;
}

/** `*` matches across directories, so `*.env` matches a file by its name wherever it is, and a path pattern by its path. */
function matches(pattern: string, resource: string): boolean {
  return pattern === '*' || glob(pattern, resource);
}

/**
 * What the rules mean for one action on one file. The last rule that matches wins. Null when no rule does: the
 * server's own default applies then, which is not known.
 */
export function resolvePermission(rules: AgentPermission[], action: string, resource: string): PermissionEffect | null {
  let effect: PermissionEffect | null = null;
  for (const rule of rules) {
    if ((rule.action === '*' || rule.action === action) && matches(rule.resource, resource)) effect = rule.effect;
  }
  return effect;
}

/** Permission names of everything that changes something, reaches out, or can show a file nobody asked for. */
const CHANGING_ACTIONS = [
  'edit', 'write', 'patch', 'multiedit', 'bash', 'shell', 'browser', 'webfetch', 'websearch',
  'task', 'subagent', 'skill', 'question', 'todowrite', 'grep',
];
const READING_ACTIONS = ['read', 'glob', 'list'];
const ORDINARY_FILE = '/repo/src/app.ts';
const SECRET_FILES = ['.env', '/repo/.env', '/repo/config/.env.production', '/repo/.env.local', '/repo/ops/.env.staging'];

/**
 * Why the agent is not proven to be read-only in this project. Empty when it is.
 *
 * This reads what the server computed, not what was configured: a rule of the user's own configuration could come
 * after the agent's. Anything that is not denied explicitly counts as not read-only, including a tool nobody listed here.
 */
export function readOnlyProblems(agent: OpenCodeAgent): string[] {
  const rules = agent.permissions;
  const problems: string[] = [];
  if (agent.mode !== 'primary' && agent.mode !== 'all') problems.push(`it is a ${agent.mode} agent, not one a session runs`);

  // The rule for everything has to end in deny. It is what denies a tool that is not named here.
  const catchAll = rules.filter(rule => rule.action === '*' && rule.resource === '*').at(-1);
  if (!catchAll || catchAll.effect !== 'deny') problems.push('it does not deny everything it was not given');

  for (const action of CHANGING_ACTIONS) {
    if (resolvePermission(rules, action, ORDINARY_FILE) !== 'deny') problems.push(`${action} is not denied`);
  }
  for (const rule of rules) {
    // An allow for an action nobody knows would open that action; only reading may be allowed by name.
    if (rule.effect === 'allow' && rule.action !== '*' && !READING_ACTIONS.includes(rule.action)) {
      problems.push(`it allows ${rule.action}`);
    }
  }

  if (resolvePermission(rules, 'read', '/repo/README.md') !== 'allow') problems.push('it cannot read the repository');
  for (const file of SECRET_FILES) {
    const effect = resolvePermission(rules, 'read', file);
    if (effect !== 'ask' && effect !== 'deny') problems.push(`reading ${basename(file)} is ${effect ?? 'not ruled'}`);
  }
  return [...new Set(problems)];
}

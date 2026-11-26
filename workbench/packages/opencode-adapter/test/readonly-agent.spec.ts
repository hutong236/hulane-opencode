import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  READONLY_AGENT_ID, managedConfigContent, readOnlyProblems, resolvePermission,
  type AgentPermission, type OpenCodeAgent,
} from '../src/index.ts';
import { BUILTIN_AGENTS, agentsOfConfigContent } from './mock-server.mjs';
import { REAL_READONLY_RULES, shown } from './rules.ts';

/** The built-in agents and those of some configuration content, as the server would compute their rules. */
function agentsOf(content: string): OpenCodeAgent[] {
  return [...BUILTIN_AGENTS, ...agentsOfConfigContent(content)].map(agent => ({
    ...agent,
    description: agent.description ?? '',
    permissions: agent.permissions.map(rule => ({ ...rule, effect: rule.effect as AgentPermission['effect'] })),
  }));
}
const readonlyOf = (content: string): OpenCodeAgent => {
  const agent = agentsOf(content).find(row => row.id === READONLY_AGENT_ID);
  assert.ok(agent, `no "${READONLY_AGENT_ID}" in ${content}`);
  return agent;
}
const agentWith = (permission: Record<string, unknown>, mode = 'primary'): OpenCodeAgent =>
  readonlyOf(JSON.stringify({ agent: { [READONLY_AGENT_ID]: { mode, permission } } }));

test('the configuration content carries the read-only agent and keeps what the environment already had', () => {
  const bare: unknown = JSON.parse(managedConfigContent(undefined));
  assert.deepEqual(bare, {
    agent: {
      [READONLY_AGENT_ID]: {
        mode: 'primary',
        description: 'Reads the repository and answers. Never changes a file and never runs a command.',
        permission: {
          '*': 'deny',
          read: { '*': 'allow', '*.env': 'ask', '*.env.*': 'ask' },
          glob: 'allow',
          list: 'allow',
        },
      },
    },
  });

  const existing = JSON.stringify({
    model: 'one/two', mcp: { servers: {} },
    agent: { mine: { mode: 'subagent' }, [READONLY_AGENT_ID]: { permission: { edit: 'allow' } } },
  });
  const merged = JSON.parse(managedConfigContent(existing));
  assert.deepEqual([merged.model, merged.mcp, merged.agent.mine], ['one/two', { servers: {} }, { mode: 'subagent' }]);
  // An agent of the same name is replaced, not extended: what the Workbench gives is what is checked.
  assert.deepEqual(merged.agent[READONLY_AGENT_ID].permission['*'], 'deny');
  // What is not an object would not have been taken by the server either.
  for (const broken of ['{', '[]', '"text"', 'null']) {
    assert.deepEqual(Object.keys(JSON.parse(managedConfigContent(broken))), ['agent'], broken);
  }
});

test('the rules are read as the server applies them: the last one that matches wins', () => {
  const rules = readonlyOf(managedConfigContent(undefined)).permissions;
  assert.equal(shown(rules), REAL_READONLY_RULES);
  assert.equal(resolvePermission(rules, 'read', '/repo/README.md'), 'allow');
  assert.equal(resolvePermission(rules, 'glob', '/repo'), 'allow');
  assert.equal(resolvePermission(rules, 'list', '/repo/src'), 'allow');
  // Files that keep secrets ask first, by their name wherever they are.
  for (const secret of ['.env', '/repo/.env', '/repo/config/.env.production', '/repo/.env.local']) {
    assert.equal(resolvePermission(rules, 'read', secret), 'ask', secret);
  }
  // Everything else is denied, including a tool nobody has heard of.
  for (const action of [
    'edit', 'write', 'patch', 'shell', 'bash', 'browser', 'webfetch', 'websearch', 'subagent', 'task', 'skill',
    'question', 'todowrite', 'grep', 'a-tool-nobody-has-heard-of',
  ]) {
    assert.equal(resolvePermission(rules, action, '/repo/src/app.ts'), 'deny', action);
  }
  assert.equal(resolvePermission(rules, 'read', '/repo/.git/config'), 'allow');

  const only = [{ action: 'read', resource: '*.env', effect: 'ask' as const }];
  assert.equal(resolvePermission(only, 'read', '/repo/.env'), 'ask');
  assert.equal(resolvePermission(only, 'read', '/repo/.env.d'), null);
  assert.equal(resolvePermission(only, 'edit', '/repo/.env'), null);
  // A path pattern is tried against the whole path and against its name.
  assert.equal(resolvePermission(
    [{ action: 'edit', resource: '/home/user/.opencode/plan/*', effect: 'allow' }], 'edit', '/home/user/.opencode/plan/x.md',
  ), 'allow');
  assert.equal(resolvePermission(
    [{ action: 'edit', resource: '/home/user/.opencode/plan/*', effect: 'allow' }], 'edit', '/repo/x.md',
  ), null);
});

test('an agent is read-only only when its rules say so, rule by rule', () => {
  assert.deepEqual(readOnlyProblems(readonlyOf(managedConfigContent(undefined))), []);

  const build = agentsOf('{}').find(agent => agent.id === 'build');
  assert.ok(build, 'no build agent in the mock');
  const buildProblems = readOnlyProblems(build);
  for (const expected of ['it does not deny everything it was not given', 'edit is not denied', 'shell is not denied', 'it allows question']) {
    assert.ok(buildProblems.includes(expected), `${expected} is missing from ${buildProblems.join('; ')}`);
  }

  // The built-in `plan` agent calls itself read-only. It denies `edit`, for one directory, and leaves `shell` allowed.
  const plan = agentsOf('{}').find(agent => agent.id === 'plan');
  assert.ok(plan, 'no plan agent in the mock');
  const planProblems = readOnlyProblems(plan);
  assert.ok(planProblems.includes('shell is not denied'), planProblems.join('; '));
  assert.ok(planProblems.includes('it allows edit'), planProblems.join('; '));

  // Under `agents` the server lists the agent without applying its rules.
  const unapplied = agentsOf(JSON.stringify({ agents: { [READONLY_AGENT_ID]: { permission: { '*': 'deny' } } } }))[0];
  assert.ok(readOnlyProblems(unapplied).includes('edit is not denied'), 'an agent under `agents` is not reported as allowing edit');

  // A flat `read: "allow"` comes after the server's "ask first" for `.env`, and so undoes it.
  const flat = agentWith({ '*': 'deny', read: 'allow', glob: 'allow', list: 'allow' });
  assert.ok(readOnlyProblems(flat).some(problem => problem.startsWith('reading .env is allow')), flat.permissions.map(rule => `${rule.action}:${rule.effect}`).join('; '));

  const cases: Array<[OpenCodeAgent, string]> = [
    [agentWith({ '*': 'deny', read: { '*': 'allow' }, glob: 'allow', list: 'allow' }, 'subagent'), 'it is a subagent agent, not one a session runs'],
    [{ ...readonlyOf(managedConfigContent(undefined)), permissions: [
      { action: 'read', resource: '*', effect: 'allow' }, { action: 'glob', resource: '*', effect: 'allow' },
    ] }, 'it does not deny everything it was not given'],
    [agentWith({ '*': 'deny', glob: 'allow', list: 'allow' }), 'it cannot read the repository'],
  ];
  for (const [agent, expected] of cases) {
    assert.ok(readOnlyProblems(agent).includes(expected), `${expected} is missing from ${readOnlyProblems(agent).join('; ')}`);
  }
  // An allow for an action nobody knows opens that action.
  const withMcp = readonlyOf(managedConfigContent(undefined));
  withMcp.permissions.push({ action: 'mcp', resource: '*', effect: 'allow' });
  assert.ok(readOnlyProblems(withMcp).includes('it allows mcp'), 'an allow for an action nobody knows is not reported');
  // The same problem is said once, however many ways it is found.
  assert.equal(new Set(readOnlyProblems(build)).size, readOnlyProblems(build).length);
});

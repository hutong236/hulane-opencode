#!/usr/bin/env node
/**
 * Stands in for `opencode serve`: the same command line, the same first line on standard output, the same password in
 * the environment, and it ends on SIGTERM. What it is told to do wrong comes from `FAKE_OPENCODE_*` variables, so that
 * a test can make it fail the way a real server can.
 *
 *   FAKE_OPENCODE_RECEIPT=<file>       writes { cwd, pid, argv, configContent } there before it starts
 *   FAKE_OPENCODE_EXIT=<code>          ends at once with this code, after printing an error
 *   FAKE_OPENCODE_READY_DELAY_MS=<n>   waits before it listens
 *   FAKE_OPENCODE_HANG=1               never says it listens
 *   FAKE_OPENCODE_VERSION=<version>    reports another version
 *   FAKE_OPENCODE_PID=<pid>            reports another pid
 *   FAKE_OPENCODE_IGNORE_SIGTERM=1     stays alive on SIGTERM
 *   FAKE_OPENCODE_PRINT_PASSWORD=1     prints the password, as the real one does when it makes its own
 *   FAKE_OPENCODE_PRINT_ADDRESS=<url>  says it listens there, wherever that is
 *   FAKE_OPENCODE_AGENT=none           has no read-only agent
 *   FAKE_OPENCODE_AGENT=unsafe         its read-only agent may edit and run commands
 *   FAKE_OPENCODE_AGENT=agents-key     it was configured under `agents`, so the agent's rules are not applied
 *   FAKE_OPENCODE_AGENT=slow           the first listing of a directory is empty
 *   FAKE_OPENCODE_AGENT=late          its read-only agent is there half a second after it listens
 *   SIGUSR1                            it stops answering and stays alive
 */
import { writeFileSync } from 'node:fs';
import { BUILTIN_AGENTS, startMockOpenCode } from './mock-server.mjs';

const args = process.argv.slice(2);
if (args[0] !== 'serve') {
  process.stderr.write('usage: fake-opencode serve --hostname <host> --port <port>\n');
  process.exit(1);
}
const value = (flag) => { const at = args.indexOf(flag); return at === -1 ? undefined : args[at + 1]; };
const hostname = value('--hostname') ?? '127.0.0.1';
const port = Number(value('--port') ?? '4096');
const env = process.env;

if (env.FAKE_OPENCODE_RECEIPT) {
  writeFileSync(env.FAKE_OPENCODE_RECEIPT, JSON.stringify({
    cwd: process.cwd(), pid: process.pid, argv: args, configContent: env.OPENCODE_CONFIG_CONTENT ?? null,
  }));
}
if (env.FAKE_OPENCODE_EXIT !== undefined) {
  process.stderr.write(`ServeError: Failed to start server. Is port ${port} in use?\n`);
  process.exit(Number(env.FAKE_OPENCODE_EXIT));
}
if (env.FAKE_OPENCODE_IGNORE_SIGTERM) process.on('SIGTERM', () => undefined);
if (env.FAKE_OPENCODE_READY_DELAY_MS) await new Promise((resolve) => setTimeout(resolve, Number(env.FAKE_OPENCODE_READY_DELAY_MS)));
if (env.FAKE_OPENCODE_PRINT_PASSWORD) process.stdout.write(`server password ${env.OPENCODE_PASSWORD}\n`);
if (env.FAKE_OPENCODE_HANG) await new Promise(() => setInterval(() => undefined, 1_000));

let content = env.OPENCODE_CONFIG_CONTENT ?? null;
if (env.FAKE_OPENCODE_AGENT === 'agents-key' && content !== null) {
  const parsed = JSON.parse(content);
  content = JSON.stringify({ ...parsed, agents: parsed.agent, agent: undefined });
}
const server = await startMockOpenCode({ password: env.OPENCODE_PASSWORD, configContent: content });
// It does not outlive the process that started it, whatever a test forgot.
const parent = process.ppid;
setInterval(() => { if (process.ppid !== parent) process.exit(0); }, 500);
const late = server.agents.get('workbench-readonly');
server.version = env.FAKE_OPENCODE_VERSION ?? server.version;
if (env.FAKE_OPENCODE_PID) server.reportedPid = Number(env.FAKE_OPENCODE_PID);
if (env.FAKE_OPENCODE_AGENT === 'none') server.agents.delete('workbench-readonly');
if (env.FAKE_OPENCODE_AGENT === 'unsafe') {
  server.agents.set('workbench-readonly', { ...BUILTIN_AGENTS[0], id: 'workbench-readonly', name: 'workbench-readonly' });
}
if (env.FAKE_OPENCODE_AGENT === 'slow') server.agentFirstListEmpty = true;
// On SIGUSR1 it stops answering but stays alive, as a process that gave up its port would.
process.on('SIGUSR1', () => { void server.close(); });
if (env.FAKE_OPENCODE_AGENT === 'late') {
  server.agents.delete('workbench-readonly');
  setTimeout(() => server.agents.set('workbench-readonly', late), 500).unref();
}
const address = env.FAKE_OPENCODE_PRINT_ADDRESS ?? `http://${hostname}:${server.origin.slice('http://127.0.0.1:'.length)}`;
process.stdout.write(`server listening on ${address}\n`);

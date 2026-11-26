import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { basename, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { WorkbenchDatabase } from '@hulane/workbench-database';
import { buildApp } from '../src/app.js';
import { buildCmdbApp } from '../../../examples/cmdb/src/app.js';
import { buildAutomationApp } from '../../../examples/automation/src/app.js';
import { buildMonitoringApp } from '../../../examples/monitoring/src/app.js';
import { fixturePrefix } from './fixture-prefix.js';

const EXAMPLES_ROOT = fileURLToPath(new URL('../../../examples/', import.meta.url));
const EXAMPLE_NAMES = ['cmdb', 'automation', 'monitoring'];

interface Req001Contract {
  id: string;
  status: string;
  exampleVersion: number;
  environments: string[];
  targetContracts: Record<string, { field: string; rule: string }>;
  knownGap: { summary: string; services: string[] };
  acceptance: Array<{ id: string; service: string; given: string; when: string; then: string }>;
}

function headOf(repo: string): string {
  return execFileSync('git', ['--no-optional-locks', '-C', repo, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
}

test('CMDB example serves deterministic seed data and refuses unknown filters and assets', async () => {
  const app = buildCmdbApp();
  try {
    assert.deepEqual((await app.inject({ method: 'GET', url: '/health' })).json(),
      { status: 'ok', service: 'example-cmdb', contract: 'REQ-001' });
    assert.deepEqual((await app.inject({ method: 'GET', url: '/api/assets' })).json().assets.map(
      (asset: { id: string }) => asset.id), ['asset-001', 'asset-002', 'asset-003']);
    assert.deepEqual((await app.inject({ method: 'GET', url: '/api/assets?kind=database' })).json().assets.map(
      (asset: { id: string }) => asset.id), ['asset-002']);
    const kind = await app.inject({ method: 'GET', url: '/api/assets?kind=prod' });
    assert.deepEqual({ status: kind.statusCode, body: kind.json() },
      { status: 400, body: { error: 'Unknown asset kind' } });
    assert.equal((await app.inject({ method: 'GET', url: '/api/assets/asset-001' })).json().name, 'payments-api');
    assert.equal((await app.inject({ method: 'GET', url: '/api/assets/asset-999' })).statusCode, 404);
    assert.equal((await app.inject({ method: 'GET', url: '/api/assets/nope' })).statusCode, 400);
  } finally {
    await app.close();
  }
});

test('Automation example runs deterministically in isolation and resets its fixture', async () => {
  const first = buildAutomationApp();
  const second = buildAutomationApp();
  try {
    const run = await first.inject({ method: 'POST', url: '/api/runs', payload: { jobId: 'job-001' } });
    assert.deepEqual({ status: run.statusCode, body: run.json() }, {
      status: 201,
      body: { runId: 'run-0001', jobId: 'job-001', status: 'succeeded', output: 'simulated deploy-web' },
    });
    assert.equal((await first.inject({ method: 'GET', url: '/api/runs' })).json().runs.length, 1);
    assert.deepEqual((await second.inject({ method: 'GET', url: '/api/runs' })).json(), { runs: [] });
    assert.equal((await first.inject({ method: 'POST', url: '/api/runs', payload: {} })).statusCode, 400);
    assert.equal((await first.inject({ method: 'POST', url: '/api/runs', payload: { jobId: 'job-999' } })).statusCode, 404);
    assert.deepEqual((await first.inject({ method: 'POST', url: '/api/fixtures/reset' })).json(),
      { reset: true, service: 'example-automation' });
    assert.deepEqual((await first.inject({ method: 'GET', url: '/api/runs' })).json(), { runs: [] });
    const afterReset = await first.inject({ method: 'POST', url: '/api/runs', payload: { jobId: 'job-002' } });
    assert.equal(afterReset.json().runId, 'run-0001');
  } finally {
    await first.close();
    await second.close();
  }
});

test('Monitoring example filters fixed events and refuses unknown filters and ids', async () => {
  const app = buildMonitoringApp();
  try {
    assert.deepEqual((await app.inject({ method: 'GET', url: '/api/events' })).json().events.map(
      (event: { id: string }) => event.id), ['evt-001', 'evt-002', 'evt-003', 'evt-004']);
    assert.deepEqual((await app.inject({ method: 'GET', url: '/api/events?level=critical' })).json().events.map(
      (event: { id: string }) => event.id), ['evt-003']);
    assert.deepEqual((await app.inject({ method: 'GET', url: '/api/events?source=automation' })).json().events.map(
      (event: { id: string }) => event.id), ['evt-002', 'evt-003']);
    const level = await app.inject({ method: 'GET', url: '/api/events?level=debug' });
    assert.deepEqual({ status: level.statusCode, body: level.json() },
      { status: 400, body: { error: 'Unknown event level' } });
    assert.equal((await app.inject({ method: 'GET', url: '/api/events?source=prod' })).statusCode, 400);
    assert.deepEqual((await app.inject({ method: 'GET', url: '/api/events?source=cmdb&level=critical' })).json(),
      { events: [] });
    assert.equal((await app.inject({ method: 'GET', url: '/api/events/evt-003' })).json().level, 'critical');
    assert.equal((await app.inject({ method: 'GET', url: '/api/events/evt-999' })).statusCode, 404);
    assert.equal((await app.inject({ method: 'GET', url: '/api/events/evt-1' })).statusCode, 400);
    assert.deepEqual((await app.inject({ method: 'GET', url: '/api/alerts' })).json().alerts.map(
      (alert: { id: string }) => alert.id), ['alert-002', 'alert-003']);
  } finally {
    await app.close();
  }
});

test('REQ-001 names three environments and every v1 example schema leaves the environment loop open', async () => {
  const contract = JSON.parse(
    readFileSync(join(EXAMPLES_ROOT, 'contracts', 'req-001.json'), 'utf8')) as Req001Contract;
  assert.equal(contract.id, 'REQ-001');
  assert.equal(contract.status, 'open');
  assert.equal(contract.exampleVersion, 1);
  assert.deepEqual(contract.environments, ['dev', 'test', 'prod']);
  assert.deepEqual(Object.keys(contract.targetContracts).sort(), ['automation', 'cmdb', 'monitoring']);
  assert.deepEqual(contract.knownGap.services, ['cmdb', 'automation', 'monitoring']);
  assert.ok(contract.acceptance.length >= 4);
  for (const acceptance of contract.acceptance) {
    assert.equal(typeof acceptance.id, 'string');
    assert.equal(typeof acceptance.then, 'string');
  }

  const apps = [
    { service: 'example-cmdb', app: buildCmdbApp() },
    { service: 'example-automation', app: buildAutomationApp() },
    { service: 'example-monitoring', app: buildMonitoringApp() },
  ];
  try {
    for (const { service, app } of apps) {
      const response = await app.inject({ method: 'GET', url: '/api/schema' });
      assert.equal(response.statusCode, 200);
      const body = response.json();
      assert.equal(body.service, service);
      assert.equal(body.version, 1);
      // The gap is intentional and pinned: whoever implements REQ-001 must also update the contract.
      assert.equal(JSON.stringify(body).includes('"environment"'), false);
    }
  } finally {
    await Promise.all(apps.map(({ app }) => app.close()));
  }
});

test('the three example repositories initialize repeatably and register in the project catalog', async () => {
  const temp = mkdtempSync(fixturePrefix('wb-examples-'));
  const examplesCopy = join(temp, 'examples');
  const dataDirectory = join(temp, 'data');
  mkdirSync(examplesCopy, { recursive: true });
  for (const name of EXAMPLE_NAMES) {
    cpSync(join(EXAMPLES_ROOT, name), join(examplesCopy, name), {
      recursive: true,
      filter: source => !['.git', 'node_modules', 'dist'].includes(basename(source)),
    });
  }

  const script = join(EXAMPLES_ROOT, 'scripts', 'init-example-repos.mjs');
  let db: WorkbenchDatabase | undefined;
  let app: ReturnType<typeof buildApp> | undefined;
  try {
    const firstRun = execFileSync(process.execPath, [script, '--root', examplesCopy], { encoding: 'utf8' });
    for (const name of EXAMPLE_NAMES) assert.match(firstRun, new RegExp(`${name}: initialized`));
    const heads = new Map(EXAMPLE_NAMES.map(name => [name, headOf(join(examplesCopy, name))] as const));

    const secondRun = execFileSync(process.execPath, [script, '--root', examplesCopy], { encoding: 'utf8' });
    for (const name of EXAMPLE_NAMES) {
      assert.match(secondRun, new RegExp(`${name}: already initialized`));
      assert.equal(headOf(join(examplesCopy, name)), heads.get(name));
    }

    assert.throws(() => execFileSync(process.execPath, [script],
      { encoding: 'utf8', stdio: 'pipe' }));
    assert.throws(() => execFileSync(process.execPath, [script, '--root', join(temp, 'missing')],
      { encoding: 'utf8', stdio: 'pipe' }));

    const database = new WorkbenchDatabase({ dataDirectory });
    db = database;
    const api = buildApp({ database });
    app = api;
    for (const name of EXAMPLE_NAMES) {
      const response = await api.inject({ method: 'POST', url: '/api/projects', payload: {
        path: join(examplesCopy, name), slug: name, name: `Example ${name}`,
      } });
      assert.equal(response.statusCode, 201);
      assert.equal(response.json().default_branch, 'main');
      assert.equal(response.json().remote_url, null);
    }
    const list = await api.inject({ method: 'GET', url: '/api/projects' });
    assert.deepEqual(list.json().projects.map((project: { slug: string }) => project.slug).sort(),
      ['automation', 'cmdb', 'monitoring']);
    const duplicate = await api.inject({ method: 'POST', url: '/api/projects', payload: {
      path: join(examplesCopy, 'cmdb'), slug: 'cmdb-again', name: 'Again',
    } });
    assert.equal(duplicate.statusCode, 409);
    for (const name of EXAMPLE_NAMES) {
      assert.equal(execFileSync('git', ['--no-optional-locks', '-C', join(examplesCopy, name),
        'status', '--porcelain'], { encoding: 'utf8' }), '');
    }
  } finally {
    await app?.close();
    db?.close();
    rmSync(temp, { recursive: true, force: true });
  }
});

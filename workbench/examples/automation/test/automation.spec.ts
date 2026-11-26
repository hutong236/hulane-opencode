import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildAutomationApp } from '../src/app.js';
import { seedJobs } from '../src/seed.js';

test('seeded jobs are deterministic and every reader gets its own copy', () => {
  const first = seedJobs();
  const second = seedJobs();
  assert.deepEqual(first, second);
  assert.notEqual(first, second);
  first[0].name = 'mutated';
  assert.equal(seedJobs()[0].name, 'deploy-web');
});

test('a run is simulated deterministically and a second fixture stays empty', async () => {
  const first = buildAutomationApp();
  const second = buildAutomationApp();
  try {
    assert.deepEqual((await first.inject({ method: 'GET', url: '/health' })).json(),
      { status: 'ok', service: 'example-automation', contract: 'REQ-001' });
    const run = await first.inject({ method: 'POST', url: '/api/runs', payload: { jobId: 'job-001' } });
    assert.deepEqual({ status: run.statusCode, body: run.json() }, {
      status: 201,
      body: { runId: 'run-0001', jobId: 'job-001', status: 'succeeded', output: 'simulated deploy-web' },
    });
    assert.equal((await first.inject({ method: 'GET', url: '/api/runs' })).json().runs.length, 1);
    assert.deepEqual((await second.inject({ method: 'GET', url: '/api/runs' })).json(), { runs: [] });
  } finally {
    await first.close();
    await second.close();
  }
});

test('an invalid request, an unknown job and a reset keep the fixture predictable', async () => {
  const app = buildAutomationApp();
  try {
    assert.equal((await app.inject({ method: 'POST', url: '/api/runs', payload: {} })).statusCode, 400);
    assert.equal((await app.inject({ method: 'POST', url: '/api/runs', payload: { jobId: '   ' } })).statusCode, 400);
    assert.equal((await app.inject({ method: 'POST', url: '/api/runs', payload: { jobId: 'job-999' } })).statusCode, 404);
    await app.inject({ method: 'POST', url: '/api/runs', payload: { jobId: 'job-002' } });
    const reset = await app.inject({ method: 'POST', url: '/api/fixtures/reset' });
    assert.deepEqual(reset.json(), { reset: true, service: 'example-automation' });
    assert.deepEqual((await app.inject({ method: 'GET', url: '/api/runs' })).json(), { runs: [] });
    const next = await app.inject({ method: 'POST', url: '/api/runs', payload: { jobId: 'job-002' } });
    assert.equal(next.json().runId, 'run-0001');
  } finally {
    await app.close();
  }
});

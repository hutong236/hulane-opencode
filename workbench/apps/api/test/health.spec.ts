import assert from 'node:assert/strict';
import test from 'node:test';
import { buildApp } from '../src/app.ts';

test('GET /api/health returns a real healthy status', async () => {
  const app = buildApp();
  try {
    const response = await app.inject({ method: 'GET', url: '/api/health' });
    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.json(), { status: 'ok', service: 'hulane-workbench-api' });
  } finally {
    await app.close();
  }
});

test('unknown API routes do not report healthy status', async () => {
  const app = buildApp();
  try {
    const response = await app.inject({ method: 'GET', url: '/api/does-not-exist' });
    assert.equal(response.statusCode, 404);
    assert.notEqual(response.json().status, 'ok');
  } finally {
    await app.close();
  }
});

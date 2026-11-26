import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildCmdbApp } from '../src/app.js';
import { seedAssets } from '../src/seed.js';

test('seeded assets are deterministic and every reader gets its own copy', () => {
  const first = seedAssets();
  const second = seedAssets();
  assert.deepEqual(first, second);
  assert.notEqual(first, second);
  first[0].name = 'mutated';
  assert.equal(seedAssets()[0].name, 'payments-api');
});

test('health, schema, list and detail answer from the fixed fixture', async () => {
  const app = buildCmdbApp();
  try {
    assert.deepEqual((await app.inject({ method: 'GET', url: '/health' })).json(),
      { status: 'ok', service: 'example-cmdb', contract: 'REQ-001' });
    const schema = await app.inject({ method: 'GET', url: '/api/schema' });
    assert.equal(schema.statusCode, 200);
    assert.equal(schema.json().asset.properties.kind.enum.length, 3);
    assert.deepEqual((await app.inject({ method: 'GET', url: '/api/assets' })).json().assets.map(
      (asset: { id: string }) => asset.id), ['asset-001', 'asset-002', 'asset-003']);
    assert.deepEqual((await app.inject({ method: 'GET', url: '/api/assets?kind=database' })).json().assets.map(
      (asset: { id: string }) => asset.id), ['asset-002']);
    assert.equal((await app.inject({ method: 'GET', url: '/api/assets/asset-001' })).json().name, 'payments-api');
  } finally {
    await app.close();
  }
});

test('an unknown kind, a malformed id and a missing asset are refused', async () => {
  const app = buildCmdbApp();
  try {
    const kind = await app.inject({ method: 'GET', url: '/api/assets?kind=prod' });
    assert.deepEqual({ status: kind.statusCode, body: kind.json() },
      { status: 400, body: { error: 'Unknown asset kind' } });
    assert.equal((await app.inject({ method: 'GET', url: '/api/assets/nope' })).statusCode, 400);
    assert.equal((await app.inject({ method: 'GET', url: '/api/assets/asset-999' })).statusCode, 404);
    const reset = await app.inject({ method: 'POST', url: '/api/fixtures/reset' });
    assert.deepEqual(reset.json(), { reset: true, service: 'example-cmdb' });
  } finally {
    await app.close();
  }
});

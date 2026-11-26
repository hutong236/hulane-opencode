import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildMonitoringApp } from '../src/app.js';
import { seedAlerts, seedEvents } from '../src/seed.js';

test('seeded events and alerts are deterministic and every reader gets its own copy', () => {
  const first = seedEvents();
  const second = seedEvents();
  assert.deepEqual(first, second);
  assert.notEqual(first, second);
  first[0].message = 'mutated';
  assert.equal(seedEvents()[0].message, 'asset inventory refreshed');
  assert.deepEqual(seedAlerts().map(alert => alert.id), ['alert-002', 'alert-003']);
});

test('health, schema and filters answer from the fixed fixture', async () => {
  const app = buildMonitoringApp();
  try {
    assert.deepEqual((await app.inject({ method: 'GET', url: '/health' })).json(),
      { status: 'ok', service: 'example-monitoring', contract: 'REQ-001' });
    const all = await app.inject({ method: 'GET', url: '/api/events' });
    assert.deepEqual(all.json().events.map((event: { id: string }) => event.id),
      ['evt-001', 'evt-002', 'evt-003', 'evt-004']);
    const critical = await app.inject({ method: 'GET', url: '/api/events?level=critical' });
    assert.deepEqual(critical.json().events.map((event: { id: string }) => event.id), ['evt-003']);
    const automation = await app.inject({ method: 'GET', url: '/api/events?source=automation' });
    assert.deepEqual(automation.json().events.map((event: { id: string }) => event.id), ['evt-002', 'evt-003']);
    assert.deepEqual((await app.inject({ method: 'GET', url: '/api/alerts' })).json().alerts.map(
      (alert: { id: string }) => alert.id), ['alert-002', 'alert-003']);
  } finally {
    await app.close();
  }
});

test('unknown filters, malformed ids and missing events are refused', async () => {
  const app = buildMonitoringApp();
  try {
    const level = await app.inject({ method: 'GET', url: '/api/events?level=debug' });
    assert.deepEqual({ status: level.statusCode, body: level.json() },
      { status: 400, body: { error: 'Unknown event level' } });
    assert.equal((await app.inject({ method: 'GET', url: '/api/events?source=prod' })).statusCode, 400);
    assert.equal((await app.inject({ method: 'GET', url: '/api/events/evt-1' })).statusCode, 400);
    assert.equal((await app.inject({ method: 'GET', url: '/api/events/evt-999' })).statusCode, 404);
    assert.deepEqual((await app.inject({ method: 'GET', url: '/api/events?source=cmdb&level=critical' })).json(),
      { events: [] });
  } finally {
    await app.close();
  }
});

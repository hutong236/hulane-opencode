import Fastify, { type FastifyInstance } from 'fastify';
import { ALERT_SCHEMA, EVENT_SCHEMA } from './schema.js';
import {
  EVENT_LEVELS, EVENT_SOURCES, seedAlerts, seedEvents,
  type EventLevel, type EventSource, type MonitorAlert, type MonitorEvent,
} from './seed.js';

const SERVICE = 'example-monitoring';

function isEventLevel(value: string): value is EventLevel {
  return (EVENT_LEVELS as readonly string[]).includes(value);
}

function isEventSource(value: string): value is EventSource {
  return (EVENT_SOURCES as readonly string[]).includes(value);
}

/** In-process sandbox API over fixed fake events; no network, no credentials, no production references. */
export function buildMonitoringApp(): FastifyInstance {
  const app = Fastify({ logger: false });
  let events: MonitorEvent[] = seedEvents();
  let alerts: MonitorAlert[] = seedAlerts();

  app.get('/health', async () => ({ status: 'ok', service: SERVICE, contract: 'REQ-001' }));

  app.get('/api/schema', async () => ({
    service: SERVICE,
    version: 1,
    event: EVENT_SCHEMA,
    alert: ALERT_SCHEMA,
  }));

  app.get<{ Querystring: { level?: unknown; source?: unknown } }>('/api/events', async (request, reply) => {
    const level = request.query.level;
    const source = request.query.source;
    if (level !== undefined && (typeof level !== 'string' || !isEventLevel(level))) {
      return reply.code(400).send({ error: 'Unknown event level' });
    }
    if (source !== undefined && (typeof source !== 'string' || !isEventSource(source))) {
      return reply.code(400).send({ error: 'Unknown event source' });
    }
    const filtered = events.filter(event =>
      (level === undefined || event.level === level) && (source === undefined || event.source === source));
    return { events: filtered };
  });

  app.get<{ Params: { id: string } }>('/api/events/:id', async (request, reply) => {
    const id = request.params.id;
    if (!/^evt-[0-9]{3}$/.test(id)) return reply.code(400).send({ error: 'Invalid event ID' });
    const event = events.find(candidate => candidate.id === id);
    if (!event) return reply.code(404).send({ error: 'Event not found' });
    return event;
  });

  app.get('/api/alerts', async () => ({ alerts }));

  // Fixture rebuild: fresh copies of the fixed seed, still isolated to this process.
  app.post('/api/fixtures/reset', async () => {
    events = seedEvents();
    alerts = seedAlerts();
    return { reset: true, service: SERVICE };
  });

  return app;
}

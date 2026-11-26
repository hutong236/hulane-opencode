import { EVENT_LEVELS, EVENT_SOURCES } from './seed.js';

/** API contract of the v1 sandbox event and alert. `environment` is deliberately absent: REQ-001 records that gap. */
export const EVENT_SCHEMA = {
  $id: 'https://example.invalid/monitoring/event.v1.json',
  type: 'object',
  additionalProperties: false,
  required: ['id', 'source', 'level', 'message', 'at'],
  properties: {
    id: { type: 'string', pattern: '^evt-[0-9]{3}$' },
    source: { type: 'string', enum: [...EVENT_SOURCES] },
    level: { type: 'string', enum: [...EVENT_LEVELS] },
    message: { type: 'string', minLength: 1, maxLength: 160 },
    at: { type: 'string', format: 'date-time' },
  },
} as const;

export const ALERT_SCHEMA = {
  $id: 'https://example.invalid/monitoring/alert.v1.json',
  type: 'object',
  additionalProperties: false,
  required: ['id', 'eventId', 'level', 'status'],
  properties: {
    id: { type: 'string', pattern: '^alert-[0-9]{3}$' },
    eventId: { type: 'string', pattern: '^evt-[0-9]{3}$' },
    level: { type: 'string', enum: ['warning', 'critical'] },
    status: { type: 'string', enum: ['open'] },
  },
} as const;

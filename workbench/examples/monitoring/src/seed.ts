export const EVENT_SOURCES = ['cmdb', 'automation', 'monitoring'] as const;
export type EventSource = (typeof EVENT_SOURCES)[number];

export const EVENT_LEVELS = ['info', 'warning', 'critical'] as const;
export type EventLevel = (typeof EVENT_LEVELS)[number];

export interface MonitorEvent {
  id: string;
  source: EventSource;
  level: EventLevel;
  message: string;
  at: string;
}

export interface MonitorAlert {
  id: string;
  eventId: string;
  level: EventLevel;
  status: 'open';
}

/**
 * Fixed fake events with fixed timestamps. REQ-001 deliberately adds no `environment` field yet; the target is
 * recorded in `workbench/examples/contracts/req-001.json`.
 */
const SEED_EVENTS: readonly MonitorEvent[] = [
  { id: 'evt-001', source: 'cmdb', level: 'info', message: 'asset inventory refreshed', at: '2026-01-01T00:00:00.000Z' },
  { id: 'evt-002', source: 'automation', level: 'warning', message: 'deploy-web simulated slow step', at: '2026-01-01T00:01:00.000Z' },
  { id: 'evt-003', source: 'automation', level: 'critical', message: 'rotate-logs simulated failure', at: '2026-01-01T00:02:00.000Z' },
  { id: 'evt-004', source: 'monitoring', level: 'info', message: 'monitor heartbeat', at: '2026-01-01T00:03:00.000Z' },
];

const SEED_ALERTS: readonly MonitorAlert[] = [
  { id: 'alert-002', eventId: 'evt-002', level: 'warning', status: 'open' },
  { id: 'alert-003', eventId: 'evt-003', level: 'critical', status: 'open' },
];

/** Fresh copies per application instance, so two fixtures can never share mutable rows. */
export function seedEvents(): MonitorEvent[] {
  return SEED_EVENTS.map(event => ({ ...event }));
}

export function seedAlerts(): MonitorAlert[] {
  return SEED_ALERTS.map(alert => ({ ...alert }));
}

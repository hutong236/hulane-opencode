import Fastify from 'fastify';

/** Build an application without opening a socket, so tests can use inject(). */
export function buildApp() {
  const app = Fastify({ logger: true });
  app.get('/api/health', async () => ({ status: 'ok', service: 'hulane-workbench-api' }));
  return app;
}

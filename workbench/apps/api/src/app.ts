import Fastify from 'fastify';
import { validateRepositoryRoot } from './repository-root.js';

/** Build an application without opening a socket, so tests can use inject(). */
export function buildApp() {
  const app = Fastify({ logger: true });
  app.get('/api/health', async () => ({ status: 'ok', service: 'hulane-workbench-api' }));
  app.post<{ Body: { path?: string } }>('/api/projects/validate', async (request, reply) => {
    if (typeof request.body?.path !== 'string') {
      return reply.code(400).send({ error: 'Repository path must be a string' });
    }
    try {
      const repoRoot = await validateRepositoryRoot(request.body.path);
      return { repoRoot };
    } catch {
      return reply.code(400).send({ error: 'Invalid Git repository root' });
    }
  });
  return app;
}

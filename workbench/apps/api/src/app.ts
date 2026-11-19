import Fastify from 'fastify';
import { validateRepositoryRoot } from './repository-root.js';
import { readRepositoryStatus } from './repository-status.js';

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
  // Status is read-only and always revalidates the supplied canonical Git root.
  app.post<{ Body: { path?: string } }>('/api/projects/status', async (request, reply) => {
    if (typeof request.body?.path !== 'string') {
      return reply.code(400).send({ error: 'Repository path must be a string' });
    }
    try {
      return await readRepositoryStatus(request.body.path);
    } catch {
      // Never expose Git stderr or local filesystem paths in an HTTP response.
      return reply.code(400).send({ error: 'Invalid Git repository root or unreadable status' });
    }
  });
  return app;
}

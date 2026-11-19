import Fastify from 'fastify';
import { WorkbenchDatabase } from '@hulane/workbench-database';
import { validateRepositoryRoot } from './repository-root.js';
import { readRepositoryStatus } from './repository-status.js';

/** Build an application without opening a socket, so tests can use inject(). */
export function buildApp(options: { database?: WorkbenchDatabase } = {}) {
  const app = Fastify({ logger: true });
  let ownedDatabase: WorkbenchDatabase | undefined;
  const database = () => options.database ?? (ownedDatabase ??= new WorkbenchDatabase());
  app.addHook('onClose', async () => { ownedDatabase?.close(); });
  app.post<{ Body: { path?: string; slug?: string; name?: string } }>('/api/projects', async (request, reply) => {
    const body = request.body;
    if (typeof body?.path !== 'string' || typeof body.slug !== 'string' ||
        !/^[a-z0-9][a-z0-9-]{1,63}$/.test(body.slug) ||
        typeof body.name !== 'string' || !body.name.trim()) {
      return reply.code(400).send({ error: 'Invalid project registration' });
    }
    let repoRoot: string;
    try { repoRoot = await validateRepositoryRoot(body.path); }
    catch { return reply.code(400).send({ error: 'Invalid Git repository root' }); }
    try {
      const projects = database().projects;
      if (projects.findByRoot(repoRoot)) return reply.code(409).send({ error: 'Repository already registered' });
      return reply.code(201).send(projects.create({ slug: body.slug, name: body.name, repoRoot }));
    } catch (error) {
      if (error instanceof Error && error.message.includes('UNIQUE constraint failed')) {
        return reply.code(409).send({ error: 'Project already registered' });
      }
      throw error;
    }
  });
  // Return only persisted registration metadata; never touch or delete the repository.
  app.get<{ Params: { id: string } }>('/api/projects/:id', async (request, reply) => {
    const id = request.params.id;
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
      return reply.code(400).send({ error: 'Invalid project ID' });
    }
    const project = database().projects.find(id);
    if (!project) return reply.code(404).send({ error: 'Project not found' });
    return project;
  });
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

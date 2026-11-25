import Fastify from 'fastify';
import { WorkbenchDatabase } from '@hulane/workbench-database';
import { readRepositoryMetadata } from './repository-metadata.js';
import { RepositoryRootError, validateRepositoryRoot } from './repository-root.js';
import { readRepositoryStatus } from './repository-status.js';

/** The reason names a kind of problem and is safe to show. The path itself is never echoed. */
const reasonOf = (error: unknown) => error instanceof RepositoryRootError ? error.reason : 'not_git_root';

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
    catch (error) { return reply.code(400).send({ error: 'Invalid Git repository root', reason: reasonOf(error) }); }
    try {
      const projects = database().projects;
      if (projects.findByRoot(repoRoot)) return reply.code(409).send({ error: 'Repository already registered' });
      // Read from Git once, at registration: where new work starts and which origin the repository tracks.
      const metadata = await readRepositoryMetadata(repoRoot).catch(() => null);
      if (!metadata) return reply.code(400).send({ error: 'Repository metadata is unreadable' });
      return reply.code(201).send(projects.create({
        slug: body.slug, name: body.name, repoRoot,
        defaultBranch: metadata.defaultBranch, remoteUrl: metadata.remoteUrl,
      }));
    } catch (error) {
      if (error instanceof Error && error.message.includes('UNIQUE constraint failed')) {
        return reply.code(409).send({ error: 'Project already registered' });
      }
      throw error;
    }
  });
  // Read persisted metadata only: listing must not execute Git or inspect user files.
  app.get('/api/projects', async () => ({ projects: database().projects.list() }));
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
  // Rename the catalog entry only. The revision must be the one the caller saw, so two editors cannot overwrite each other.
  app.patch<{ Params: { id: string }; Body: { name?: unknown; revision?: unknown } }>('/api/projects/:id', async (request, reply) => {
    const id = request.params.id;
    const body = request.body;
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
      return reply.code(400).send({ error: 'Invalid project ID' });
    }
    if (!body || typeof body.name !== 'string' || !body.name.trim() || body.name.trim().length > 120 ||
        !Number.isSafeInteger(body.revision) || (body.revision as number) < 0) {
      return reply.code(400).send({ error: 'Invalid project update' });
    }
    const projects = database().projects;
    if (!projects.find(id)) return reply.code(404).send({ error: 'Project not found' });
    // A stale revision means the project was renamed since the caller loaded it: never overwrite that change.
    if (!projects.updateName(id, body.revision as number, body.name)) {
      return reply.code(409).send({ error: 'Project changed since it was loaded' });
    }
    return projects.find(id);
  });
  // Resolve status only from a persisted project ID; clients cannot substitute an arbitrary path.
  app.get<{ Params: { id: string } }>('/api/projects/:id/status', async (request, reply) => {
    const id = request.params.id;
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
      return reply.code(400).send({ error: 'Invalid project ID' });
    }
    const project = database().projects.find(id);
    if (!project) return reply.code(404).send({ error: 'Project not found' });
    try {
      return await readRepositoryStatus(project.repo_root);
    } catch {
      // The repository may have been moved or deleted since registration.
      return reply.code(409).send({ error: 'Registered Git repository is unavailable' });
    }
  });
  // Unregister only the SQLite record; never remove or modify the local Git repository.
  app.delete<{ Params: { id: string } }>('/api/projects/:id', async (request, reply) => {
    const id = request.params.id;
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
      return reply.code(400).send({ error: 'Invalid project ID' });
    }
    if (!database().projects.delete(id)) return reply.code(404).send({ error: 'Project not found' });
    return reply.code(204).send();
  });
  app.get('/api/health', async () => ({ status: 'ok', service: 'hulane-workbench-api' }));
  app.post<{ Body: { path?: string } }>('/api/projects/validate', async (request, reply) => {
    if (typeof request.body?.path !== 'string') {
      return reply.code(400).send({ error: 'Repository path must be a string' });
    }
    try {
      const repoRoot = await validateRepositoryRoot(request.body.path);
      return { repoRoot };
    } catch (error) {
      return reply.code(400).send({ error: 'Invalid Git repository root', reason: reasonOf(error) });
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

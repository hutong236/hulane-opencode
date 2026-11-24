import type { FastifyInstance, FastifyReply } from 'fastify';
import {
  RequirementConflictError, RequirementNotFoundError, RequirementValidationError,
  type WorkbenchDatabase,
} from '@hulane/workbench-database';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const VERSION = /^[1-9][0-9]{0,8}$/;

function bodyOf(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

/** Map repository failures to stable status codes without forwarding SQLite messages or local data. */
function failure(reply: FastifyReply, error: unknown) {
  if (error instanceof RequirementValidationError) {
    return reply.code(400).send({ error: 'Invalid requirement input' });
  }
  if (error instanceof RequirementConflictError) {
    return reply.code(409).send({ error: 'Requirement changed or transition is not allowed; reload and retry' });
  }
  if (error instanceof RequirementNotFoundError) {
    return reply.code(404).send({ error: 'Requirement not found' });
  }
  throw error;
}

function invalidId(reply: FastifyReply) {
  return reply.code(400).send({ error: 'Invalid requirement ID' });
}

export function registerRequirementRoutes(app: FastifyInstance, database: () => WorkbenchDatabase): void {
  app.get('/api/requirements', async () => ({ requirements: database().requirements.list() }));

  app.post<{ Body: unknown }>('/api/requirements', async (request, reply) => {
    const body = bodyOf(request.body);
    try {
      const requirement = database().requirements.create({
        requirementKey: body.requirementKey as string,
        content: body,
        actor: body.actor as string,
        summary: body.summary as string,
      });
      return reply.code(201).send(requirement);
    } catch (error) {
      return failure(reply, error);
    }
  });

  app.get<{ Params: { id: string } }>('/api/requirements/:id', async (request, reply) => {
    if (!UUID.test(request.params.id)) return invalidId(reply);
    const requirement = database().requirements.find(request.params.id);
    if (!requirement) return reply.code(404).send({ error: 'Requirement not found' });
    return requirement;
  });

  app.put<{ Params: { id: string }; Body: unknown }>('/api/requirements/:id', async (request, reply) => {
    if (!UUID.test(request.params.id)) return invalidId(reply);
    const body = bodyOf(request.body);
    try {
      return database().requirements.update(
        request.params.id, body.expectedRevision as number, body, body.actor as string, body.summary as string,
      );
    } catch (error) {
      return failure(reply, error);
    }
  });

  app.post<{ Params: { id: string }; Body: unknown }>('/api/requirements/:id/transitions', async (request, reply) => {
    if (!UUID.test(request.params.id)) return invalidId(reply);
    const body = bodyOf(request.body);
    try {
      return database().requirements.transition(
        request.params.id, body.expectedRevision as number, body.status as string,
        body.actor as string, body.summary as string,
      );
    } catch (error) {
      return failure(reply, error);
    }
  });

  app.post<{ Params: { id: string }; Body: unknown }>('/api/requirements/:id/restore', async (request, reply) => {
    if (!UUID.test(request.params.id)) return invalidId(reply);
    const body = bodyOf(request.body);
    try {
      return database().requirements.restore(
        request.params.id, body.version as number, body.expectedRevision as number,
        body.actor as string, body.summary as string,
      );
    } catch (error) {
      return failure(reply, error);
    }
  });

  app.get<{ Params: { id: string } }>('/api/requirements/:id/versions', async (request, reply) => {
    if (!UUID.test(request.params.id)) return invalidId(reply);
    if (!database().requirements.find(request.params.id)) {
      return reply.code(404).send({ error: 'Requirement not found' });
    }
    return { versions: database().requirements.versions(request.params.id) };
  });

  app.get<{ Params: { id: string; version: string } }>('/api/requirements/:id/versions/:version', async (request, reply) => {
    if (!UUID.test(request.params.id)) return invalidId(reply);
    if (!VERSION.test(request.params.version)) {
      return reply.code(400).send({ error: 'Invalid requirement version' });
    }
    const version = database().requirements.version(request.params.id, Number(request.params.version));
    if (!version) return reply.code(404).send({ error: 'Requirement version not found' });
    return version;
  });
}

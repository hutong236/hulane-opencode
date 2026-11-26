import Fastify, { type FastifyInstance } from 'fastify';
import { JOB_SCHEMA, RUN_REQUEST_SCHEMA, RUN_SCHEMA } from './schema.js';
import { seedJobs, type AutomationJob, type AutomationRun } from './seed.js';

const SERVICE = 'example-automation';

/**
 * In-process sandbox API. A run is simulated: the command string is echoed, never executed, and the run counter is
 * local to this instance, so a fresh fixture always produces `run-0001` first.
 */
export function buildAutomationApp(): FastifyInstance {
  const app = Fastify({ logger: false });
  let jobs: AutomationJob[] = seedJobs();
  let runs: AutomationRun[] = [];

  app.get('/health', async () => ({ status: 'ok', service: SERVICE, contract: 'REQ-001' }));

  app.get('/api/schema', async () => ({
    service: SERVICE,
    version: 1,
    job: JOB_SCHEMA,
    runRequest: RUN_REQUEST_SCHEMA,
    run: RUN_SCHEMA,
  }));

  app.get('/api/jobs', async () => ({ jobs }));

  app.get('/api/runs', async () => ({ runs }));

  app.post<{ Body: unknown }>('/api/runs', async (request, reply) => {
    const body = request.body;
    if (typeof body !== 'object' || body === null || Array.isArray(body)) {
      return reply.code(400).send({ error: 'Invalid run request' });
    }
    const jobId = (body as { jobId?: unknown }).jobId;
    if (typeof jobId !== 'string' || !jobId.trim()) {
      return reply.code(400).send({ error: 'Invalid run request' });
    }
    const job = jobs.find(candidate => candidate.id === jobId.trim());
    if (!job) return reply.code(404).send({ error: 'Job not found' });
    const run: AutomationRun = {
      runId: `run-${String(runs.length + 1).padStart(4, '0')}`,
      jobId: job.id,
      status: 'succeeded',
      output: `simulated ${job.name}`,
    };
    runs.push(run);
    return reply.code(201).send(run);
  });

  // Fixture rebuild: clears simulated runs and hands out fresh job copies.
  app.post('/api/fixtures/reset', async () => {
    jobs = seedJobs();
    runs = [];
    return { reset: true, service: SERVICE };
  });

  return app;
}

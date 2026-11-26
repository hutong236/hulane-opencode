/** API contract of the v1 sandbox job and run. `environment` is deliberately absent: REQ-001 records that gap. */
export const JOB_SCHEMA = {
  $id: 'https://example.invalid/automation/job.v1.json',
  type: 'object',
  additionalProperties: false,
  required: ['id', 'name', 'command'],
  properties: {
    id: { type: 'string', pattern: '^job-[0-9]{3}$' },
    name: { type: 'string', minLength: 1, maxLength: 80 },
    command: { type: 'string', minLength: 1, maxLength: 120 },
  },
} as const;

export const RUN_REQUEST_SCHEMA = {
  $id: 'https://example.invalid/automation/run-request.v1.json',
  type: 'object',
  additionalProperties: false,
  required: ['jobId'],
  properties: {
    jobId: { type: 'string', pattern: '^job-[0-9]{3}$' },
  },
} as const;

export const RUN_SCHEMA = {
  $id: 'https://example.invalid/automation/run.v1.json',
  type: 'object',
  additionalProperties: false,
  required: ['runId', 'jobId', 'status', 'output'],
  properties: {
    runId: { type: 'string', pattern: '^run-[0-9]{4}$' },
    jobId: { type: 'string', pattern: '^job-[0-9]{3}$' },
    status: { type: 'string', enum: ['succeeded'] },
    output: { type: 'string' },
  },
} as const;

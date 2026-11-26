export interface AutomationJob {
  id: string;
  name: string;
  command: string;
}

export interface AutomationRun {
  runId: string;
  jobId: string;
  status: 'succeeded';
  output: string;
}

/** Fixed sandbox jobs. Commands are inert strings; nothing is executed. REQ-001 adds `environment` later. */
const SEED_JOBS: readonly AutomationJob[] = [
  { id: 'job-001', name: 'deploy-web', command: 'deploy --dry-run' },
  { id: 'job-002', name: 'rotate-logs', command: 'rotate --dry-run' },
];

/** A fresh copy per application instance, so two fixtures can never share mutable rows. */
export function seedJobs(): AutomationJob[] {
  return SEED_JOBS.map(job => ({ ...job }));
}

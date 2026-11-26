import { buildApp } from './app.js';

const host = process.env.WORKBENCH_HOST || '127.0.0.1';
const rawPort = process.env.WORKBENCH_API_PORT || '4000';
const port = Number(rawPort);
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error('WORKBENCH_API_PORT must be an integer between 1 and 65535');
}
const app = buildApp();
try {
  await app.listen({ host, port });
} catch (error) {
  app.log.error(error);
  process.exitCode = 1;
}

// A server the Workbench starts is this process's child. It is ended before the process goes, and one that an
// earlier run left behind is looked for once. Neither failing keeps the Workbench from running.
if (process.exitCode !== 1) {
  await app.opencode.reconcile();
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.once(signal, () => {
      const forced = setTimeout(() => process.exit(1), 10_000);
      forced.unref();
      app.close().then(() => process.exit(0), () => process.exit(1));
    });
  }
}

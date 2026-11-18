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

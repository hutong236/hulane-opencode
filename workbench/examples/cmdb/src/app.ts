import Fastify, { type FastifyInstance } from 'fastify';
import { ASSET_SCHEMA } from './schema.js';
import { ASSET_KINDS, seedAssets, type Asset, type AssetKind } from './seed.js';

const SERVICE = 'example-cmdb';

function isAssetKind(value: string): value is AssetKind {
  return (ASSET_KINDS as readonly string[]).includes(value);
}

/**
 * In-process sandbox API. It reads only the fixed seed below, binds nowhere and needs no credentials, so tests can
 * call it with `inject()` and two instances never share state.
 */
export function buildCmdbApp(): FastifyInstance {
  const app = Fastify({ logger: false });
  let assets: Asset[] = seedAssets();

  app.get('/health', async () => ({ status: 'ok', service: SERVICE, contract: 'REQ-001' }));

  app.get('/api/schema', async () => ({ service: SERVICE, version: 1, asset: ASSET_SCHEMA }));

  app.get<{ Querystring: { kind?: unknown } }>('/api/assets', async (request, reply) => {
    const kind = request.query.kind;
    if (kind !== undefined && (typeof kind !== 'string' || !isAssetKind(kind))) {
      return reply.code(400).send({ error: 'Unknown asset kind' });
    }
    return { assets: kind === undefined ? assets : assets.filter(asset => asset.kind === kind) };
  });

  app.get<{ Params: { id: string } }>('/api/assets/:id', async (request, reply) => {
    const id = request.params.id;
    if (!/^asset-[0-9]{3}$/.test(id)) return reply.code(400).send({ error: 'Invalid asset ID' });
    const asset = assets.find(candidate => candidate.id === id);
    if (!asset) return reply.code(404).send({ error: 'Asset not found' });
    return asset;
  });

  // Fixture rebuild: the reset is repeatable and cannot touch anything outside this process.
  app.post('/api/fixtures/reset', async () => {
    assets = seedAssets();
    return { reset: true, service: SERVICE };
  });

  return app;
}

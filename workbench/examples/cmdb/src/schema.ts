import { ASSET_KINDS } from './seed.js';

/**
 * API contract of the v1 sandbox asset. `environment` is intentionally absent: REQ-001 is the target contract,
 * and `workbench/examples/contracts/req-001.json` records the gap.
 */
export const ASSET_SCHEMA = {
  $id: 'https://example.invalid/cmdb/asset.v1.json',
  type: 'object',
  additionalProperties: false,
  required: ['id', 'name', 'kind', 'owner'],
  properties: {
    id: { type: 'string', pattern: '^asset-[0-9]{3}$' },
    name: { type: 'string', minLength: 1, maxLength: 80 },
    kind: { type: 'string', enum: [...ASSET_KINDS] },
    owner: { type: 'string', minLength: 1, maxLength: 60 },
  },
} as const;

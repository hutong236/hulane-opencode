export const ASSET_KINDS = ['server', 'database', 'network'] as const;
export type AssetKind = (typeof ASSET_KINDS)[number];

export interface Asset {
  id: string;
  name: string;
  kind: AssetKind;
  owner: string;
}

/** Fixed, credential-free sandbox data. REQ-001 deliberately adds no `environment` field yet. */
const SEED_ASSETS: readonly Asset[] = [
  { id: 'asset-001', name: 'payments-api', kind: 'server', owner: 'payments' },
  { id: 'asset-002', name: 'orders-db', kind: 'database', owner: 'orders' },
  { id: 'asset-003', name: 'edge-router', kind: 'network', owner: 'platform' },
];

/** A fresh copy per application instance, so two fixtures can never share mutable rows. */
export function seedAssets(): Asset[] {
  return SEED_ASSETS.map(asset => ({ ...asset }));
}

# Hulane OpenCode Web Workbench

Development scaffold for [WB-001](https://github.com/hutong236/hulane-opencode/issues/5). It lives in `workbench/` to keep the existing Hulane plugin and its root `npm ci`/CI independent.

## Requirements

Node.js >= 20. Use the committed `package-lock.json` with `npm ci` for reproducible installs. This scaffold still requires an npm Registry connection when the packages are not cached.

## Run (development)

```bash
cd workbench
npm install
npm run dev
```

Open http://localhost:3000 ; the Vite dev server proxies `/api` to Fastify at 127.0.0.1:4000. No OpenCode or Hulane execution is wired in yet. `npm run build`, `npm run typecheck`, `npm test` provide basic checks once dependencies are installed.

## Directory boundaries

- `apps/web` — local Web UI (React + Ant Design)
- `apps/api` — local Fastify API (`GET /api/health` only for now)
- `apps/worker` — reserved process boundary; it **does not execute jobs yet**
- `packages/domain`, `packages/database`, `packages/opencode-adapter`, `packages/hulane-adapter` — reserved package boundaries, **not implementations**

The existing `hulane/`, `opencode/` and GitHub state remain the source of truth for protected single-repository operations. This scaffold grants no permissions and starts no write-capable agent. UI sections that are not implemented are marked accordingly.

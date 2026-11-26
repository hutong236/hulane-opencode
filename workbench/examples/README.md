# Workbench sandbox examples — WB-021

Three minimal, deliberately separate demos for [REQ-001](#req-001): a CMDB asset API, a simulated Automation
runner and a simulated Monitoring event/alert API. They are sandbox fixtures for the Workbench, not production
services: no credentials, no network calls, no production host names, and every server binds `127.0.0.1` only.

## Layout

- `contracts/req-001.json` — the target cross-service contract and its acceptance cases.
- `cmdb/` — assets `asset-001` … `asset-003`, read-only API, health check, API schema.
- `automation/` — jobs `job-001`, `job-002`; a run echoes its command and is never executed.
- `monitoring/` — fixed events `evt-001` … `evt-004` and alerts `alert-002`, `alert-003`.
- `scripts/init-example-repos.mjs` — repeatable `git init` + first commit for all three directories.

Each project has its own `package.json`, `tsconfig.json`, `src/`, `test/` and npm scripts (`build`, `start`,
`test`). The shared Workbench `node_modules` already contains Fastify, tsx and TypeScript, so the projects run in
place; outside the Workbench they need `npm install` first.

## Run one project

The templates run in place because the Workbench `node_modules` is on their resolution path.

```bash
cd workbench/examples/cmdb
npm run build
npm test
PORT=4101 npm start
```

For independent Git repositories, initialize a scratch copy. The script requires `--root`; never run `git init`
inside the Workbench checkout.

```bash
mkdir -p /tmp/wb-examples
cp -R workbench/examples/cmdb workbench/examples/automation workbench/examples/monitoring /tmp/wb-examples/
node workbench/examples/scripts/init-example-repos.mjs --root /tmp/wb-examples
```

The first run initializes each directory and commits once; later runs report `already initialized` and leave the
commits unchanged. To start a scratch copy, run `npm install` in it first.

Ports: CMDB `4101`, Automation `4102`, Monitoring `4103`. Override with `PORT`. Every project serves
`GET /health` and `GET /api/schema`.

```bash
curl -s http://127.0.0.1:4101/health
curl -s http://127.0.0.1:4101/api/assets
curl -s http://127.0.0.1:4102/api/jobs
curl -s -X POST -H 'content-type: application/json' \
  -d '{"jobId":"job-001"}' http://127.0.0.1:4102/api/runs
curl -s 'http://127.0.0.1:4103/api/events?level=critical'
```

## Fixtures and isolation

- The seed data is a fixed constant in each project's `src/seed.ts`; every response is built from fresh copies, so
  two app instances in one process cannot share mutable rows.
- `POST /api/fixtures/reset` rebuilds the fixture in the running process. Automation additionally clears its
  simulated runs, so the next run id is `run-0001` again.
- Nothing is written to disk and no external service is contacted. The examples require no test credentials.
- `node workbench/examples/scripts/init-example-repos.mjs --root <dir>` is idempotent: the first run initializes
  each directory with one commit, later runs report `already initialized` and leave the commits unchanged.

## Register in the Workbench project catalog

After initializing the scratch copies, start the Workbench (`cd workbench && npm run dev`) and register each
`/tmp/wb-examples/<name>` path through the project form. The copies are plain Git roots with a `main` branch
and no remote, which is what the registration expects. The API regression
`workbench/apps/api/test/wb-021-examples.spec.ts` covers the same path with `inject()`.

## REQ-001

REQ-001 is the environment closed loop:

1. CMDB adds `environment` (`dev`, `test`, `prod`) to every asset.
2. Automation accepts an `environment` and executes only against a job of the same environment.
3. Monitoring records an `environment` on events and filters events and alerts by it.

**The v1 examples intentionally stop short of this loop:** none of the three schemas contains an `environment`
field. That gap is recorded in `contracts/req-001.json` (`status: "open"`, `knownGap`) and pinned by the API
regression, so the baseline cannot pretend the requirement is already implemented. The contract lists the four
acceptance cases that the next step must satisfy.

## Verification

- API regression: `workbench/apps/api/test/wb-021-examples.spec.ts` (Fastify `inject`) covers health, seed
  determinism, filters, failure boundaries, fixture reset, `git init` repeatability and registration of all three
  repositories.
- Per-project unit tests live in `examples/<name>/test/*.spec.ts` and use `node:test` with `inject()`.
- These sandbox projects do not call the real Workbench API, GitHub, OpenCode or any production system.

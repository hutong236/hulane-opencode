# Workbench autonomous development log

One checkpoint per run of `.github/workflows/workbench-autodev.yml`, newest first. These entries are written by the model and are not reviewed. The hand-written session handoff is [SESSION_HANDOFF.md](SESSION_HANDOFF.md).

### WB-021 — 2026-11-26: sandbox CMDB/Automation/Monitoring fixtures and the REQ-001 contract

- Task: first bounded WB-021 slice (Issue #25). Add three separable sandbox projects under `workbench/examples/` with fixed seed data, health checks, API schemas, fixture reset, per-project unit tests, a repeatable Git initialization script, and the REQ-001 target contract. The v1 schemas intentionally omit `environment`, so the environment closed loop is defined but not yet implemented.
- Files: `workbench/examples/README.md`, `workbench/examples/contracts/req-001.json`, `workbench/examples/scripts/init-example-repos.mjs`, each of `workbench/examples/{cmdb,automation,monitoring}/` (`.gitignore`, `package.json`, `tsconfig.json`, `src/{seed,schema,app,server}.ts`, `test/*.spec.ts`), `workbench/apps/api/test/wb-021-examples.spec.ts`, `docs/WORKBENCH_AUTODEV_LOG.md`.
- Coverage: the API regression checks health, deterministic seeds and per-instance isolation, filters, malformed and unknown inputs, automation reset to `run-0001`, the REQ-001 contract fields, the deliberate schema gap, repeatable `git init`, unchanged commits on a second run, a missing `--root` and a missing directory failure, registration of all three repositories, duplicate refusal, and clean working trees.
- Validation: **not run** in this session. No commands, lint, typecheck, build, unit test, Playwright or network request was executed, so nothing here is evidence that they pass. The next workflow step owns those checks for the pushed SHA.
- Not verified: the example `server.ts` listeners were not started, no browser case was added, and the per-project npm scripts were not executed. Issue #3 remains open; this is a development demo, not production acceptance.
- Next: implement REQ-001 end to end (CMDB environment on assets, Automation matching run environment with 409 on mismatch, Monitoring environment filtering), then update the contract status and the schema-gap regression in the same change.

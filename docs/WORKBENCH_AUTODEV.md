# Scheduled OpenCode issue implementation

This is an **implementation** runner, not only the read-only progress monitor. It runs every half-hour under `.github/workflows/workbench-autodev.yml` from the default branch. GitHub can delay scheduled events.

The workflow file stopped inside its model step from its first commit (`8e8cfcc`, 2026-11-18) until 2026-11-25. It still parsed, so every scheduled run created a branch and reported success without calling a model, running a check or publishing. `test/workbench-autodev-workflow.test.mjs` now reads the workflow at the start of every run and fails when a stage, a here-document terminator, a permission rule or a safety condition is missing.

## What one run does

1. Runs the selector and workflow tests, then the credential gate. Missing configuration reports **BLOCKED**; no provider call and no repository write follows.
2. Selects one task: a red pull request first (repair), otherwise the first open Issue whose dependencies are closed (new). An Issue with an open pull request whose CI is running or green is left alone, and so is one whose only open pull request comes from a branch that is not a task branch.
3. Starts the pinned OpenCode V2.2.7 CLI with a dedicated `autodev` agent. Its rules deny every tool, then allow reading and editing `workbench/*` and `docs/SESSION_HANDOFF.md`; `.env*` files are denied again after that. The step has the provider key only: no GitHub token, no shell, no network tool. The limits live on the agent because OpenCode applies agent rules after global ones and the last match wins; the built-in `build` agent starts with allow-everything.
4. Verifies the change with `workbench-autodev.mjs verify`: at most 30 files, allowed paths only, no secret-like path or symlink, no deleted file, no change to an existing `test*`, `lint`, `typecheck` or `build` script, and no change to a tracked `tsconfig*.json`, `workbench/playwright.config.ts`, `workbench/scripts/lint.mjs` or `workbench/.gitignore`. A violation fails the run and nothing is published.
5. Runs the checks with no credentials: root `npm ci`, `check:syntax`, `npm test`; Workbench `npm ci`, lint, typecheck, build, unit tests and Playwright with the Chrome preinstalled on the runner image. Every command streams into the job log. Any failure fails the run.
6. Publishes only when every check passed and the run was scheduled or was dispatched with `publish=true`: one commit, a plain push to the task branch (rejected, never forced, when the branch moved), then a Draft pull request for a new task or a comment on the existing one for a repair. The workflow never marks a pull request ready, merges, closes an Issue or forces a push.

A new task uses `feat/WB-NNN-autodev`. If that branch already exists on the remote, the run ID is appended instead of reusing it.

## Manual run and dry run

```bash
gh workflow run workbench-autodev.yml --ref <branch> -f publish=false
```

With `publish=false` the model and the checks run and the change is written to the job log and summary; nothing leaves the runner. The workflow must exist on the default branch to be dispatched; `--ref` runs the version on another branch.

## Evidence so far

- 2026-11-24: two dry runs dispatched from the fix branch (`3d89fd51`, `bf75d25e`) with `publish=false`, [run 45441282096](https://github.com/hutong236/hulane-opencode/actions/runs/45441282096) and [run 45446363872](https://github.com/hutong236/hulane-opencode/actions/runs/45446363872). Both selected WB-005, completed the model step with `deepseek/deepseek-flash` (11 and 7 minutes), passed the change verification and every check on the runner, and published nothing. The second change covered 18 files; its edits to the existing database tests only followed the migration it added.
- The publishing step had not run for real when this was written.

## GitHub owner setup

Repository Settings -> Secrets and variables -> Actions:

- **Variable** `WORKBENCH_AUTODEV_MODEL`: exact OpenCode `provider/model` identifier. Recommended for DeepSeek: `deepseek/deepseek-flash` (current V4.1 Flash); alternative `deepseek/deepseek-v4-pro`.
- **Secret** `WORKBENCH_DEEPSEEK_API_KEY` for DeepSeek, `WORKBENCH_OPENAI_API_KEY` for OpenAI, or `WORKBENCH_ANTHROPIC_API_KEY` for Anthropic. The required key must match the selected model's provider.
- **Secret** `WORKBENCH_AUTODEV_TOKEN`: fine-grained repository PAT or GitHub App token with Contents Read/Write and Pull Requests Read/Write. Use a dedicated identity, NOT any production credentials. Unlike the built-in GITHUB_TOKEN, a separate app/PAT token can trigger the normal CI workflows after push/PR events.

Until configured, the run reports **BLOCKED** and makes no model call or GitHub write. Provider billing may apply once activated; set spending limits.

## Safety, caveats and handoff

- The model step receives no GitHub token. Its OpenCode permissions deny shell and allow edits only in `workbench/` and `docs/SESSION_HANDOFF.md`; the change is verified again before anything is published.
- The model does **not** run tests. Checks run in a separate step with no provider or GitHub write secrets; their output is in the job log, and a failing check fails the run instead of leaving it green.
- The publishing token is provided only in the final push/PR step. The workflow is serialized across scheduled runs and disallows modifying Hulane core, CI workflows and privileged release paths.
- Nobody reviews a change before it becomes a Draft pull request. Read the diff in the job log and the pull request before merging.
- A red Draft pull request is retried by every later run until it is green or a person closes it. There is no retry cap.
- A model API key is still exposed to the model execution process. This is a defense-in-depth design, not OS-level isolation or production security certification. See production acceptance Issue #3.
- Some Issues require core or workflow changes outside the allowlist. Those must be implemented via separately reviewed PRs. Human review/merge unlocks dependent Issues.
- The read-only `.github/workflows/workbench-progress.yml` remains enabled alongside the implementation runner.
- Selector and workflow verification: `node --test test/workbench-autodev.test.mjs test/workbench-autodev-workflow.test.mjs`. No workflow is production-approved merely because these unit tests pass.

In each run, `gh run view <run> --log` and the Job Summary show the selected task, the model's output, the change, every check result and the pull request URL.

## DeepSeek API (BYOK)

1. Create a DeepSeek API Key in https://platform.deepseek.com/ (API access and billing are separate from the consumer chat app).
2. In **Settings > Secrets and variables > Actions > Variables**, set `WORKBENCH_AUTODEV_MODEL` = `deepseek/deepseek-flash`. For Pro, use `deepseek/deepseek-v4-pro` only if your pinned OpenCode V2 installation lists it.
3. Under **Secrets**, set `WORKBENCH_DEEPSEEK_API_KEY` to the private key. The workflow maps this securely to the native `DEEPSEEK_API_KEY` environment variable in OpenCode's standalone process.
4. Configure the separate, fine-grained `WORKBENCH_AUTODEV_TOKEN` for branch pushes and Draft PRs.
5. In Actions, manually dispatch `Workbench autonomous development`; inspect output and branch/PR, then allow scheduled execution. No API call has been verified until a real run succeeds.

The credential gate validates that a `deepseek/*` model has a **DeepSeek** key, rather than accepting unrelated OpenAI/Anthropic credentials. DeepSeek's legacy API model names `deepseek-chat` and `deepseek-reasoner` were discontinued in July 2026. The official DeepSeek current endpoint uses `https://api.deepseek.com`, which the supported OpenCode native DeepSeek provider handles. If pinned OpenCode V2.2.7 does not expose the current model in its catalog, validate model availability before changing the pinned CLI or adding a custom provider definition; do not silently substitute the old model IDs.

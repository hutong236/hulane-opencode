# Scheduled OpenCode issue implementation

This is an **implementation** runner, not only the read-only progress monitor. It runs every half-hour under `.github/workflows/workbench-autodev.yml` after merging into the default branch. GitHub can delay scheduled events.

Each run reads all WB-001 through WB-028 Issues and dependencies, prioritizes repair of red CI, selects one dependency-ready item, runs pinned OpenCode V2.2.7, checks generated edits, runs tests, then pushes a feature branch and creates or updates a **Draft PR**. Green PRs wait for human review; no automatic merge, closure or production release occurs.

## GitHub owner setup

Repository Settings -> Secrets and variables -> Actions:

- **Variable** `WORKBENCH_AUTODEV_MODEL`: exact OpenCode `provider/model` identifier. Recommended for DeepSeek: `deepseek/deepseek-flash` (current V4.1 Flash); alternative `deepseek/deepseek-v4-pro`.
- **Secret** `WORKBENCH_DEEPSEEK_API_KEY` for DeepSeek, `WORKBENCH_OPENAI_API_KEY` for OpenAI, or `WORKBENCH_ANTHROPIC_API_KEY` for Anthropic. The required key must match the selected model's provider.
- **Secret** `WORKBENCH_AUTODEV_TOKEN`: fine-grained repository PAT or GitHub App token with Contents Read/Write and Pull Requests Read/Write. Use a dedicated identity, NOT any production credentials. Unlike the built-in GITHUB_TOKEN, a separate app/PAT token can trigger the normal CI workflows after push/PR events.

Until configured, the run reports **BLOCKED** and makes no model call or GitHub write. Provider billing may apply once activated; set spending limits.

## Safety, caveats and handoff

- Model step receives no GitHub write token. Its OpenCode permissions deny shell and allow edits only in `workbench/` and `docs/SESSION_HANDOFF.md`; edits are checked again before publication.
- The model does **not** run tests. Tests run in a separate step with no provider or GitHub write secrets; the results are recorded rather than fabricated.
- The publishing token is provided only in the final push/PR step. The workflow is serialized across scheduled runs and disallows modifying Hulane core, CI workflows and privileged release paths.
- A model API key is still exposed to the model execution process. This is a defense-in-depth design, not OS-level isolation or production security certification. See production acceptance Issue #3.
- Some Issues require core or workflow changes outside the allowlist. Those must be implemented via separately reviewed PRs. Human review/merge unlocks dependent Issues.
- The read-only `.github/workflows/workbench-progress.yml` remains enabled alongside the implementation runner.
- Selector verification: `node --test test/workbench-autodev.test.mjs`. No workflow is production-approved merely because this unit test passes.

In each run, see the GitHub Actions Job Summary for the selected task, blocked dependencies, test result and PR SHA.

## DeepSeek API (BYOK)

1. Create a DeepSeek API Key in https://platform.deepseek.com/ (API access and billing are separate from the consumer chat app).
2. In **Settings > Secrets and variables > Actions > Variables**, set `WORKBENCH_AUTODEV_MODEL` = `deepseek/deepseek-flash`. For Pro, use `deepseek/deepseek-v4-pro` only if your pinned OpenCode V2 installation lists it.
3. Under **Secrets**, set `WORKBENCH_DEEPSEEK_API_KEY` to the private key. The workflow maps this securely to the native `DEEPSEEK_API_KEY` environment variable in OpenCode's standalone process.
4. Configure the separate, fine-grained `WORKBENCH_AUTODEV_TOKEN` for branch pushes and Draft PRs.
5. In Actions, manually dispatch `Workbench autonomous development`; inspect output and branch/PR, then allow scheduled execution. No API call has been verified until a real run succeeds.

The credential gate validates that a `deepseek/*` model has a **DeepSeek** key, rather than accepting unrelated OpenAI/Anthropic credentials. DeepSeek's legacy API model names `deepseek-chat` and `deepseek-reasoner` were discontinued in July 2026. The official DeepSeek current endpoint uses `https://api.deepseek.com`, which the supported OpenCode native DeepSeek provider handles. If pinned OpenCode V2.2.7 does not expose the current model in its catalog, validate model availability before changing the pinned CLI or adding a custom provider definition; do not silently substitute the old model IDs.

# Hulane OpenCode — GitHub checkpoint execution contract

This repository is the persistent handoff point for ChatGPT / Web / OpenCode sessions. **A conversational response is never a substitute for a pushed commit.**

## Required loop: one bounded task → one remote checkpoint

1. At the beginning of each session, read this file, `docs/SESSION_HANDOFF.md`, the active Draft PR, the latest remote branch commit, and the CI status. Follow the *remote* branch state, not remembered conversation state.
2. Select **one small, verifiable task** with a clear acceptance condition. Avoid combining several unrelated changes into one large uncommitted batch.
3. Make the code/documentation change on `feat/opencode-v2-initial-implementation` (or the explicitly agreed feature branch). Run the relevant local checks when possible. Record any checks not run as *unverified*.
4. **Immediately after that individual task**, create a descriptive commit and push it to GitHub. For API-based edits, create tree → commit with exact parent SHA → update branch ref with expected SHA; verify the updated remote head. **Do not start another task until the push is confirmed.**
5. Update `docs/SESSION_HANDOFF.md` during the same task/commit when feasible with what changed, commit reference, validation evidence, known failures, and the exact next task. The remote branch head is always the authoritative *latest SHA*; avoid rewriting files solely to update self-referential hashes.
6. Check GitHub Actions and PR after push. If CI fails, the **next independent task** is to diagnose/fix the failure and push that fix immediately. Never represent queued or failing CI as passed.
7. If an API/web/session interrupts mid-operation: fetch GitHub branch head + commit/tree and compare before retrying. Never blindly force-push, redo a write with unknown status, or claim an unverified push succeeded.
8. If GitHub write/push becomes unavailable, stop code changes, disclose the blocker and unpushed work. Never assume a local or chat-only draft is durable.

## Rules and limits

- Preserve `main` as the approved design-document baseline. Keep [Draft PR #1](https://github.com/hutong236/hulane-opencode/pull/1) in Draft until real sandbox Gate A/B/C, security, release, and concurrency acceptance is complete.
- Prefer one narrowly scoped commit per development milestone (including regression tests). A “step” is a reviewable deliverable, **not** every read/search/tool invocation.
- Record exact verification: test command, environment, result, Actions URL, failed/cancelled/pending checks, and whether real OpenCode CLI was exercised.
- In PR descriptions/comments and user updates, always provide the **remote commit SHA** and CI status, not just “done”.
- Never commit passwords, tokens, `.env`, machine-only files, or temporary GitHub credentials. Do not bypass protected actions or GitHub Rulesets.
- Before touching a production or privileged GitHub operation, separately verify required human approval and real target/commit. A green unit suite is not proof of production security acceptance.
- When work spans sessions, continue from `docs/SESSION_HANDOFF.md` and verify that no newer remote commits supersede the recorded plan.

## Standard checkpoint summary (record in handoff/PR)

```text
Step: <single task / acceptance criterion>
Branch: feat/opencode-v2-initial-implementation
Commit: <confirmed remote SHA>
Files: <changed paths>
Validation: <commands + passed/failed/not-run + Actions URL>
Risk / blocker: <known limitations or none>
Next step: <one small independent task>
```

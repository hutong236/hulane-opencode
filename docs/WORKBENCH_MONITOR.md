# 28-Issue Workbench delivery monitor

This is a **read-only progress monitor**, not an autonomous code-writing agent. Source: `.github/workflows/workbench-progress.yml` and `bin/workbench-progress.mjs`.

- Schedule: `*/30 * * * *` in UTC. GitHub scheduled Actions can start later than the exact minute under load.
- Activation: scheduled workflows run only from the repository's default branch; review and merge the monitor PR before the timer is active.
- Each run fetches all workbench issues (WB-001 through WB-028), related PRs, and recent GitHub Actions; the run's **Job Summary** shows the count, next open tasks, PR status and CI evidence.
- Checks for missing/duplicate task IDs fail. Counts of closed Issues are **not** a claim of completed E2E acceptance.
- No write token, secrets, production access, or webhook is needed; `GH_TOKEN` is GitHub's ephemeral read-only Actions token.
- `workflow_dispatch` enables manual checks after merging.
- Local tests: `node --test test/workbench-progress.test.mjs`.

Development continues via one issue -> branch -> scoped changes -> tests -> PR; the monitor does not auto-merge PRs, bypass gates, start privileged OpenCode sessions, or close Issues.

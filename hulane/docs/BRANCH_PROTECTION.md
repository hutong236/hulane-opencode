# PR checks and merge guards

`hulane` always requires a successful PR workflow. `/hulane_init` installs:

```text
.github/workflows/pr-checks.yml
.github/scripts/hulane-pr-checks.sh
```

The stable check name is:

```text
Hulane PR Checks / verify
```

## Mode 1: GitHub required checks

Public repositories and paid GitHub plans should protect the default branch:

- require a pull request before merging;
- require `Hulane PR Checks / verify` to pass;
- require the branch to be up to date;
- block force pushes and branch deletion;
- require conversation resolution;
- apply the rule to administrators when repository policy permits.

This is recorded as `merge_guard_mode: github_required_checks` and permits the
low/medium-risk automatic merge path after Tester and Reviewer pass.

## Mode 2: private-repository control-plane guard

GitHub Free does not provide protected branches for private repositories. In
that environment `hulane_verify_pr_checks` performs the compensating control:

1. query the exact open, non-draft PR;
2. require `Hulane PR Checks / verify` to have concluded `SUCCESS`;
3. persist the PR head SHA, check name, and GitHub details URL;
4. record `merge_guard_mode: control_plane_verified` without claiming that
   GitHub itself enforces the check;
5. tier Gate B by risk like the GitHub-enforced mode: low/medium risk merges
   automatically under the compensating controls above (every reported check
   must succeed), while high risk still stops at human Gate B;
6. verify every merge command against the recorded state — token or
   state-verified — and require `--match-head-commit <verified-sha>`.

This mode protects merges performed through `hulane`, but it cannot prevent a
repository administrator from manually merging or pushing through the GitHub
web interface. Teams needing that server-side guarantee must use GitHub branch
protection.

Missing, pending, skipped, neutral, cancelled, timed out, or failed workflow
results block both modes.

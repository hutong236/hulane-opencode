# hulane V2 architecture

V2 separates orchestration, authority, execution, and evidence.

| Layer | Owner | Responsibilities |
| --- | --- | --- |
| Orchestration | ZCode Primary Agent | Interpret slash command, dispatch workers, present human Gates |
| Control plane | `hulane-control` MCP | Validate inputs, transition state, sync GitHub, create worktrees, issue one-use authorization, verify delivery |
| Workers | Planner/Coder/Tester/Reviewer/Build Checker | Bounded work in exhaustive tool lists; no nested subagents or MCP authority |
| Policy | Session/PreToolUse/Stop hooks | Inject current constraints, protect privileged shell actions, reject false Done claims |
| Truth | GitHub Issue + live PR/Actions/GHCR facts | Durable machine comment/label and independently verifiable delivery evidence |
| Projection | `.hulane/state.json` + `plan/` | Recoverable local cache and read-only Obsidian views |

## MCP tools

| Tool | Effect |
| --- | --- |
| `hulane_preflight` | Read-only repository and server-policy readiness (GitHub-dependent checks grouped as `online_required`, plus an `offline_open_ready` verdict for local-first intake) |
| `hulane_initialize` | Install managed cache/views/check workflows |
| `hulane_open_work_item` | Create the Work Item locally (offline-capable, zero gh calls; local REQ/BUG numbering, `issue_pending=true`, planner summary/acceptance criteria persisted) |
| `hulane_transition` | Apply one evidence-bearing state event and sync (pending items sync as `skipped: "issue_pending"`) |
| `hulane_status` / `hulane_validate` | Reconcile and validate truth (pending items refresh local-only) |
| `hulane_sync` / `hulane_hydrate` | Move canonical machine state to/from GitHub |
| `hulane_flush` | Complete a pending item's Issue in one online window: idempotent title precheck, create-or-reuse, `issue_created` backfill, one final-state sync |
| `hulane_worktree_create` | Create the one isolated Work Item worktree |
| `hulane_verify_pr_checks` | Verify the exact PR head/check and select the available merge guard |
| `hulane_authorize` | Issue one state-bound token for push/tag; merge and Issue close are state-verified by the guard |
| `hulane_verify_delivery` | Cross-check merged SHA, Actions, Release, GHCR, SBOM and provenance |
| `hulane_record_specs_synced` | Validate the delta-touched capability main specs in the merged_sha tree (full-tree fallback without delta specs/ snapshots), then record specs_synced |

The stdio server supports current stateless MCP discovery (`2026-07-28`) and
legacy initialization-based clients. Tool input is validated in the server,
not assumed from the client.

## Gate invariants

- Gate A is required before a worktree or business-code write.
- Gate B is required for high-risk merges under either guard mode. It never
  bypasses workflow checks.
- Public repositories use GitHub required checks. Private repositories without
  paid branch protection use an exact-SHA MCP guard whose compensating
  controls (every reported check must succeed, pinned head SHA) carry
  low/medium-risk merges to completion; high risk still stops for a human.
- Gate C is required after merge before tag/image delivery or an explicitly
  policy-allowed non-runtime skip.
- Spec sync is required before Issue close: a spec_sync_required item must pass
  the merged-tree validation of delta-touched capability specs through
  `hulane_record_specs_synced` (specs_commit_sha = merged_sha); the state
  machine and the guard both reject
  the close otherwise. Small items are always exempt, standard Planner-exempted
  pure-infra/docs items record the reason, and legacy items are grandfathered.
- Automatic rework is limited to three rounds; the next failure blocks.
- Runtime Done requires a closed Issue, merged SHA, verified GHCR digest,
  matching Release metadata, and immutable SBOM/provenance attestation digests.

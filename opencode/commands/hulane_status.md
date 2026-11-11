---
description: "只读对账 Hulane 研发状态，汇总 GitHub、Git、本地投影、PR checks 与镜像构建信息。"
agent: hulane-orchestrator
---

First load the `hulane-development` skill. This is the OpenCode V2 port: use the `hulane-control` MCP tools as the sole source of authority for lifecycle transitions; never fabricate evidence. For legacy Bash steps, obey the OpenCode V2 plugin shell guard and the exact worktree restrictions. Do not claim Done unless the control plane verifies it.

Read-only reconcile scope $ARGUMENTS through `hulane_status` with GitHub refresh for each requested Work Item, followed by `hulane_validate`. GitHub machine state and live PR/Actions facts outrank cache; MCP may refresh only local cache/projection. An `issue_pending` item has no remote Issue yet: its refresh reads local-only (remote-truth-wins defers to pending) and it is flagged as 「Issue 待补建（flush）」 until `hulane_flush` runs. Do not alter product code or GitHub objects. Show Waiting Approval, Developing, Testing, Review, PR Checking, Waiting Human Merge, Waiting Tag Confirm, Building, Waiting Close, Blocked, and Recently Done. Include ID/title/Issue/revision/branch/worktree/agent/rework budget/PR/checks/risk/delivery/spec sync (spec_sync_required, specs_synced, specs_commit_sha)/build/image/next action, and flag any waiting_close item with spec_sync_required true and specs_synced unrecorded as pending spec sync before close.

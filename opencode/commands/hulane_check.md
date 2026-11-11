---
description: "对 Hulane 的 ZCode/GitHub/Docker 镜像工作流做只读预检。"
agent: hulane-orchestrator
---

First load the `hulane-development` skill. This is the OpenCode V2 port: use the `hulane-control` MCP tools as the sole source of authority for lifecycle transitions; never fabricate evidence. For legacy Bash steps, obey the OpenCode V2 plugin shell guard and the exact worktree restrictions. Do not claim Done unless the control plane verifies it.

Call the read-only `hulane_preflight` MCP tool for the current workspace. Do not duplicate it with ad-hoc shell mutations. Present every returned check as Check/Result/Evidence/Required action with its group (`local` or `online_required`) and preserve its READY, READY_WITH_WARNINGS, or NOT_READY verdict. Only local hard items (git, origin remote, PR-checks workflow files, verifiable image workflow) failing yields NOT_READY; GitHub-dependent checks (gh, gh auth, repository access, required server check, merge guard) are grouped as `online_required` — when they fail while the local items pass, the verdict is READY_WITH_WARNINGS with `online_required.ready=false`, and `offline_open_ready=true` still allows local-first Work Item intake offline. Public repositories require branch protection plus the required check. Private repositories without paid branch protection may be READY only when the PR workflow and authenticated control-plane merge guard are available; clearly report that this mode cannot block manual GitHub UI merges. Do not call any mutating MCP tool. Notes: $ARGUMENTS

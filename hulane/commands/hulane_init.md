---
description: 为 Hulane 仓库初始化本地只读 Obsidian 投影和 GitHub Actions 镜像构建工作流。
argument-hint: "[optional setup notes]"
skills: hulane-development
---
Use only the `hulane-control` MCP plane for initialization. Call `hulane_preflight`; stop on fundamental Git/GitHub access failures, otherwise call `hulane_initialize` to create state/cache directories, managed Obsidian views, PR checks, and (when Dockerfile exists) the tag-only image workflow, and report readiness from its result instead of running a second preflight. Never touch business code or create an Issue. Public repositories are auto-merge ready only when GitHub enforces `Hulane PR Checks / verify`. A private repository without paid branch protection may use the control-plane guard, but report that every merge requires Gate B and manual GitHub UI merges remain outside enforcement. Return changed files, MCP/hook availability, readiness, blockers, and next command. Notes: $ARGUMENTS

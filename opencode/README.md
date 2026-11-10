# OpenCode V2 adapter

This directory stores installable native OpenCode V2 commands, agents, and skill.

- `commands/hulane_*.md`: preserved Hulane command semantics; V2 frontmatter uses `agent: hulane-orchestrator`.
- `agents/hulane-orchestrator.md`: primary agent; remaining seven are subagents, each with deny-by-default permissions.
- `skills/hulane-development/SKILL.md`: original work-item invariants, adapted for OpenCode.
- `plugin/index.ts`: uses `@opencode/plugin` `Plugin.define`, `ctx.shell.hook('create.before')`, and `ctx.tool.hook('execute.before')`.
- `../bin/install.mjs`: copies native files into a business repo and references this independent package and MCP server.

## Security qualification

The OpenCode V2 native hooks do not make out-of-process terminal commands safe and are not equivalent to GitHub server-side Rulesets. Shell token guard retains legacy command-shape blind spots. No production promotion until the high-risk negative tests and GitHub required checks have been verified in a sandbox.

## Development check

Run `npm test` in this source repository; then use `bin/install.mjs` against a disposable business repository. OpenCode beta SDK compatibility must be pinned with a lockfile in a tested version before release.

OpenCode V2 MCP tools are exposed directly with `codemode: false`. The project-level rule denies `hulane-control_*`; only `hulane-orchestrator` overrides it to `ask`. All workers retain wildcard denial, with carefully scoped exceptions.

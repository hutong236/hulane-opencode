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

Run `npm test` in this source repository; then use `bin/install.mjs` against a disposable business repository. OpenCode V2 SDK and CLI are pinned at v2.2.7 and the npm lockfile is committed. Full sandbox Gate A/B/C + GHCR and OS sandbox acceptance remains required.

OpenCode V2 MCP tools are exposed directly with `codemode: false`. The project-level rule places a final `hulane-control_*` deny **after all existing project permission rules**, so earlier wildcard/explicit allows cannot override the authority deny. Only `hulane-orchestrator` overrides the global deny to `ask`; existing shell rules remain in effect. All workers retain wildcard denial, with carefully scoped exceptions.

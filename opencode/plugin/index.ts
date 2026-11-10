import { Plugin } from "@opencode/plugin";
import path from "node:path";
import { evaluateCommand } from "../../hulane/hooks/guard.mjs";
import { evaluateCoderWorktree } from "../../hulane/scripts/lib/opencode-worktree-guard.mjs";
import { evaluateDisciplineBash, evaluateDisciplineEdit } from "../../hulane/scripts/lib/discipline.mjs";

// OpenCode V2 adapter. No ZCode lifecycle JSON is loaded here.
// The MCP state machine remains the authority; shell hooks are defense-in-depth.
export default Plugin.define({
  id: "hulane",
  async setup(ctx) {
    await ctx.permission.hook("evaluate", (event) => {
      const result = evaluateCoderWorktree({
        agent: event.agent, action: event.action,
        resources: event.resources, locationDirectory: ctx.location.directory,
      });
      if (!result.allowed) { event.effect = "deny"; event.message = result.reason; }
    });
    await ctx.shell.hook("create.before", (event) => {
      const command = String(event.command ?? "");
      const cwd = String(event.cwd ?? ctx.location.directory);
      const discipline = evaluateDisciplineBash({ command, cwd });
      if (!discipline.allowed) throw new Error("Hulane discipline: " + discipline.reason);
      const guard = evaluateCommand({
        command,
        cwd,
        token: event.env?.HULANE_AUTH_TOKEN ?? command.match(/(?:^|\\n)\\s*HULANE_AUTH_TOKEN=([^\\s]+)/)?.[1],
        releaseTagToken: event.env?.HULANE_RELEASE_TAG_TOKEN ?? command.match(/(?:^|\\n)\\s*HULANE_RELEASE_TAG_TOKEN=([^\\s]+)/)?.[1],
        releasePushToken: event.env?.HULANE_RELEASE_PUSH_TOKEN ?? command.match(/(?:^|\\n)\\s*HULANE_RELEASE_PUSH_TOKEN=([^\\s]+)/)?.[1],
      });
      if (!guard.allowed) throw new Error("Hulane Git gate: " + guard.reason);
    });
    await ctx.tool.hook("execute.before", (event) => {
      if (!["edit", "write", "apply_patch"].includes(event.tool)) return;
      const data = event.input ?? {};
      const filePath = data.file_path ?? data.filePath ?? data.path ?? "";
      if (!filePath) return;
      const checked = evaluateDisciplineEdit({ filePath: path.isAbsolute(filePath) ? filePath : path.join(ctx.location.directory, filePath) });
      if (!checked.allowed) throw new Error("Hulane config protection: " + checked.reason);
    });
  },
});

import { Plugin } from "@opencode/plugin";
import { evaluateCommand } from "../../hulane/hooks/guard.mjs";
import { evaluateDisciplineBash, evaluateDisciplineEdit } from "../../hulane/scripts/lib/discipline.mjs";

// OpenCode V2 adapter. No ZCode lifecycle JSON is loaded here.
// The MCP state machine remains the authority; shell hooks are defense-in-depth.
export default Plugin.define({
  id: "hulane",
  async setup(ctx) {
    await ctx.shell.hook("create.before", (event) => {
      const command = String(event.command ?? "");
      const cwd = String(event.cwd ?? ctx.location.directory);
      const discipline = evaluateDisciplineBash({ command, cwd });
      if (!discipline.allowed) throw new Error("Hulane discipline: " + discipline.reason);
      const guard = evaluateCommand({
        command,
        cwd,
        token: event.env?.HULANE_AUTH_TOKEN,
        releaseTagToken: event.env?.HULANE_RELEASE_TAG_TOKEN,
        releasePushToken: event.env?.HULANE_RELEASE_PUSH_TOKEN,
      });
      if (!guard.allowed) throw new Error("Hulane Git gate: " + guard.reason);
    });
    await ctx.tool.hook("execute.before", (event) => {
      if (!["edit", "write", "apply_patch"].includes(event.tool)) return;
      const data = event.input ?? {};
      const filePath = data.file_path ?? data.filePath ?? data.path ?? "";
      if (!filePath) return;
      const checked = evaluateDisciplineEdit({ filePath });
      if (!checked.allowed) throw new Error("Hulane config protection: " + checked.reason);
    });
  },
});

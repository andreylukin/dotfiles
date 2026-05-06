import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";

export default function (pi: ExtensionAPI) {
  let pendingSkillContent: string | null = null;

  pi.on("input", async (event, _ctx) => {
    const text = event.text.trim();
    if (!text.startsWith("/")) return;

    const parts = text.slice(1).split(/\s+/, 2);
    const name = parts[0];
    const rest = text.slice(1 + name.length).trim();

    if (name.startsWith("skill:")) return;

    const commands = pi.getCommands();
    const skillCmd = commands.find(
      (c) => c.source === "skill" && c.name === `skill:${name}`
    );

    if (!skillCmd) return;

    try {
      const skillPath = skillCmd.sourceInfo.path;
      const content = await readFile(skillPath, "utf8");
      pendingSkillContent = content;
    } catch {
      return;
    }

    return { action: "transform" as const, text: rest || `Use the ${name} skill.` };
  });

  pi.on("before_agent_start", async (event, _ctx) => {
    if (!pendingSkillContent) return;

    const content = pendingSkillContent;
    pendingSkillContent = null;

    return {
      message: {
        customType: "skill-context",
        content,
        display: false,
      },
    };
  });
}

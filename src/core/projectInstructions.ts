import { promises as fs } from "node:fs";
import path from "node:path";

const LIVE_VERIFICATION_SECTION = `## Live Verification

If you change user-facing behavior, content, styling, configuration, or deployment-related code, you must verify that the change is actually live before declaring the task done.

Required workflow:
1. Determine how this project goes live in production or preview.
2. If a deploy/build/restart is required, perform it.
3. Verify the live result through the real served app, not only local files.
4. Report exactly what URL/environment was checked and what was observed.
5. If you cannot verify the live result, explicitly say so and explain what is still missing.

Never claim success based only on file edits.
`;

async function upsertInstructionFile(filePath: string): Promise<void> {
  let current = "";
  try {
    current = await fs.readFile(filePath, "utf8");
  } catch {
    current = "";
  }

  if (current.includes("## Live Verification")) {
    return;
  }

  const trimmed = current.trimEnd();
  const next = trimmed ? `${trimmed}\n\n${LIVE_VERIFICATION_SECTION}\n` : `${LIVE_VERIFICATION_SECTION}\n`;
  await fs.writeFile(filePath, next, "utf8");
}

export async function ensureProjectInstructionFiles(projectRoot: string): Promise<void> {
  await upsertInstructionFile(path.join(projectRoot, "AGENTS.md"));
  await upsertInstructionFile(path.join(projectRoot, "CLAUDE.md"));
}

export { LIVE_VERIFICATION_SECTION };

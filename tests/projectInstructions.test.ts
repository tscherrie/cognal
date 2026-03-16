import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ensureProjectInstructionFiles, LIVE_VERIFICATION_SECTION } from "../src/core/projectInstructions.js";

describe("ensureProjectInstructionFiles", () => {
  let tempDir: string | null = null;

  afterEach(async () => {
    if (tempDir) {
      await rm(tempDir, { recursive: true, force: true });
      tempDir = null;
    }
  });

  it("creates AGENTS.md and CLAUDE.md when missing", async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), "cognal-instructions-"));
    await ensureProjectInstructionFiles(tempDir);

    const agents = await readFile(path.join(tempDir, "AGENTS.md"), "utf8");
    const claude = await readFile(path.join(tempDir, "CLAUDE.md"), "utf8");

    expect(agents).toContain(LIVE_VERIFICATION_SECTION.trim());
    expect(claude).toContain(LIVE_VERIFICATION_SECTION.trim());
  });

  it("appends the section once to existing files", async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), "cognal-instructions-"));
    const agentsPath = path.join(tempDir, "AGENTS.md");
    const claudePath = path.join(tempDir, "CLAUDE.md");

    await writeFile(agentsPath, "# Existing Agents\n", "utf8");
    await writeFile(claudePath, "# Existing Claude\n", "utf8");

    await ensureProjectInstructionFiles(tempDir);
    await ensureProjectInstructionFiles(tempDir);

    const agents = await readFile(agentsPath, "utf8");
    const claude = await readFile(claudePath, "utf8");

    expect(agents.match(/## Live Verification/g)?.length ?? 0).toBe(1);
    expect(claude.match(/## Live Verification/g)?.length ?? 0).toBe(1);
  });
});

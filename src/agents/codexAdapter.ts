import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { AgentType, AgentOutput } from "../types.js";
import { runCommand } from "../core/utils.js";
import { createLogicalProcess, extractSessionRef, type AgentAdapter, type AgentStartOptions, type RunningAgent } from "./agentAdapter.js";

export class CodexAdapter implements AgentAdapter {
  readonly type: AgentType = "codex";
  private resumeSupport: boolean | null = null;

  constructor(private readonly command: string, private readonly baseArgs: string[] = []) {}

  async start(options: AgentStartOptions): Promise<RunningAgent> {
    const supportsResume = await this.supportsResume();
    return {
      agent: this.type,
      userId: options.userId,
      process: createLogicalProcess(),
      sessionRef: options.fresh ? null : options.sessionRef,
      outputBuffer: "",
      startMode: !options.fresh && Boolean(options.sessionRef) && supportsResume ? "resume" : "fresh"
    };
  }

  async send(runtime: RunningAgent, input: string, _idleMs: number, timeoutMs: number): Promise<AgentOutput> {
    const lastMessagePath = path.join(os.tmpdir(), `cognal-codex-last-${randomUUID()}.txt`);
    try {
      const trimmedInput = input.trim();
      let result;
      if (runtime.startMode === "resume" && runtime.sessionRef) {
        result = await this.runCodex([...this.baseArgs, "exec", "resume", runtime.sessionRef, "--output-last-message", lastMessagePath, trimmedInput], timeoutMs);
        if (result.code !== 0) {
          runtime.startMode = "fresh";
        }
      }

      if (!result || result.code !== 0) {
        result = await this.runCodex([...this.baseArgs, "exec", "--output-last-message", lastMessagePath, trimmedInput], timeoutMs);
      }

      let lastMessage = "";
      try {
        lastMessage = (await fs.readFile(lastMessagePath, "utf8")).trim();
      } catch {
        lastMessage = "";
      }

      if (result.code !== 0) {
        const detail = (result.stderr || result.stdout || lastMessage || "no output").trim();
        throw new Error(`codex exec failed (${result.code}): ${detail}`);
      }

      const text = lastMessage || result.stdout.trim();
      const sessionRef = extractSessionRef(`${result.stdout}\n${result.stderr}`) ?? runtime.sessionRef;
      runtime.sessionRef = sessionRef;
      runtime.startMode = sessionRef ? "resume" : "fresh";
      runtime.outputBuffer += text;
      return {
        text,
        sessionRef
      };
    } finally {
      try {
        await fs.unlink(lastMessagePath);
      } catch {
        // ignore
      }
    }
  }

  async stop(runtime: RunningAgent): Promise<string | null> {
    runtime.process.kill("SIGTERM");
    return runtime.sessionRef;
  }

  private async supportsResume(): Promise<boolean> {
    if (this.resumeSupport !== null) {
      return this.resumeSupport;
    }

    const probe = await runCommand(this.command, ["exec", "resume", "--help"], {
      timeoutMs: 5_000,
      env: process.env
    });
    const output = `${probe.stdout}\n${probe.stderr}`;
    this.resumeSupport = /Usage:\s+codex\s+exec\s+resume\b/i.test(output);
    return this.resumeSupport;
  }

  private async runCodex(args: string[], timeoutMs: number) {
    return await runCommand(this.command, args, {
      timeoutMs,
      env: process.env
    });
  }
}

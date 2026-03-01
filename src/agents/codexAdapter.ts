import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { AgentType, AgentOutput } from "../types.js";
import { runCommand } from "../core/utils.js";
import type { AgentAdapter, AgentStartOptions, RunningAgent } from "./agentAdapter.js";

function createHolderProcess(): ChildProcessWithoutNullStreams {
  return spawn("bash", ["-lc", "sleep 2147483647"], {
    stdio: "pipe",
    env: process.env
  });
}

export class CodexAdapter implements AgentAdapter {
  readonly type: AgentType = "codex";

  constructor(private readonly command: string, private readonly baseArgs: string[] = []) {}

  async start(options: AgentStartOptions): Promise<RunningAgent> {
    const proc = createHolderProcess();
    return {
      agent: this.type,
      userId: options.userId,
      process: proc,
      sessionRef: options.fresh ? null : options.sessionRef,
      outputBuffer: ""
    };
  }

  async send(runtime: RunningAgent, input: string, _idleMs: number, timeoutMs: number): Promise<AgentOutput> {
    const lastMessagePath = path.join(os.tmpdir(), `cognal-codex-last-${randomUUID()}.txt`);
    try {
      const args = [...this.baseArgs, "exec", "--output-last-message", lastMessagePath, input];
      const result = await runCommand(this.command, args, {
        timeoutMs,
        env: process.env
      });

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
      runtime.outputBuffer += text;
      return {
        text,
        sessionRef: runtime.sessionRef
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
    const proc = runtime.process;
    if (proc.exitCode === null && !proc.killed) {
      try {
        proc.kill("SIGTERM");
      } catch {
        // ignore
      }
    }
    return runtime.sessionRef;
  }
}

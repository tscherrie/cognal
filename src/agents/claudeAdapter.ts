import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
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

export class ClaudeAdapter implements AgentAdapter {
  readonly type: AgentType = "claude";

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
    const sessionRef = runtime.sessionRef ?? randomUUID();
    const args = [...this.baseArgs, "--print", "--session-id", sessionRef, input];
    const result = await runCommand(this.command, args, {
      timeoutMs,
      env: process.env
    });

    if (result.code !== 0) {
      const detail = (result.stderr || result.stdout || "no output").trim();
      throw new Error(`claude --print failed (${result.code}): ${detail}`);
    }

    runtime.sessionRef = sessionRef;
    runtime.outputBuffer += result.stdout;

    return {
      text: result.stdout.trim(),
      sessionRef
    };
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

import { randomUUID } from "node:crypto";
import type { AgentType, AgentOutput } from "../types.js";
import { runCommand } from "../core/utils.js";
import { createLogicalProcess, extractSessionRef, type AgentAdapter, type AgentStartOptions, type RunningAgent } from "./agentAdapter.js";

export class ClaudeAdapter implements AgentAdapter {
  readonly type: AgentType = "claude";

  constructor(private readonly command: string, private readonly baseArgs: string[] = []) {}

  async start(options: AgentStartOptions): Promise<RunningAgent> {
    return {
      agent: this.type,
      userId: options.userId,
      process: createLogicalProcess(),
      sessionRef: options.fresh ? null : options.sessionRef,
      outputBuffer: "",
      startMode: options.fresh || !options.sessionRef ? "fresh" : "resume"
    };
  }

  async send(runtime: RunningAgent, input: string, _idleMs: number, timeoutMs: number): Promise<AgentOutput> {
    const trimmedInput = input.trim();
    const attemptResume = runtime.startMode === "resume" && Boolean(runtime.sessionRef);

    if (attemptResume && runtime.sessionRef) {
      const resumed = await this.runClaude([...this.baseArgs, "--print", "--resume", runtime.sessionRef, trimmedInput], timeoutMs);
      if (resumed.code === 0) {
        const resumedRef = extractSessionRef(`${resumed.stdout}\n${resumed.stderr}`) ?? runtime.sessionRef;
        runtime.sessionRef = resumedRef;
        runtime.startMode = "resume";
        runtime.outputBuffer += resumed.stdout;
        return {
          text: resumed.stdout.trim(),
          sessionRef: resumedRef
        };
      }
    }

    const sessionRef = randomUUID();
    const fresh = await this.runClaude([...this.baseArgs, "--print", "--session-id", sessionRef, trimmedInput], timeoutMs);
    if (fresh.code !== 0) {
      const detail = (fresh.stderr || fresh.stdout || "no output").trim();
      throw new Error(`claude --print failed (${fresh.code}): ${detail}`);
    }

    const finalSessionRef = extractSessionRef(`${fresh.stdout}\n${fresh.stderr}`) ?? sessionRef;
    runtime.sessionRef = finalSessionRef;
    runtime.startMode = "resume";
    runtime.outputBuffer += fresh.stdout;

    return {
      text: fresh.stdout.trim(),
      sessionRef: finalSessionRef
    };
  }

  async stop(runtime: RunningAgent): Promise<string | null> {
    runtime.process.kill("SIGTERM");
    return runtime.sessionRef;
  }

  private async runClaude(args: string[], timeoutMs: number) {
    return await runCommand(this.command, args, {
      timeoutMs,
      env: process.env
    });
  }
}

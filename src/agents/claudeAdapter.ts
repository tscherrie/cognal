import { randomUUID } from "node:crypto";
import { query } from "@anthropic-ai/claude-agent-sdk";
import type { AgentType, AgentOutput } from "../types.js";
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
    const sessionRef = runtime.startMode === "resume" && runtime.sessionRef ? runtime.sessionRef : randomUUID();
    const projectRoot = process.env.COGNAL_PROJECT_ROOT || process.cwd();
    let timedOut = false;

    let finalText = "";
    let finalSessionRef: string | null = runtime.sessionRef ?? sessionRef;
    let resultError = "";
    const runner = query({
      prompt: trimmedInput,
      options: {
        cwd: projectRoot,
        env: process.env,
        pathToClaudeCodeExecutable: this.command,
        resume: runtime.startMode === "resume" && runtime.sessionRef ? runtime.sessionRef : undefined,
        sessionId: runtime.startMode === "resume" && runtime.sessionRef ? undefined : sessionRef,
        permissionMode: "bypassPermissions",
        allowDangerouslySkipPermissions: true
      }
    });
    const timeoutHandle =
      timeoutMs > 0
        ? setTimeout(() => {
            timedOut = true;
            runner.close();
          }, timeoutMs)
        : null;

    try {
      for await (const message of runner) {
        if (typeof message === "object" && message && "session_id" in message && typeof message.session_id === "string") {
          finalSessionRef = message.session_id;
        }
        if (typeof message === "object" && message && "type" in message && message.type === "result") {
          if ("subtype" in message && message.subtype === "success" && typeof message.result === "string") {
            finalText = message.result.trim();
          } else if ("errors" in message && Array.isArray(message.errors)) {
            resultError = message.errors.join("; ").trim();
          }
        }
      }
    } catch (err) {
      if (timedOut) {
        throw new Error("claude sdk query failed: Timed out");
      }
      throw new Error(`claude sdk query failed: ${String(err)}`);
    } finally {
      if (timeoutHandle) {
        clearTimeout(timeoutHandle);
      }
      runner.close();
    }

    if (timedOut) {
      throw new Error("claude sdk query failed: Timed out");
    }
    if (resultError) {
      throw new Error(`claude sdk query failed: ${resultError}`);
    }
    if (!finalText) {
      throw new Error("No output from claude");
    }

    runtime.sessionRef = finalSessionRef;
    runtime.startMode = "resume";
    runtime.outputBuffer += finalText;

    return {
      text: finalText,
      sessionRef: finalSessionRef
    };
  }

  async stop(runtime: RunningAgent): Promise<string | null> {
    runtime.process.kill("SIGTERM");
    return runtime.sessionRef;
  }
}

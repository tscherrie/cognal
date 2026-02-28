import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { Logger } from "../core/logger.js";
import type { AgentOutput, AgentType } from "../types.js";

export interface RunningAgent {
  agent: AgentType;
  userId: string;
  process: ChildProcessWithoutNullStreams;
  sessionRef: string | null;
  outputBuffer: string;
}

export interface AgentStartOptions {
  userId: string;
  sessionRef: string | null;
  fresh?: boolean;
}

export interface AgentAdapter {
  type: AgentType;
  start(options: AgentStartOptions): Promise<RunningAgent>;
  send(runtime: RunningAgent, input: string, idleMs: number, timeoutMs: number): Promise<AgentOutput>;
  stop(runtime: RunningAgent): Promise<string | null>;
}

const SESSION_ID_REGEX = [
  /session(?:\s+id)?\s*[:=]\s*([a-zA-Z0-9_-]+)/i,
  /\b([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\b/i
];

export abstract class BaseCliAgentAdapter implements AgentAdapter {
  abstract readonly type: AgentType;
  protected readonly logger: Logger;

  constructor(protected readonly command: string, protected readonly baseArgs: string[] = []) {
    this.logger = new Logger("agent");
  }

  protected abstract buildStartArgs(sessionRef: string | null, fresh: boolean): Promise<string[]>;

  async start(options: AgentStartOptions): Promise<RunningAgent> {
    const args = await this.buildStartArgs(options.sessionRef, options.fresh ?? false);
    const proc = spawn(this.command, [...this.baseArgs, ...args], {
      stdio: "pipe",
      env: process.env
    });

    let outputBuffer = "";
    proc.stdout.on("data", (chunk) => {
      outputBuffer += String(chunk);
    });
    proc.stderr.on("data", (chunk) => {
      outputBuffer += String(chunk);
    });

    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => resolve(), 1200);
      proc.once("error", (err) => {
        clearTimeout(timer);
        reject(err);
      });
      proc.once("spawn", () => {
        clearTimeout(timer);
        resolve();
      });
      proc.once("exit", (code) => {
        clearTimeout(timer);
        if ((code ?? 0) !== 0) {
          reject(new Error(`${this.command} exited during startup: ${outputBuffer}`));
        } else {
          resolve();
        }
      });
    });

    return {
      agent: this.type,
      userId: options.userId,
      process: proc,
      sessionRef: options.sessionRef,
      outputBuffer
    };
  }

  async send(runtime: RunningAgent, input: string, idleMs: number, timeoutMs: number): Promise<AgentOutput> {
    const processRef = runtime.process;
    const before = runtime.outputBuffer.length;

    return await new Promise<AgentOutput>((resolve, reject) => {
      let done = false;
      let idleTimer: NodeJS.Timeout | null = null;
      let hardTimer: NodeJS.Timeout | null = null;
      let hadOutput = false;

      const finish = (error?: Error): void => {
        if (done) {
          return;
        }
        done = true;
        if (idleTimer) {
          clearTimeout(idleTimer);
        }
        if (hardTimer) {
          clearTimeout(hardTimer);
        }

        processRef.stdout.off("data", onData);
        processRef.stderr.off("data", onData);
        processRef.off("exit", onExit);

        if (error) {
          reject(error);
          return;
        }

        const raw = runtime.outputBuffer.slice(before).trim();
        const text = raw.length > 0 ? raw : "";
        const extracted = extractSessionRef(runtime.outputBuffer) ?? runtime.sessionRef;
        runtime.sessionRef = extracted;
        resolve({ text, sessionRef: extracted });
      };

      const armIdle = (): void => {
        if (idleTimer) {
          clearTimeout(idleTimer);
        }
        idleTimer = setTimeout(() => {
          if (!hadOutput) {
            finish(new Error(`No output from ${runtime.agent}`));
            return;
          }
          finish();
        }, idleMs);
      };

      const onData = (chunk: Buffer | string): void => {
        runtime.outputBuffer += String(chunk);
        hadOutput = true;
        armIdle();
      };

      const onExit = (code: number | null): void => {
        finish(new Error(`${runtime.agent} process exited unexpectedly (${code ?? "unknown"})`));
      };

      processRef.stdout.on("data", onData);
      processRef.stderr.on("data", onData);
      processRef.on("exit", onExit);

      hardTimer = setTimeout(() => finish(new Error(`${runtime.agent} timed out`)), timeoutMs);
      armIdle();

      processRef.stdin.write(`${input.trimEnd()}\n`);
    });
  }

  async stop(runtime: RunningAgent): Promise<string | null> {
    const proc = runtime.process;
    if (proc.killed || proc.exitCode !== null) {
      return runtime.sessionRef;
    }

    try {
      proc.stdin.write("/exit\n");
    } catch {
      // no-op
    }

    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        try {
          proc.kill("SIGTERM");
        } catch {
          // no-op
        }
      }, 1500);

      proc.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });

      setTimeout(() => {
        try {
          proc.kill("SIGKILL");
        } catch {
          // no-op
        }
        resolve();
      }, 3500);
    });

    return extractSessionRef(runtime.outputBuffer) ?? runtime.sessionRef;
  }
}

function extractSessionRef(buffer: string): string | null {
  for (const regex of SESSION_ID_REGEX) {
    const matches = buffer.match(regex);
    if (matches?.[1]) {
      return matches[1];
    }
  }
  return null;
}

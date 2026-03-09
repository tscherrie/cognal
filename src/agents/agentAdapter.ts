import { Logger } from "../core/logger.js";
import type { AgentOutput, AgentType } from "../types.js";

export interface RuntimeProcess {
  pid: number | null;
  exitCode: number | null;
  killed: boolean;
  kill(signal?: NodeJS.Signals | number): boolean;
}

export interface RunningAgent {
  agent: AgentType;
  userId: string;
  process: RuntimeProcess;
  sessionRef: string | null;
  outputBuffer: string;
  startMode: "fresh" | "resume";
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

export function createLogicalProcess(): RuntimeProcess {
  return {
    pid: null,
    exitCode: null,
    killed: false,
    kill(): boolean {
      this.killed = true;
      this.exitCode = 0;
      return true;
    }
  };
}

export function extractSessionRef(buffer: string): string | null {
  for (const regex of SESSION_ID_REGEX) {
    const matches = buffer.match(regex);
    if (matches?.[1]) {
      return matches[1];
    }
  }
  return null;
}

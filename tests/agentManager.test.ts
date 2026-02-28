import { describe, expect, it } from "vitest";
import { EventEmitter } from "node:events";
import type { AgentType } from "../src/types.js";
import type { AgentAdapter, RunningAgent } from "../src/agents/agentAdapter.js";
import { AgentManager } from "../src/agents/manager.js";

class FakeDb {
  binding = {
    userId: "u1",
    activeAgent: "codex" as AgentType,
    claudeSessionRef: null as string | null,
    codexSessionRef: null as string | null,
    updatedAt: new Date().toISOString()
  };

  async getBinding(): Promise<typeof this.binding> {
    return { ...this.binding };
  }

  async setActiveAgent(_userId: string, agent: AgentType): Promise<void> {
    this.binding.activeAgent = agent;
  }

  async updateSessionRef(_userId: string, agent: AgentType, ref: string): Promise<void> {
    if (agent === "claude") {
      this.binding.claudeSessionRef = ref;
    } else {
      this.binding.codexSessionRef = ref;
    }
  }

  async setRuntimePid(): Promise<void> {}
  async clearRuntimePid(): Promise<void> {}
}

function fakeRuntime(agent: AgentType): RunningAgent {
  const stdout = new EventEmitter() as any;
  const stderr = new EventEmitter() as any;
  const proc: any = {
    pid: Math.floor(Math.random() * 10000),
    stdout,
    stderr,
    stdin: {
      write: () => true
    },
    exitCode: null,
    killed: false
  };

  return {
    agent,
    userId: "u1",
    process: proc,
    sessionRef: null,
    outputBuffer: ""
  };
}

class FakeAdapter implements AgentAdapter {
  starts = 0;
  stops = 0;
  sends = 0;

  constructor(public readonly type: AgentType, private readonly behavior: {
    failSend?: boolean;
    sendText?: string;
  } = {}) {}

  async start(): Promise<RunningAgent> {
    this.starts += 1;
    return fakeRuntime(this.type);
  }

  async send(_runtime: RunningAgent, _input: string): Promise<{ text: string; sessionRef?: string | null }> {
    this.sends += 1;
    if (this.behavior.failSend) {
      throw new Error(`send failure ${this.type}`);
    }
    return {
      text: this.behavior.sendText ?? `${this.type}-ok`,
      sessionRef: `${this.type}-session`
    };
  }

  async stop(): Promise<string | null> {
    this.stops += 1;
    return `${this.type}-session`;
  }
}

describe("AgentManager", () => {
  it("enforces single active runtime on switch", async () => {
    const db = new FakeDb();
    const codex = new FakeAdapter("codex");
    const claude = new FakeAdapter("claude");

    const manager = new AgentManager(
      db as any,
      { codex, claude },
      { failoverEnabled: true, agentResponseSec: 10, agentIdleMs: 10, defaultAgent: "codex" }
    );

    await manager.switchAgent("u1", "codex");
    await manager.switchAgent("u1", "claude");

    expect(codex.starts).toBe(1);
    expect(codex.stops).toBe(1);
    expect(claude.starts).toBe(1);
    expect(db.binding.activeAgent).toBe("claude");
  });

  it("fails over to alternate agent when active send fails", async () => {
    const db = new FakeDb();
    db.binding.activeAgent = "codex";

    const codex = new FakeAdapter("codex", { failSend: true });
    const claude = new FakeAdapter("claude", { sendText: "fallback-response" });

    const manager = new AgentManager(
      db as any,
      { codex, claude },
      { failoverEnabled: true, agentResponseSec: 10, agentIdleMs: 10, defaultAgent: "codex" }
    );

    const output = await manager.sendToActive("u1", "hello");

    expect(output.text).toContain("Failover -> claude");
    expect(output.text).toContain("fallback-response");
    expect(db.binding.activeAgent).toBe("claude");
  });

  it("rejects switching to disabled provider", async () => {
    const db = new FakeDb();
    const codex = new FakeAdapter("codex");
    const manager = new AgentManager(
      db as any,
      { codex },
      { failoverEnabled: false, agentResponseSec: 10, agentIdleMs: 10, defaultAgent: "codex" }
    );

    await expect(manager.switchAgent("u1", "claude")).rejects.toThrow("disabled");
  });
});

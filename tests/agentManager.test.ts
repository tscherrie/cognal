import { describe, expect, it } from "vitest";
import type { AgentType } from "../src/types.js";
import type { AgentAdapter, AgentStartOptions, RunningAgent } from "../src/agents/agentAdapter.js";
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
  const proc: any = {
    pid: null,
    exitCode: null,
    killed: false,
    kill() {
      this.killed = true;
      this.exitCode = 0;
      return true;
    }
  };

  return {
    agent,
    userId: "u1",
    process: proc,
    sessionRef: null,
    outputBuffer: "",
    startMode: "fresh"
  };
}

class FakeAdapter implements AgentAdapter {
  starts = 0;
  stops = 0;
  sends = 0;
  startOptions: AgentStartOptions[] = [];

  constructor(public readonly type: AgentType, private readonly behavior: {
    failStart?: boolean;
    failSend?: boolean;
    sendText?: string;
    sessionRef?: string | null;
  } = {}) {}

  async start(options: AgentStartOptions): Promise<RunningAgent> {
    this.starts += 1;
    this.startOptions.push({ ...options });
    if (this.behavior.failStart && !options.fresh) {
      throw new Error(`resume start failure ${this.type}`);
    }
    const runtime = fakeRuntime(this.type);
    runtime.sessionRef = options.fresh ? null : options.sessionRef;
    runtime.startMode = options.fresh || !options.sessionRef ? "fresh" : "resume";
    return runtime;
  }

  async send(_runtime: RunningAgent, _input: string): Promise<{ text: string; sessionRef?: string | null }> {
    this.sends += 1;
    if (this.behavior.failSend) {
      throw new Error(`send failure ${this.type}`);
    }
    return {
      text: this.behavior.sendText ?? `${this.type}-ok`,
      sessionRef: this.behavior.sessionRef ?? `${this.type}-session`
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

  it("starts with persisted session refs when switching back", async () => {
    const db = new FakeDb();
    db.binding.codexSessionRef = "codex-prev";
    db.binding.claudeSessionRef = "claude-prev";

    const codex = new FakeAdapter("codex");
    const claude = new FakeAdapter("claude");

    const manager = new AgentManager(
      db as any,
      { codex, claude },
      { failoverEnabled: true, agentResponseSec: 10, agentIdleMs: 10, defaultAgent: "codex" }
    );

    await manager.switchAgent("u1", "claude");
    await manager.switchAgent("u1", "codex");

    expect(claude.startOptions[0]).toMatchObject({ sessionRef: "claude-prev", fresh: false });
    expect(codex.startOptions[0]).toMatchObject({ sessionRef: "codex-prev", fresh: false });
  });

  it("retries fresh start when resume start fails", async () => {
    const db = new FakeDb();
    db.binding.claudeSessionRef = "claude-prev";

    const claude = new FakeAdapter("claude", { failStart: true });
    const manager = new AgentManager(
      db as any,
      { claude },
      { failoverEnabled: false, agentResponseSec: 10, agentIdleMs: 10, defaultAgent: "claude" }
    );

    await manager.switchAgent("u1", "claude");

    expect(claude.startOptions).toEqual([
      { userId: "u1", sessionRef: "claude-prev", fresh: false },
      { userId: "u1", sessionRef: null, fresh: true }
    ]);
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

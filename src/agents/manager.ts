import { Logger } from "../core/logger.js";
import { otherAgent } from "../core/router.js";
import type { Db } from "../core/db.js";
import type { AgentOutput, AgentType } from "../types.js";
import type { AgentAdapter, RunningAgent } from "./agentAdapter.js";

interface ManagerOptions {
  failoverEnabled: boolean;
  agentResponseSec: number;
  agentIdleMs: number;
  defaultAgent: AgentType;
}

export class AgentManager {
  private readonly logger = new Logger("agent-manager");
  private readonly runtimes = new Map<string, RunningAgent>();

  constructor(
    private readonly db: Db,
    private readonly adapters: Partial<Record<AgentType, AgentAdapter>>,
    private readonly options: ManagerOptions
  ) {}

  async switchAgent(userId: string, target: AgentType): Promise<void> {
    this.requireAdapter(target);
    const binding = await this.db.getBinding(userId, this.options.defaultAgent);
    const current = this.runtimes.get(userId);

    if (current && current.agent === target) {
      return;
    }

    if (current) {
      const stoppedRef = await this.stopRuntime(current);
      if (stoppedRef) {
        await this.db.updateSessionRef(userId, current.agent, stoppedRef);
      }
      this.runtimes.delete(userId);
    }

    await this.db.setActiveAgent(userId, target);
    const updatedBinding = await this.db.getBinding(userId, this.options.defaultAgent);
    const runtime = await this.startForBinding(userId, target, updatedBinding);
    this.runtimes.set(userId, runtime);
    this.logger.info("switched active agent", { userId, target });
  }

  async sendToActive(userId: string, input: string): Promise<AgentOutput> {
    const binding = await this.db.getBinding(userId, this.options.defaultAgent);
    const activeAgent = this.ensureAgentEnabled(binding.activeAgent);
    if (activeAgent !== binding.activeAgent) {
      await this.db.setActiveAgent(userId, activeAgent);
    }
    const runtime = await this.ensureRuntime(userId, activeAgent, binding);

    try {
      const output = await this.requireAdapter(runtime.agent).send(
        runtime,
        input,
        this.options.agentIdleMs,
        this.options.agentResponseSec * 1000
      );
      if (output.sessionRef) {
        await this.db.updateSessionRef(userId, runtime.agent, output.sessionRef);
      }
      return output;
    } catch (err) {
      await this.db.clearRuntimePid(userId, runtime.agent, String(err));
      this.logger.error("active agent failed", {
        userId,
        agent: runtime.agent,
        error: String(err)
      });
      this.runtimes.delete(userId);

      if (!this.options.failoverEnabled) {
        throw err;
      }

      const fallbackAgent = otherAgent(runtime.agent);
      if (!this.adapters[fallbackAgent]) {
        throw err;
      }
      await this.db.setActiveAgent(userId, fallbackAgent);
      const fallbackBinding = await this.db.getBinding(userId, this.options.defaultAgent);
      const fallbackRuntime = await this.ensureRuntime(userId, fallbackAgent, fallbackBinding);
      const handoffInput = [
        "[Automatic failover from previous agent due to runtime error.]",
        "Continue from this latest user request:",
        input
      ].join("\n\n");

      const output = await this.requireAdapter(fallbackRuntime.agent).send(
        fallbackRuntime,
        handoffInput,
        this.options.agentIdleMs,
        this.options.agentResponseSec * 1000
      );
      if (output.sessionRef) {
        await this.db.updateSessionRef(userId, fallbackRuntime.agent, output.sessionRef);
      }
      return {
        text: `[Failover -> ${fallbackAgent}]\n\n${output.text}`,
        sessionRef: output.sessionRef
      };
    }
  }

  async shutdownAll(): Promise<void> {
    const entries = [...this.runtimes.values()];
    for (const runtime of entries) {
      const sessionRef = await this.stopRuntime(runtime);
      if (sessionRef) {
        await this.db.updateSessionRef(runtime.userId, runtime.agent, sessionRef);
      }
      await this.db.clearRuntimePid(runtime.userId, runtime.agent);
      this.runtimes.delete(runtime.userId);
    }
  }

  private async ensureRuntime(userId: string, agent: AgentType, binding: Awaited<ReturnType<Db["getBinding"]>>): Promise<RunningAgent> {
    this.requireAdapter(agent);
    const existing = this.runtimes.get(userId);
    if (existing && existing.agent === agent && existing.process.exitCode === null) {
      return existing;
    }

    if (existing) {
      const stoppedRef = await this.stopRuntime(existing);
      if (stoppedRef) {
        await this.db.updateSessionRef(userId, existing.agent, stoppedRef);
      }
      this.runtimes.delete(userId);
    }

    const runtime = await this.startForBinding(userId, agent, binding);
    this.runtimes.set(userId, runtime);
    return runtime;
  }

  private async startForBinding(
    userId: string,
    agent: AgentType,
    binding: Awaited<ReturnType<Db["getBinding"]>>
  ): Promise<RunningAgent> {
    const adapter = this.requireAdapter(agent);
    const sessionRef = agent === "claude" ? binding.claudeSessionRef : binding.codexSessionRef;

    try {
      const runtime = await adapter.start({ userId, sessionRef, fresh: false });
      await this.db.setRuntimePid(userId, agent, runtime.process.pid ?? -1);
      return runtime;
    } catch (resumeErr) {
      this.logger.warn("resume start failed, retrying fresh", {
        userId,
        agent,
        error: String(resumeErr)
      });
      const runtime = await adapter.start({ userId, sessionRef: null, fresh: true });
      await this.db.setRuntimePid(userId, agent, runtime.process.pid ?? -1);
      return runtime;
    }
  }

  private async stopRuntime(runtime: RunningAgent): Promise<string | null> {
    const adapter = this.requireAdapter(runtime.agent);
    const sessionRef = await adapter.stop(runtime);
    await this.db.clearRuntimePid(runtime.userId, runtime.agent);
    return sessionRef;
  }

  private requireAdapter(agent: AgentType): AgentAdapter {
    const adapter = this.adapters[agent];
    if (!adapter) {
      throw new Error(`Agent '${agent}' is disabled on this host`);
    }
    return adapter;
  }

  private ensureAgentEnabled(agent: AgentType): AgentType {
    if (this.adapters[agent]) {
      return agent;
    }
    return this.options.defaultAgent;
  }
}

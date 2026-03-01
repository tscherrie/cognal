import { promises as fs } from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import TOML from "@iarna/toml";
import type { AgentType } from "./types.js";

export type ProviderSelection = "claude" | "codex" | "both";

export interface EnabledAgents {
  claude: boolean;
  codex: boolean;
}

export interface CognalConfig {
  projectId: string;
  runtime: {
    osMode: "linux";
    distro: "ubuntu" | "debian";
    serviceName: string;
  };
  telegram: {
    botTokenEnv: string;
    botUsername?: string;
    receiveTimeoutSec: number;
    allowGroups: boolean;
  };
  agents: {
    enabled: EnabledAgents;
    claude: {
      command: string;
      args: string[];
    };
    codex: {
      command: string;
      args: string[];
    };
  };
  routing: {
    failoverEnabled: boolean;
    responseChunkSize: number;
  };
  stt: {
    provider: "openai";
    model: "whisper-1";
    apiKeyEnv: string;
  };
  retention: {
    attachmentsHours: number;
  };
  timeouts: {
    agentResponseSec: number;
    failoverRetrySec: number;
    agentIdleMs: number;
  };
}

export interface RuntimePaths {
  projectRoot: string;
  cognalDir: string;
  dbPath: string;
  configPath: string;
  tempDir: string;
  logsDir: string;
  telegramOffsetPath: string;
  pidPath: string;
}

export function getRuntimePaths(projectRoot: string): RuntimePaths {
  const cognalDir = path.join(projectRoot, ".cognal");
  return {
    projectRoot,
    cognalDir,
    dbPath: path.join(cognalDir, "cognal.db"),
    configPath: path.join(cognalDir, "config.toml"),
    tempDir: path.join(cognalDir, "tmp"),
    logsDir: path.join(cognalDir, "logs"),
    telegramOffsetPath: path.join(cognalDir, "telegram.offset"),
    pidPath: path.join(cognalDir, "cognald.pid")
  };
}

function slugify(input: string): string {
  const out = input.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return out || "project";
}

export function computeServiceName(projectRoot: string, projectId?: string): string {
  const id = slugify(projectId ?? path.basename(projectRoot));
  const hash = createHash("sha1").update(projectRoot).digest("hex").slice(0, 8);
  return `cognald-${id}-${hash}`;
}

export function defaultConfig(projectRoot: string): CognalConfig {
  const projectId = path.basename(projectRoot);
  return {
    projectId,
    runtime: {
      osMode: "linux",
      distro: "ubuntu",
      serviceName: computeServiceName(projectRoot, projectId)
    },
    telegram: {
      botTokenEnv: "TELEGRAM_BOT_TOKEN",
      receiveTimeoutSec: 30,
      allowGroups: true
    },
    agents: {
      enabled: {
        claude: true,
        codex: true
      },
      claude: {
        command: "claude",
        args: []
      },
      codex: {
        command: "codex",
        args: []
      }
    },
    routing: {
      failoverEnabled: true,
      responseChunkSize: 3500
    },
    stt: {
      provider: "openai",
      model: "whisper-1",
      apiKeyEnv: "OPENAI_API_KEY"
    },
    retention: {
      attachmentsHours: 24
    },
    timeouts: {
      agentResponseSec: 240,
      failoverRetrySec: 30,
      agentIdleMs: 1500
    }
  };
}

export async function ensureRuntimeDirs(paths: RuntimePaths): Promise<void> {
  await fs.mkdir(paths.cognalDir, { recursive: true });
  await fs.mkdir(paths.tempDir, { recursive: true });
  await fs.mkdir(paths.logsDir, { recursive: true });
}

export async function loadConfig(paths: RuntimePaths): Promise<CognalConfig> {
  const raw = await fs.readFile(paths.configPath, "utf8");
  const parsed = TOML.parse(raw) as unknown as CognalConfig;
  return normalizeConfig(parsed, paths.projectRoot);
}

export async function saveConfig(paths: RuntimePaths, cfg: CognalConfig): Promise<void> {
  const raw = TOML.stringify(cfg as unknown as TOML.JsonMap);
  await fs.writeFile(paths.configPath, raw, "utf8");
}

export async function loadOrCreateConfig(paths: RuntimePaths): Promise<CognalConfig> {
  try {
    return await loadConfig(paths);
  } catch {
    const cfg = defaultConfig(paths.projectRoot);
    await saveConfig(paths, cfg);
    return cfg;
  }
}

export function normalizeConfig(cfg: CognalConfig, projectRoot = cfg.projectId): CognalConfig {
  const defaults = defaultConfig(projectRoot);
  const normalized = cfg as CognalConfig & {
    signal?: {
      receiveTimeoutSec?: number;
    };
  };

  normalized.projectId = normalized.projectId || defaults.projectId;
  normalized.runtime = normalized.runtime || defaults.runtime;
  normalized.runtime.osMode = "linux";
  normalized.runtime.distro = normalized.runtime.distro === "debian" ? "debian" : "ubuntu";
  if (!normalized.runtime.serviceName) {
    normalized.runtime.serviceName = computeServiceName(projectRoot, normalized.projectId);
  }

  if (!normalized.telegram) {
    const legacyReceive = normalized.signal?.receiveTimeoutSec;
    normalized.telegram = {
      botTokenEnv: "TELEGRAM_BOT_TOKEN",
      receiveTimeoutSec:
        typeof legacyReceive === "number" && legacyReceive > 0 ? legacyReceive : defaults.telegram.receiveTimeoutSec,
      allowGroups: true
    };
  }
  if (!normalized.telegram.botTokenEnv) {
    normalized.telegram.botTokenEnv = defaults.telegram.botTokenEnv;
  }
  if (!normalized.telegram.receiveTimeoutSec || normalized.telegram.receiveTimeoutSec <= 0) {
    normalized.telegram.receiveTimeoutSec = defaults.telegram.receiveTimeoutSec;
  }
  if (typeof normalized.telegram.allowGroups !== "boolean") {
    normalized.telegram.allowGroups = true;
  }

  if (!normalized.agents) {
    normalized.agents = defaults.agents;
  }
  if (!normalized.agents.enabled) {
    normalized.agents.enabled = { ...defaults.agents.enabled };
  }
  if (!normalized.agents.enabled.claude && !normalized.agents.enabled.codex) {
    normalized.agents.enabled.codex = true;
  }
  if (!normalized.agents.claude) {
    normalized.agents.claude = { ...defaults.agents.claude };
  }
  if (!normalized.agents.codex) {
    normalized.agents.codex = { ...defaults.agents.codex };
  }

  if (!normalized.routing) {
    normalized.routing = defaults.routing;
  }
  if (!normalized.routing.responseChunkSize || normalized.routing.responseChunkSize <= 0) {
    normalized.routing.responseChunkSize = defaults.routing.responseChunkSize;
  }

  if (!normalized.stt) {
    normalized.stt = defaults.stt;
  }
  if (!normalized.retention) {
    normalized.retention = defaults.retention;
  }
  if (!normalized.timeouts) {
    normalized.timeouts = defaults.timeouts;
  }
  if (!normalized.timeouts.agentIdleMs || normalized.timeouts.agentIdleMs <= 0) {
    normalized.timeouts.agentIdleMs = defaults.timeouts.agentIdleMs;
  }
  if (!normalized.timeouts.agentResponseSec || normalized.timeouts.agentResponseSec <= 0) {
    normalized.timeouts.agentResponseSec = defaults.timeouts.agentResponseSec;
  }
  if (!normalized.timeouts.failoverRetrySec || normalized.timeouts.failoverRetrySec <= 0) {
    normalized.timeouts.failoverRetrySec = defaults.timeouts.failoverRetrySec;
  }

  return normalized;
}

export function enabledFromProviderSelection(selection: ProviderSelection): EnabledAgents {
  if (selection === "claude") {
    return { claude: true, codex: false };
  }
  if (selection === "codex") {
    return { claude: false, codex: true };
  }
  return { claude: true, codex: true };
}

export function providerSelectionFromEnabled(enabled: EnabledAgents): ProviderSelection {
  if (enabled.claude && enabled.codex) {
    return "both";
  }
  if (enabled.claude) {
    return "claude";
  }
  return "codex";
}

export function getEnabledAgents(cfg: CognalConfig): AgentType[] {
  const out: AgentType[] = [];
  if (cfg.agents.enabled.claude) {
    out.push("claude");
  }
  if (cfg.agents.enabled.codex) {
    out.push("codex");
  }
  return out;
}

export function isAgentEnabled(cfg: CognalConfig, agent: AgentType): boolean {
  return cfg.agents.enabled[agent];
}

export function getDefaultAgent(cfg: CognalConfig): AgentType {
  if (cfg.agents.enabled.codex) {
    return "codex";
  }
  return "claude";
}

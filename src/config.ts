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
  signal: {
    command: string;
    dataDir: string;
    receiveTimeoutSec: number;
    account?: string;
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
  delivery: {
    modeDefault: "email" | "link" | "public_encrypted";
    resend: {
      apiKeyEnv: string;
      from: string;
    };
    storage: {
      endpoint?: string;
      region?: string;
      bucket?: string;
      accessKeyEnv?: string;
      secretKeyEnv?: string;
      publicBaseUrl?: string;
      presignedTtlSec: number;
    };
    publicDump: {
      endpoint: string;
      fileField: string;
      timeoutSec: number;
    };
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
  linksDir: string;
  logsDir: string;
  signalDir: string;
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
    linksDir: path.join(cognalDir, "links"),
    logsDir: path.join(cognalDir, "logs"),
    signalDir: path.join(cognalDir, "signal-cli"),
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
    signal: {
      command: "signal-cli",
      dataDir: path.join(projectRoot, ".cognal", "signal-cli"),
      receiveTimeoutSec: 5
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
      responseChunkSize: 3000
    },
    stt: {
      provider: "openai",
      model: "whisper-1",
      apiKeyEnv: "OPENAI_API_KEY"
    },
    delivery: {
      modeDefault: "public_encrypted",
      resend: {
        apiKeyEnv: "RESEND_API_KEY",
        from: "Cognal <noreply@example.com>"
      },
      storage: {
        presignedTtlSec: 900
      },
      publicDump: {
        endpoint: "https://0x0.st",
        fileField: "file",
        timeoutSec: 25
      }
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
  await fs.mkdir(paths.linksDir, { recursive: true });
  await fs.mkdir(paths.logsDir, { recursive: true });
  await fs.mkdir(paths.signalDir, { recursive: true });
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
  const normalized = cfg;
  if (!normalized.runtime.serviceName) {
    normalized.runtime.serviceName = computeServiceName(projectRoot, normalized.projectId);
  }
  if (!normalized.signal.dataDir) {
    normalized.signal.dataDir = path.join(projectRoot, ".cognal", "signal-cli");
  }
  if (!normalized.agents.enabled) {
    normalized.agents.enabled = { claude: true, codex: true };
  }
  if (!normalized.agents.enabled.claude && !normalized.agents.enabled.codex) {
    normalized.agents.enabled.codex = true;
  }

  if (!normalized.delivery.publicDump) {
    normalized.delivery.publicDump = {
      endpoint: "https://0x0.st",
      fileField: "file",
      timeoutSec: 25
    };
  }

  if (!normalized.delivery.modeDefault) {
    normalized.delivery.modeDefault = "public_encrypted";
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

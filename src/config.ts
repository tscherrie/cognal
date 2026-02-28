import { promises as fs } from "node:fs";
import path from "node:path";
import TOML from "@iarna/toml";

export interface CognalConfig {
  projectId: string;
  runtime: {
    osMode: "linux";
    distro: "ubuntu" | "debian";
  };
  signal: {
    command: string;
    dataDir: string;
    receiveTimeoutSec: number;
    account?: string;
  };
  agents: {
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
    modeDefault: "email" | "link";
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
    pidPath: path.join(cognalDir, "cognald.pid")
  };
}

export function defaultConfig(projectRoot: string): CognalConfig {
  const projectId = path.basename(projectRoot);
  return {
    projectId,
    runtime: {
      osMode: "linux",
      distro: "ubuntu"
    },
    signal: {
      command: "signal-cli",
      dataDir: "/var/lib/signal-cli",
      receiveTimeoutSec: 5
    },
    agents: {
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
      modeDefault: "email",
      resend: {
        apiKeyEnv: "RESEND_API_KEY",
        from: "Cognal <noreply@example.com>"
      },
      storage: {
        presignedTtlSec: 900
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
}

export async function loadConfig(paths: RuntimePaths): Promise<CognalConfig> {
  const raw = await fs.readFile(paths.configPath, "utf8");
  const parsed = TOML.parse(raw) as unknown as CognalConfig;
  return parsed;
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

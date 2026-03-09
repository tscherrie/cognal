#!/usr/bin/env node
import { promises as fs, constants as fsConstants } from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { loadOrCreateConfig, getRuntimePaths, ensureRuntimeDirs, getDefaultAgent, getEnabledAgents, isAgentEnabled } from "./config.js";
import { Db } from "./core/db.js";
import { Logger } from "./core/logger.js";
import { processInboundEvent, runAttachmentCleanup } from "./core/inbound.js";
import { TelegramBotAdapter } from "./adapters/telegramBotAdapter.js";
import { SttAdapter } from "./adapters/sttAdapter.js";
import { ClaudeAdapter } from "./agents/claudeAdapter.js";
import { CodexAdapter } from "./agents/codexAdapter.js";
import { AgentManager } from "./agents/manager.js";
import type { AgentType } from "./types.js";

const logger = new Logger("daemon");
const LOOP_ERROR_BACKOFF_BASE_MS = 1_000;
const LOOP_ERROR_BACKOFF_MAX_MS = 30_000;

interface BotLock {
  lockPath: string;
}

function isPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function acquireBotLock(botId: number, projectRoot: string): Promise<BotLock> {
  const lockPath = path.join(os.tmpdir(), `cognal-telegram-bot-${botId}.lock`);
  const payload = JSON.stringify({ pid: process.pid, projectRoot, ts: new Date().toISOString() });

  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      await fs.writeFile(lockPath, payload, { flag: "wx", mode: 0o600 });
      return { lockPath };
    } catch (err: unknown) {
      if (!(err instanceof Error) || !String(err.message).includes("EEXIST")) {
        throw err;
      }

      let existingPid = -1;
      let existingProjectRoot = "unknown";
      try {
        const raw = await fs.readFile(lockPath, "utf8");
        const parsed = JSON.parse(raw) as { pid?: number; projectRoot?: string };
        existingPid = Number(parsed.pid ?? -1);
        if (parsed.projectRoot) {
          existingProjectRoot = parsed.projectRoot;
        }
      } catch {
        // ignore lock parse errors
      }

      if (isPidAlive(existingPid)) {
        throw new Error(
          `Another cognald instance is already polling this Telegram bot (pid=${existingPid}, projectRoot=${existingProjectRoot}). Stop it before starting this instance.`
        );
      }

      await fs.rm(lockPath, { force: true });
    }
  }

  throw new Error(`Failed to acquire bot lock at ${lockPath}`);
}

async function releaseBotLock(lock: BotLock | null): Promise<void> {
  if (!lock) {
    return;
  }
  try {
    await fs.rm(lock.lockPath, { force: true });
  } catch {
    // ignore cleanup failures
  }
}

async function isExecutable(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

async function resolveAgentCommand(preferred: string): Promise<string | null> {
  if (preferred.includes("/") && (await isExecutable(preferred))) {
    return preferred;
  }

  const home = process.env.HOME || "";
  const candidates = [
    preferred,
    `/usr/local/bin/${preferred}`,
    `/usr/bin/${preferred}`,
    home ? path.join(home, ".npm-global", "bin", preferred) : "",
    home ? path.join(home, ".local", "bin", preferred) : ""
  ].filter(Boolean);

  for (const candidate of candidates) {
    if (candidate.includes("/") && (await isExecutable(candidate))) {
      return candidate;
    }
  }
  return null;
}

async function main(): Promise<void> {
  const projectRoot = process.env.COGNAL_PROJECT_ROOT || process.cwd();
  const paths = getRuntimePaths(projectRoot);
  await ensureRuntimeDirs(paths);

  const cfg = await loadOrCreateConfig(paths);
  const db = new Db(paths.dbPath);
  await db.migrate();

  const telegramToken = process.env[cfg.telegram.botTokenEnv]?.trim();
  if (!telegramToken) {
    throw new Error(`Missing Telegram bot token in env '${cfg.telegram.botTokenEnv}'`);
  }

  const chat = new TelegramBotAdapter(telegramToken, paths.telegramOffsetPath, cfg.telegram.botUsername);
  const identity = await chat.getIdentity();
  const botLock = await acquireBotLock(identity.id, projectRoot);
  const openAiKey = process.env[cfg.stt.apiKeyEnv];
  const stt = openAiKey ? new SttAdapter(openAiKey) : null;

  const enabledAgents = getEnabledAgents(cfg);
  if (enabledAgents.length === 0) {
    throw new Error("No agent provider is enabled. Update .cognal/config.toml.");
  }

  const adapters: Partial<Record<AgentType, ClaudeAdapter | CodexAdapter>> = {};
  if (cfg.agents.enabled.claude) {
    const command = await resolveAgentCommand(cfg.agents.claude.command);
    if (!command) {
      throw new Error(
        `Claude command not found ('${cfg.agents.claude.command}'). Re-run 'cognal setup' or set an absolute path in .cognal/config.toml.`
      );
    }
    adapters.claude = new ClaudeAdapter(command, cfg.agents.claude.args);
  }
  if (cfg.agents.enabled.codex) {
    const command = await resolveAgentCommand(cfg.agents.codex.command);
    if (!command) {
      throw new Error(
        `Codex command not found ('${cfg.agents.codex.command}'). Re-run 'cognal setup' or set an absolute path in .cognal/config.toml.`
      );
    }
    adapters.codex = new CodexAdapter(command, cfg.agents.codex.args);
  }

  const manager = new AgentManager(db, adapters, {
    failoverEnabled: cfg.routing.failoverEnabled && enabledAgents.length > 1,
    agentResponseSec: cfg.timeouts.agentResponseSec,
    agentIdleMs: cfg.timeouts.agentIdleMs,
    defaultAgent: getDefaultAgent(cfg)
  });

  let running = true;
  const stop = async (): Promise<void> => {
    running = false;
    logger.info("shutdown requested");
    await manager.shutdownAll();
    await releaseBotLock(botLock);
    await db.close();
    process.exit(0);
  };

  process.on("SIGINT", () => {
    void stop();
  });
  process.on("SIGTERM", () => {
    void stop();
  });

  logger.info("cognald started", { projectRoot, botUsername: identity.username });
  let consecutiveLoopErrors = 0;

  while (running) {
    try {
      const events = await chat.receive(cfg.telegram.receiveTimeoutSec);
      for (const event of events) {
        await processInboundEvent({ event, db, manager, chat, stt, cfg, paths, botUsername: identity.username, logger, isAgentEnabled });
      }
      await runAttachmentCleanup(db);
      consecutiveLoopErrors = 0;
    } catch (err) {
      consecutiveLoopErrors += 1;
      const backoffMs = Math.min(LOOP_ERROR_BACKOFF_BASE_MS * 2 ** Math.min(consecutiveLoopErrors - 1, 5), LOOP_ERROR_BACKOFF_MAX_MS);
      logger.error("loop error", { error: String(err), consecutiveLoopErrors, backoffMs });
      await new Promise((resolve) => setTimeout(resolve, backoffMs));
    }
  }
}

void main().catch((err) => {
  logger.error("fatal daemon crash", { error: String(err) });
  process.exit(1);
});

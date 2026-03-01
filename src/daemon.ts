#!/usr/bin/env node
import { promises as fs, constants as fsConstants } from "node:fs";
import path from "node:path";
import process from "node:process";
import { loadOrCreateConfig, getRuntimePaths, ensureRuntimeDirs, getDefaultAgent, getEnabledAgents, isAgentEnabled } from "./config.js";
import { Db } from "./core/db.js";
import { Logger } from "./core/logger.js";
import { routeTextInput } from "./core/router.js";
import { chunkText, safeFileName } from "./core/utils.js";
import { stageIncomingAttachment, buildAttachmentSummary } from "./core/attachments.js";
import { TelegramBotAdapter } from "./adapters/telegramBotAdapter.js";
import { SttAdapter } from "./adapters/sttAdapter.js";
import { ClaudeAdapter } from "./agents/claudeAdapter.js";
import { CodexAdapter } from "./agents/codexAdapter.js";
import { AgentManager } from "./agents/manager.js";
import type { AgentType, InboundAttachment } from "./types.js";

const logger = new Logger("daemon");

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

  while (running) {
    try {
      const events = await chat.receive(cfg.telegram.receiveTimeoutSec);
      for (const event of events) {
        await processInboundEvent({ event, db, manager, chat, stt, cfg, paths, botUsername: identity.username });
      }
      await runAttachmentCleanup(db);
    } catch (err) {
      logger.error("loop error", { error: String(err) });
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }
}

async function processInboundEvent(args: {
  event: Awaited<ReturnType<TelegramBotAdapter["receive"]>>[number];
  db: Db;
  manager: AgentManager;
  chat: TelegramBotAdapter;
  stt: SttAdapter | null;
  cfg: Awaited<ReturnType<typeof loadOrCreateConfig>>;
  paths: ReturnType<typeof getRuntimePaths>;
  botUsername: string;
}): Promise<void> {
  const { event, db, manager, chat, stt, cfg, paths, botUsername } = args;

  if ((event.chatType === "group" || event.chatType === "supergroup" || event.chatType === "channel") && !cfg.telegram.allowGroups) {
    return;
  }

  const user = await db.getUserByTelegramUserId(event.fromUserId);
  if (!user || user.status !== "active") {
    await db.recordAccessRequest(event.fromUserId, event.chatId, event.fromUsername, event.displayName, "pending");
    await chat.sendMessage(
      event.chatId,
      `Access denied. Your Telegram user ID is ${event.fromUserId}. Ask the host admin to run: cognal user approve --telegram-user-id ${event.fromUserId}`
    );
    return;
  }

  await db.touchTelegramUserSeen(event.fromUserId, event.fromUsername, event.displayName);

  const isGroup = event.chatType === "group" || event.chatType === "supergroup" || event.chatType === "channel";
  if (isGroup) {
    const chatAllowed = await db.isChatAllowed(event.chatId);
    if (!chatAllowed) {
      await chat.sendMessage(event.chatId, `This chat is not allowed. Ask admin to run: cognal chat allow --chat-id ${event.chatId}`);
      return;
    }
    if (!event.isCommand && !event.isMentioned && !event.isReplyToBot) {
      return;
    }
  }

  const inboundMessageId = await db.insertMessage(user.id, event.transportMessageId, event.chatId, "in", event.text || "");

  const stagedAttachments: InboundAttachment[] = [];
  for (let idx = 0; idx < event.attachments.length; idx += 1) {
    const att = event.attachments[idx];
    const downloadPath = path.join(paths.tempDir, `${Date.now()}-${idx}-${safeFileName(att.fileName)}`);
    try {
      await chat.downloadAttachment(att.fileId, downloadPath);
      const staged = await stageIncomingAttachment(
        downloadPath,
        att.fileName,
        att.contentType,
        paths.tempDir,
        cfg.retention.attachmentsHours,
        att.sizeBytes
      );
      stagedAttachments.push(staged);
      await db.insertAttachment(inboundMessageId, staged);
    } catch (err) {
      logger.warn("failed staging attachment", { error: String(err), fileId: att.fileId });
    } finally {
      try {
        await fs.unlink(downloadPath);
      } catch {
        // ignore
      }
    }
  }

  const route = routeTextInput(event.text || "", botUsername);

  if (route.type === "switch_agent") {
    if (!isAgentEnabled(cfg, route.agent)) {
      await chat.sendMessage(event.chatId, `Agent '${route.agent}' is disabled on this host.`);
      return;
    }
    await manager.switchAgent(user.id, route.agent);
    await chat.sendMessage(event.chatId, `Switched active agent to ${route.agent}.`);
    return;
  }

  const parts: string[] = [];
  const inboundText = route.payload.trim();
  if (inboundText) {
    parts.push(inboundText);
  }

  const attachmentSummary = buildAttachmentSummary(stagedAttachments);
  if (attachmentSummary) {
    parts.push(attachmentSummary);
  }

  const audioItems = stagedAttachments.filter((att) => att.type === "audio");
  for (const audio of audioItems) {
    if (!stt) {
      parts.push(`Audio transcription unavailable (${cfg.stt.apiKeyEnv} is missing). File: ${audio.path}`);
      continue;
    }
    try {
      const transcription = await stt.transcribe(audio.path);
      parts.push(`Transcribed audio (${audio.path}):\n${transcription.text}`);
    } catch (err) {
      parts.push(`Audio transcription failed (${audio.path}): ${String(err)}`);
    }
  }

  const finalPrompt = parts.join("\n\n").trim();
  if (!finalPrompt) {
    return;
  }

  let responseText: string;
  try {
    const output = await manager.sendToActive(user.id, finalPrompt);
    responseText = output.text || "(No textual response from agent.)";
  } catch (err) {
    logger.error("agent send failed", { userId: user.id, error: String(err) });
    responseText = `Agent execution failed: ${String(err)}`;
  }

  await db.insertMessage(user.id, null, event.chatId, "out", responseText);
  const chunks = chunkText(responseText, cfg.routing.responseChunkSize);
  for (const chunk of chunks) {
    await chat.sendMessage(event.chatId, chunk);
  }
}

async function runAttachmentCleanup(db: Db): Promise<void> {
  const expired = await db.listExpiredAttachmentPaths(new Date().toISOString());
  for (const filePath of expired) {
    try {
      await fs.unlink(filePath);
    } catch {
      // ignore cleanup misses
    }
    await db.markAttachmentDeleted(filePath);
  }
}

void main().catch((err) => {
  logger.error("fatal daemon crash", { error: String(err) });
  process.exit(1);
});

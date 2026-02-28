#!/usr/bin/env node
import { promises as fs } from "node:fs";
import process from "node:process";
import { loadOrCreateConfig, getRuntimePaths, ensureRuntimeDirs } from "./config.js";
import { Db } from "./core/db.js";
import { Logger } from "./core/logger.js";
import { routeTextInput } from "./core/router.js";
import { chunkText } from "./core/utils.js";
import { stageIncomingAttachment, buildAttachmentSummary } from "./core/attachments.js";
import { SignalCliAdapter } from "./adapters/signalCliAdapter.js";
import { SttAdapter } from "./adapters/sttAdapter.js";
import { ClaudeAdapter } from "./agents/claudeAdapter.js";
import { CodexAdapter } from "./agents/codexAdapter.js";
import { AgentManager } from "./agents/manager.js";
import type { InboundAttachment } from "./types.js";

const logger = new Logger("daemon");

async function main(): Promise<void> {
  const projectRoot = process.env.COGNAL_PROJECT_ROOT || process.cwd();
  const paths = getRuntimePaths(projectRoot);
  await ensureRuntimeDirs(paths);

  const cfg = await loadOrCreateConfig(paths);
  const db = new Db(paths.dbPath);
  await db.migrate();

  const signal = new SignalCliAdapter(cfg.signal.command, cfg.signal.dataDir, cfg.signal.account);
  const openAiKey = process.env[cfg.stt.apiKeyEnv];
  const stt = openAiKey ? new SttAdapter(openAiKey) : null;

  const manager = new AgentManager(
    db,
    {
      claude: new ClaudeAdapter(cfg.agents.claude.command, cfg.agents.claude.args),
      codex: new CodexAdapter(cfg.agents.codex.command, cfg.agents.codex.args)
    },
    {
      failoverEnabled: cfg.routing.failoverEnabled,
      agentResponseSec: cfg.timeouts.agentResponseSec,
      agentIdleMs: cfg.timeouts.agentIdleMs
    }
  );

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

  logger.info("cognald started", { projectRoot });

  while (running) {
    try {
      const events = await signal.receive(cfg.signal.receiveTimeoutSec);
      for (const event of events) {
        await processInboundEvent({ event, db, manager, signal, stt, cfg, paths });
      }
      await runAttachmentCleanup(db);
    } catch (err) {
      logger.error("loop error", { error: String(err) });
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }
}

async function processInboundEvent(args: {
  event: Awaited<ReturnType<SignalCliAdapter["receive"]>>[number];
  db: Db;
  manager: AgentManager;
  signal: SignalCliAdapter;
  stt: SttAdapter | null;
  cfg: Awaited<ReturnType<typeof loadOrCreateConfig>>;
  paths: ReturnType<typeof getRuntimePaths>;
}): Promise<void> {
  const { event, db, manager, signal, stt, cfg, paths } = args;

  const user = await db.getUserByPhone(event.source);
  if (!user) {
    logger.warn("message from unauthorized source", { source: event.source });
    await signal.sendMessage(event.source, "This number is not active in Cognal whitelist.");
    return;
  }
  if (user.status === "revoked") {
    await signal.sendMessage(event.source, "Your access was revoked.");
    return;
  }
  if (user.status === "pending") {
    await db.setUserStatus(user.id, "active");
  }

  const inboundMessageId = await db.insertMessage(user.id, event.signalMessageId, "in", event.text || "");

  const stagedAttachments: InboundAttachment[] = [];
  for (const att of event.attachments) {
    try {
      const staged = await stageIncomingAttachment(
        att.localPath,
        att.fileName,
        att.contentType,
        paths.tempDir,
        cfg.retention.attachmentsHours,
        att.sizeBytes
      );
      stagedAttachments.push(staged);
      await db.insertAttachment(inboundMessageId, staged);
    } catch (err) {
      logger.warn("failed staging attachment", { error: String(err), path: att.localPath });
    }
  }

  const route = routeTextInput(event.text || "");

  if (route.type === "switch_agent") {
    await manager.switchAgent(user.id, route.agent);
    await signal.sendMessage(event.source, `Switched active agent to ${route.agent}.`);
    return;
  }

  const passthroughText = route.type === "passthrough" ? route.payload : route.payload;
  const parts: string[] = [];

  if (passthroughText.trim()) {
    parts.push(passthroughText);
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
    await signal.sendMessage(event.source, "Empty message received.");
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

  await db.insertMessage(user.id, event.signalMessageId, "out", responseText);
  const chunks = chunkText(responseText, cfg.routing.responseChunkSize);
  for (const chunk of chunks) {
    await signal.sendMessage(event.source, chunk);
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

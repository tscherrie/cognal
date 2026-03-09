import { promises as fs } from "node:fs";
import path from "node:path";
import type { CognalConfig } from "../config.js";
import type { ChatAdapter, InboundChatEvent } from "../adapters/chatAdapter.js";
import type { SttAdapter } from "../adapters/sttAdapter.js";
import type { AgentManager } from "../agents/manager.js";
import type { InboundAttachment } from "../types.js";
import type { Db } from "./db.js";
import { routeTextInput } from "./router.js";
import { safeFileName, chunkText } from "./utils.js";
import { stageIncomingAttachment, buildAttachmentSummary } from "./attachments.js";
import { Logger } from "./logger.js";

interface RuntimePathsLike {
  tempDir: string;
}

export async function processInboundEvent(args: {
  event: InboundChatEvent;
  db: Db;
  manager: AgentManager;
  chat: ChatAdapter;
  stt: SttAdapter | null;
  cfg: CognalConfig;
  paths: RuntimePathsLike;
  botUsername: string;
  logger: Logger;
  isAgentEnabled: (cfg: CognalConfig, agent: "claude" | "codex") => boolean;
}): Promise<void> {
  const { event, db, manager, chat, stt, cfg, paths, botUsername, logger, isAgentEnabled } = args;

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

export async function runAttachmentCleanup(db: Db): Promise<void> {
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

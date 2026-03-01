import { promises as fs } from "node:fs";
import path from "node:path";
import type { ChatAdapter, InboundAttachmentDescriptor, InboundChatEvent, TelegramBotIdentity } from "./chatAdapter.js";

interface TelegramApiResponse<T> {
  ok: boolean;
  result?: T;
  description?: string;
}

interface TelegramUser {
  id: number;
  is_bot?: boolean;
  username?: string;
  first_name?: string;
  last_name?: string;
}

interface TelegramChat {
  id: number;
  type: string;
  title?: string;
}

interface TelegramEntity {
  type: string;
  offset: number;
  length: number;
}

interface TelegramMessage {
  message_id: number;
  date?: number;
  text?: string;
  caption?: string;
  entities?: TelegramEntity[];
  caption_entities?: TelegramEntity[];
  from?: TelegramUser;
  chat?: TelegramChat;
  reply_to_message?: {
    from?: TelegramUser;
  };
  voice?: {
    file_id: string;
    mime_type?: string;
    file_size?: number;
  };
  audio?: {
    file_id: string;
    file_name?: string;
    mime_type?: string;
    file_size?: number;
  };
  photo?: Array<{
    file_id: string;
    file_size?: number;
  }>;
  document?: {
    file_id: string;
    file_name?: string;
    mime_type?: string;
    file_size?: number;
  };
}

interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
}

interface TelegramGetFileResult {
  file_path: string;
}

function mapChatType(type: string | undefined): InboundChatEvent["chatType"] {
  if (type === "private" || type === "group" || type === "supergroup" || type === "channel") {
    return type;
  }
  return "private";
}

function buildDisplayName(from: TelegramUser | undefined): string | null {
  if (!from) {
    return null;
  }
  const name = [from.first_name ?? "", from.last_name ?? ""].join(" ").trim();
  return name || null;
}

function extractAttachments(message: TelegramMessage): InboundAttachmentDescriptor[] {
  const out: InboundAttachmentDescriptor[] = [];
  if (message.voice?.file_id) {
    out.push({
      type: "audio",
      fileId: message.voice.file_id,
      fileName: `voice-${message.message_id}.ogg`,
      contentType: message.voice.mime_type ?? "audio/ogg",
      sizeBytes: message.voice.file_size
    });
  }
  if (message.audio?.file_id) {
    out.push({
      type: "audio",
      fileId: message.audio.file_id,
      fileName: message.audio.file_name ?? `audio-${message.message_id}`,
      contentType: message.audio.mime_type ?? "audio/mpeg",
      sizeBytes: message.audio.file_size
    });
  }
  if (Array.isArray(message.photo) && message.photo.length > 0) {
    const largest = message.photo[message.photo.length - 1];
    out.push({
      type: "image",
      fileId: largest.file_id,
      fileName: `photo-${message.message_id}.jpg`,
      contentType: "image/jpeg",
      sizeBytes: largest.file_size
    });
  }
  if (message.document?.file_id) {
    const mimeType = message.document.mime_type ?? "application/octet-stream";
    const docType =
      mimeType.startsWith("audio/") ? "audio" : mimeType.startsWith("image/") ? "image" : "document";
    out.push({
      type: docType,
      fileId: message.document.file_id,
      fileName: message.document.file_name ?? `document-${message.message_id}`,
      contentType: mimeType,
      sizeBytes: message.document.file_size
    });
  }
  return out;
}

function firstCommandToken(text: string): string {
  const trimmed = text.trim();
  const spaceIdx = trimmed.indexOf(" ");
  return spaceIdx === -1 ? trimmed : trimmed.slice(0, spaceIdx);
}

export class TelegramBotAdapter implements ChatAdapter {
  private loadedOffset = false;
  private offset = 0;
  private identityCache: TelegramBotIdentity | null = null;

  constructor(
    private readonly token: string,
    private readonly statePath: string,
    private readonly configuredBotUsername?: string
  ) {}

  async getIdentity(): Promise<TelegramBotIdentity> {
    if (this.identityCache) {
      return this.identityCache;
    }
    const me = await this.callApi<{ id: number; username: string }>("getMe", {});
    if (!me.username) {
      throw new Error("Telegram getMe returned no username");
    }
    this.identityCache = { id: me.id, username: me.username };
    return this.identityCache;
  }

  async receive(timeoutSec: number): Promise<InboundChatEvent[]> {
    await this.ensureOffsetLoaded();
    const identity = await this.getIdentity();
    const updates = await this.callApi<TelegramUpdate[]>("getUpdates", {
      timeout: timeoutSec,
      offset: this.offset,
      allowed_updates: ["message"]
    });

    if (!Array.isArray(updates) || updates.length === 0) {
      return [];
    }

    let maxUpdateId = this.offset;
    const events: InboundChatEvent[] = [];
    for (const update of updates) {
      if (typeof update.update_id === "number") {
        maxUpdateId = Math.max(maxUpdateId, update.update_id + 1);
      }
      const message = update.message;
      if (!message?.chat?.id || !message.from?.id) {
        continue;
      }

      const text = message.text ?? message.caption ?? "";
      const token = firstCommandToken(text);
      const tokenMention = token.match(/^\/[a-zA-Z0-9_]+@([a-zA-Z0-9_]+)$/);
      const mentionedFromCommand = tokenMention
        ? tokenMention[1].toLowerCase() === identity.username.toLowerCase()
        : false;
      const mentionedInText = text.toLowerCase().includes(`@${identity.username.toLowerCase()}`);
      const entities = [...(message.entities ?? []), ...(message.caption_entities ?? [])];
      const hasCommandEntity = entities.some((entity) => entity.type === "bot_command" && entity.offset === 0);

      events.push({
        chatId: String(message.chat.id),
        chatType: mapChatType(message.chat.type),
        fromUserId: String(message.from.id),
        fromUsername: message.from.username ?? null,
        displayName: buildDisplayName(message.from),
        transportMessageId: String(message.message_id),
        text,
        isCommand: hasCommandEntity || text.trim().startsWith("/"),
        isMentioned: mentionedFromCommand || mentionedInText,
        isReplyToBot: Boolean(
          message.reply_to_message?.from?.is_bot &&
            (!message.reply_to_message.from.username ||
              message.reply_to_message.from.username.toLowerCase() === identity.username.toLowerCase())
        ),
        attachments: extractAttachments(message),
        receivedAt: new Date((message.date ?? Math.floor(Date.now() / 1000)) * 1000).toISOString()
      });
    }

    if (maxUpdateId !== this.offset) {
      this.offset = maxUpdateId;
      await this.persistOffset();
    }

    return events;
  }

  async sendMessage(chatId: string, text: string): Promise<void> {
    await this.callApi("sendMessage", {
      chat_id: chatId,
      text
    });
  }

  async downloadAttachment(fileId: string, targetPath: string): Promise<void> {
    const file = await this.callApi<TelegramGetFileResult>("getFile", { file_id: fileId });
    if (!file.file_path) {
      throw new Error(`Telegram getFile returned no file_path for file_id ${fileId}`);
    }
    const response = await fetch(`https://api.telegram.org/file/bot${this.token}/${file.file_path}`);
    if (!response.ok) {
      throw new Error(`Telegram file download failed (${response.status})`);
    }
    const buf = Buffer.from(await response.arrayBuffer());
    await fs.mkdir(path.dirname(targetPath), { recursive: true });
    await fs.writeFile(targetPath, buf);
  }

  private async callApi<T>(method: string, payload: Record<string, unknown>): Promise<T> {
    const response = await fetch(`https://api.telegram.org/bot${this.token}/${method}`, {
      method: "POST",
      headers: {
        "content-type": "application/json"
      },
      body: JSON.stringify(payload)
    });
    if (!response.ok) {
      throw new Error(`Telegram API ${method} failed (${response.status})`);
    }
    const json = (await response.json()) as TelegramApiResponse<T>;
    if (!json.ok || json.result === undefined) {
      throw new Error(`Telegram API ${method} error: ${json.description ?? "unknown error"}`);
    }
    return json.result;
  }

  private async ensureOffsetLoaded(): Promise<void> {
    if (this.loadedOffset) {
      return;
    }
    this.loadedOffset = true;
    try {
      const raw = (await fs.readFile(this.statePath, "utf8")).trim();
      const parsed = Number(raw);
      if (Number.isFinite(parsed) && parsed >= 0) {
        this.offset = parsed;
      }
    } catch {
      this.offset = 0;
    }
  }

  private async persistOffset(): Promise<void> {
    await fs.mkdir(path.dirname(this.statePath), { recursive: true });
    await fs.writeFile(this.statePath, String(this.offset), "utf8");
  }
}

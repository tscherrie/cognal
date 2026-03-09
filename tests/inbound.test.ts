import { describe, expect, it } from "vitest";
import os from "node:os";
import path from "node:path";
import { promises as fs } from "node:fs";
import { processInboundEvent, runAttachmentCleanup } from "../src/core/inbound.js";
import { Logger } from "../src/core/logger.js";
import type { InboundChatEvent } from "../src/adapters/chatAdapter.js";
import type { AgentType, InboundAttachment, UserRecord } from "../src/types.js";

class FakeDb {
  user: UserRecord | null = {
    id: "u1",
    telegramUserId: "123",
    telegramUsername: "tester",
    displayName: "Tester",
    status: "active",
    lastSeenAt: null,
    createdAt: new Date().toISOString()
  };

  allowedChats = new Set<string>();
  accessRequests: Array<{ userId: string; chatId: string }> = [];
  messages: Array<{ direction: "in" | "out"; body: string; chatId: string | null }> = [];
  attachments: InboundAttachment[] = [];
  deletedPaths: string[] = [];
  expiredPaths: string[] = [];
  binding = {
    userId: "u1",
    activeAgent: "codex" as AgentType,
    claudeSessionRef: "claude-session",
    codexSessionRef: "codex-session",
    updatedAt: new Date().toISOString()
  };

  async getUserByTelegramUserId(): Promise<UserRecord | null> {
    return this.user;
  }

  async recordAccessRequest(userId: string, chatId: string): Promise<void> {
    this.accessRequests.push({ userId, chatId });
  }

  async touchTelegramUserSeen(): Promise<void> {}

  async isChatAllowed(chatId: string): Promise<boolean> {
    return this.allowedChats.has(chatId);
  }

  async insertMessage(_userId: string, _transportMessageId: string | null, chatId: string | null, direction: "in" | "out", body: string): Promise<string> {
    this.messages.push({ direction, body, chatId });
    return `m${this.messages.length}`;
  }

  async insertAttachment(_messageId: string, data: InboundAttachment): Promise<void> {
    this.attachments.push(data);
  }

  async getBinding(): Promise<typeof this.binding> {
    return this.binding;
  }

  async listExpiredAttachmentPaths(): Promise<string[]> {
    return [...this.expiredPaths];
  }

  async markAttachmentDeleted(filePath: string): Promise<void> {
    this.deletedPaths.push(filePath);
  }
}

class FakeManager {
  switched: AgentType[] = [];
  prompts: string[] = [];
  cleared: AgentType[] = [];
  responseText = "agent-ok";

  async switchAgent(_userId: string, agent: AgentType): Promise<void> {
    this.switched.push(agent);
  }

  async sendToActive(_userId: string, input: string): Promise<{ text: string }> {
    this.prompts.push(input);
    return { text: this.responseText };
  }

  async clearAgentSession(_userId: string, agent: AgentType): Promise<void> {
    this.cleared.push(agent);
  }
}

class FakeChat {
  sent: Array<{ chatId: string; text: string; options?: { parseMode?: "HTML"; disableWebPagePreview?: boolean } }> = [];
  typing: string[] = [];
  downloadBodies = new Map<string, string>();

  async sendMessage(chatId: string, text: string, options?: { parseMode?: "HTML"; disableWebPagePreview?: boolean }): Promise<void> {
    this.sent.push({ chatId, text, options });
  }

  async sendTyping(chatId: string): Promise<void> {
    this.typing.push(chatId);
  }

  async downloadAttachment(fileId: string, targetPath: string): Promise<void> {
    await fs.mkdir(path.dirname(targetPath), { recursive: true });
    await fs.writeFile(targetPath, this.downloadBodies.get(fileId) ?? "file-data", "utf8");
  }
}

function makeEvent(overrides: Partial<InboundChatEvent> = {}): InboundChatEvent {
  return {
    chatId: "c1",
    chatType: "private",
    fromUserId: "123",
    fromUsername: "tester",
    displayName: "Tester",
    transportMessageId: "m1",
    text: "hello",
    isCommand: false,
    isMentioned: false,
    isReplyToBot: false,
    attachments: [],
    receivedAt: new Date().toISOString(),
    ...overrides
  };
}

function makeConfig() {
  return {
    projectId: "proj",
    runtime: { osMode: "linux", distro: "ubuntu", serviceName: "svc" },
    telegram: { botTokenEnv: "TELEGRAM_BOT_TOKEN", botUsername: "mybot", receiveTimeoutSec: 30, allowGroups: true, groupMode: "all" },
    agents: {
      enabled: { claude: true, codex: true },
      claude: { command: "claude", args: [] },
      codex: { command: "codex", args: [] }
    },
    routing: { failoverEnabled: true, responseChunkSize: 5 },
    stt: { provider: "openai", model: "whisper-1", apiKeyEnv: "OPENAI_API_KEY" },
    retention: { attachmentsHours: 24, maxAudioBytes: 100 * 1024 * 1024, maxImageBytes: 50 * 1024 * 1024, maxDocumentBytes: 100 * 1024 * 1024 },
    timeouts: { agentResponseSec: 240, failoverRetrySec: 30, agentIdleMs: 1500 }
  } as const;
}

describe("processInboundEvent", () => {
  it("records pending access requests and denies unknown users", async () => {
    const db = new FakeDb();
    db.user = null;
    const chat = new FakeChat();

    await processInboundEvent({
      event: makeEvent(),
      db: db as any,
      manager: new FakeManager() as any,
      chat: chat as any,
      stt: null,
      cfg: makeConfig() as any,
      paths: { tempDir: path.join(os.tmpdir(), `cognal-inbound-${Date.now()}`) },
      botUsername: "mybot",
      logger: new Logger("test"),
      isAgentEnabled: () => true
    });

    expect(db.accessRequests).toEqual([{ userId: "123", chatId: "c1" }]);
    expect(chat.sent[0]?.text).toContain("Access denied");
  });

  it("ignores allowed group chatter unless command, mention, or reply", async () => {
    const db = new FakeDb();
    db.allowedChats.add("group1");
    const manager = new FakeManager();
    const chat = new FakeChat();
    const cfg = makeConfig() as any;
    cfg.telegram.groupMode = "mentions_only";

    await processInboundEvent({
      event: makeEvent({ chatId: "group1", chatType: "supergroup", text: "noise" }),
      db: db as any,
      manager: manager as any,
      chat: chat as any,
      stt: null,
      cfg,
      paths: { tempDir: path.join(os.tmpdir(), `cognal-inbound-${Date.now()}`) },
      botUsername: "mybot",
      logger: new Logger("test"),
      isAgentEnabled: () => true
    });

    expect(manager.prompts).toEqual([]);
    expect(chat.sent).toEqual([]);
  });

  it("rejects unauthorized group chats before agent execution", async () => {
    const db = new FakeDb();
    const chat = new FakeChat();

    await processInboundEvent({
      event: makeEvent({ chatId: "group2", chatType: "supergroup", isMentioned: true }),
      db: db as any,
      manager: new FakeManager() as any,
      chat: chat as any,
      stt: null,
      cfg: makeConfig() as any,
      paths: { tempDir: path.join(os.tmpdir(), `cognal-inbound-${Date.now()}`) },
      botUsername: "mybot",
      logger: new Logger("test"),
      isAgentEnabled: () => true
    });

    expect(chat.sent[0]?.text).toContain("This chat is not allowed");
  });

  it("clears the active Claude session locally for /clear", async () => {
    const db = new FakeDb();
    db.binding.activeAgent = "claude";
    const manager = new FakeManager();
    const chat = new FakeChat();

    await processInboundEvent({
      event: makeEvent({ text: "/clear", isCommand: true }),
      db: db as any,
      manager: manager as any,
      chat: chat as any,
      stt: null,
      cfg: makeConfig() as any,
      paths: { tempDir: path.join(os.tmpdir(), `cognal-inbound-${Date.now()}`) },
      botUsername: "mybot",
      logger: new Logger("test"),
      isAgentEnabled: () => true
    });

    expect(manager.cleared).toEqual(["claude"]);
    expect(manager.prompts).toEqual([]);
    expect(chat.sent[0]?.text).toBe("Cleared active Claude session.");
  });

  it("stages audio, appends transcription failures, and chunks the response", async () => {
    const db = new FakeDb();
    const manager = new FakeManager();
    manager.responseText = "123456789";
    const chat = new FakeChat();
    const tmpDir = path.join(os.tmpdir(), `cognal-inbound-${Date.now()}`);

    await processInboundEvent({
      event: makeEvent({
        attachments: [
          {
            type: "audio",
            fileId: "audio1",
            fileName: "voice.ogg",
            contentType: "audio/ogg",
            sizeBytes: 11
          }
        ]
      }),
      db: db as any,
      manager: manager as any,
      chat: chat as any,
      stt: {
        async transcribe() {
          throw new Error("stt down");
        }
      } as any,
      cfg: makeConfig() as any,
      paths: { tempDir: tmpDir },
      botUsername: "mybot",
      logger: new Logger("test"),
      isAgentEnabled: () => true
    });

    expect(db.attachments).toHaveLength(1);
    expect(manager.prompts[0]).toContain("Incoming attachments:");
    expect(manager.prompts[0]).toContain("Audio transcription failed");
    expect(chat.sent.map((item) => item.text)).toEqual(["12345", "6789"]);
    expect(chat.typing.length).toBeGreaterThan(0);

    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("rejects oversized attachments with a user-facing error", async () => {
    const db = new FakeDb();
    const manager = new FakeManager();
    const chat = new FakeChat();
    const cfg = makeConfig() as any;
    cfg.retention.maxDocumentBytes = 10;

    await processInboundEvent({
      event: makeEvent({
        attachments: [
          {
            type: "document",
            fileId: "doc1",
            fileName: "big.pdf",
            contentType: "application/pdf",
            sizeBytes: 999
          }
        ]
      }),
      db: db as any,
      manager: manager as any,
      chat: chat as any,
      stt: null,
      cfg,
      paths: { tempDir: path.join(os.tmpdir(), `cognal-inbound-${Date.now()}`) },
      botUsername: "mybot",
      logger: new Logger("test"),
      isAgentEnabled: () => true
    });

    expect(chat.sent[0]?.text).toContain("Attachment rejected");
    expect(db.attachments).toHaveLength(0);
  });

  it("returns a diagnostic ID instead of raw provider errors", async () => {
    const db = new FakeDb();
    const chat = new FakeChat();
    const manager = new FakeManager();
    manager.sendToActive = async () => {
      throw new Error("429 rate limit exceeded");
    };

    await processInboundEvent({
      event: makeEvent(),
      db: db as any,
      manager: manager as any,
      chat: chat as any,
      stt: null,
      cfg: makeConfig() as any,
      paths: { tempDir: path.join(os.tmpdir(), `cognal-inbound-${Date.now()}`) },
      botUsername: "mybot",
      logger: new Logger("test"),
      isAgentEnabled: () => true
    });

    const combined = chat.sent.map((item) => item.text).join("\n");
    const squashed = combined.replace(/\s+/g, "");
    expect(squashed.toLowerCase()).toContain("rate-limited".replace(/\s+/g, ""));
    expect(squashed).toMatch(/ErrorID:[a-z0-9]+/i);
    expect(combined).not.toContain("429 rate limit exceeded");
  });

  it("formats agent output as Telegram HTML before sending", async () => {
    const db = new FakeDb();
    const chat = new FakeChat();
    const manager = new FakeManager();
    manager.responseText = ["**Projektziel**", "", "Das steht in [README.md](/tmp/README.md)."].join("\n");

    await processInboundEvent({
      event: makeEvent(),
      db: db as any,
      manager: manager as any,
      chat: chat as any,
      stt: null,
      cfg: makeConfig() as any,
      paths: { tempDir: path.join(os.tmpdir(), `cognal-inbound-${Date.now()}`) },
      botUsername: "mybot",
      logger: new Logger("test"),
      isAgentEnabled: () => true
    });

    const combined = chat.sent.map((item) => item.text).join("");
    expect(combined).toContain("<b>Projektziel</b>");
    expect(combined).toContain("<code>README.md</code>");
    expect(chat.sent[0]?.options).toEqual({ parseMode: "HTML", disableWebPagePreview: true });
  });
});

describe("runAttachmentCleanup", () => {
  it("removes expired files and marks them deleted", async () => {
    const db = new FakeDb();
    const filePath = path.join(os.tmpdir(), `cognal-expired-${Date.now()}.txt`);
    await fs.writeFile(filePath, "expired", "utf8");
    db.expiredPaths = [filePath];

    await runAttachmentCleanup(db as any);

    await expect(fs.stat(filePath)).rejects.toThrow();
    expect(db.deletedPaths).toEqual([filePath]);
  });
});

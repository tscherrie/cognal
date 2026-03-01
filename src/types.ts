export type AgentType = "claude" | "codex";

export type UserStatus = "pending" | "active" | "revoked";

export interface UserRecord {
  id: string;
  telegramUserId: string | null;
  telegramUsername: string | null;
  displayName: string | null;
  status: UserStatus;
  lastSeenAt: string | null;
  createdAt: string;
}

export interface SessionBinding {
  userId: string;
  activeAgent: AgentType;
  claudeSessionRef: string | null;
  codexSessionRef: string | null;
  updatedAt: string;
}

export interface InboundAttachment {
  type: "audio" | "image" | "document";
  path: string;
  mime: string;
  sizeBytes: number;
  expiresAt: string;
}

export interface InboundEnvelope {
  chatId: string;
  chatType: "private" | "group" | "supergroup" | "channel";
  fromUserId: string;
  fromUsername: string | null;
  displayName: string | null;
  transportMessageId: string;
  text: string;
  isCommand: boolean;
  isMentioned: boolean;
  isReplyToBot: boolean;
  attachments: InboundAttachment[];
  receivedAt: string;
}

export interface AgentOutput {
  text: string;
  sessionRef?: string | null;
}

export interface AgentSessionRuntime {
  userId: string;
  agent: AgentType;
  pid: number;
  startedAt: string;
}

export interface SendContext {
  originalText: string;
  attachmentsSummary?: string;
}

export interface TranscriptionResult {
  text: string;
  language?: string;
}

export interface AccessRequestRecord {
  telegramUserId: string;
  chatId: string;
  username: string | null;
  displayName: string | null;
  firstSeenAt: string;
  lastSeenAt: string;
  status: "pending" | "approved" | "rejected";
}

export interface AllowedChatRecord {
  chatId: string;
  chatType: "private" | "group" | "supergroup" | "channel";
  title: string | null;
  createdAt: string;
}

export interface HealthCheckResult {
  name: string;
  ok: boolean;
  details: string;
}

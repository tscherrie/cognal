export type AgentType = "claude" | "codex";

export type UserStatus = "pending" | "active" | "revoked";

export interface UserRecord {
  id: string;
  phoneE164: string;
  email: string;
  signalAccountId: string | null;
  status: UserStatus;
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
  userId: string;
  phoneE164: string;
  signalMessageId: string;
  text: string;
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

export interface DeliveryResult {
  mode: "email" | "link" | "local" | "public_encrypted";
  target: string;
  expiresAt?: string;
  secret?: string;
}

export interface TranscriptionResult {
  text: string;
  language?: string;
}

export interface HealthCheckResult {
  name: string;
  ok: boolean;
  details: string;
}

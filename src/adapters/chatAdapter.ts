import type { InboundEnvelope } from "../types.js";

export interface InboundAttachmentDescriptor {
  type: "audio" | "image" | "document";
  fileId: string;
  fileName: string;
  contentType: string | null;
  sizeBytes?: number;
}

export interface InboundChatEvent extends Omit<InboundEnvelope, "attachments"> {
  attachments: InboundAttachmentDescriptor[];
}

export interface TelegramBotIdentity {
  id: number;
  username: string;
}

export interface SendMessageOptions {
  parseMode?: "HTML";
  disableWebPagePreview?: boolean;
}

export interface ChatAdapter {
  getIdentity(): Promise<TelegramBotIdentity>;
  receive(timeoutSec: number): Promise<InboundChatEvent[]>;
  sendMessage(chatId: string, text: string, options?: SendMessageOptions): Promise<void>;
  sendTyping(chatId: string): Promise<void>;
  downloadAttachment(fileId: string, targetPath: string): Promise<void>;
}

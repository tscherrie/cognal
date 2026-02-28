import { promises as fs } from "node:fs";
import path from "node:path";
import mime from "mime-types";
import type { InboundAttachment } from "../types.js";
import { copyToTemp, nowIso } from "./utils.js";

export function classifyAttachment(mimeType: string, fileName: string): InboundAttachment["type"] {
  const normalized = mimeType.toLowerCase();
  if (normalized.startsWith("audio/")) {
    return "audio";
  }
  if (normalized.startsWith("image/")) {
    return "image";
  }

  const ext = path.extname(fileName).toLowerCase();
  if ([".mp3", ".wav", ".m4a", ".ogg", ".webm"].includes(ext)) {
    return "audio";
  }
  if ([".png", ".jpg", ".jpeg", ".gif", ".webp", ".heic"].includes(ext)) {
    return "image";
  }
  return "document";
}

export async function stageIncomingAttachment(
  sourcePath: string,
  fileName: string,
  mimeType: string | null,
  tempDir: string,
  retentionHours: number,
  sizeHint?: number
): Promise<InboundAttachment> {
  const copiedPath = await copyToTemp(sourcePath, tempDir);
  const stat = await fs.stat(copiedPath);
  const resolvedMime = mimeType ?? String(mime.lookup(fileName) || "application/octet-stream");
  const type = classifyAttachment(resolvedMime, fileName);
  const expiresAt = new Date(Date.now() + retentionHours * 3600 * 1000).toISOString();

  return {
    type,
    path: copiedPath,
    mime: resolvedMime,
    sizeBytes: sizeHint ?? stat.size,
    expiresAt
  };
}

export function buildAttachmentSummary(parts: InboundAttachment[]): string {
  if (parts.length === 0) {
    return "";
  }
  const lines = ["Incoming attachments:"];
  for (const item of parts) {
    lines.push(`- [${item.type}] ${item.path} (${item.mime}, ${item.sizeBytes} bytes)`);
  }
  lines.push(`Received at ${nowIso()}.`);
  return lines.join("\n");
}

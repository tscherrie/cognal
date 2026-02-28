import { randomUUID } from "node:crypto";
import { runCommand } from "../core/utils.js";

export interface SignalInboundEvent {
  source: string;
  text: string;
  signalMessageId: string;
  attachments: Array<{
    localPath: string;
    contentType: string;
    fileName: string;
    sizeBytes?: number;
  }>;
}

function parseJsonLines(input: string): unknown[] {
  const out: unknown[] = [];
  for (const line of input.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }
    try {
      out.push(JSON.parse(trimmed));
    } catch {
      // ignore malformed lines
    }
  }
  return out;
}

function normalizeEvent(raw: any): SignalInboundEvent | null {
  const envelope = raw?.envelope ?? raw;
  const source = envelope?.sourceNumber ?? envelope?.source ?? envelope?.sourceUuid;
  const dataMessage = envelope?.dataMessage ?? raw?.dataMessage;
  const text = dataMessage?.message ?? "";

  if (!source) {
    return null;
  }

  const attachmentsRaw = dataMessage?.attachments ?? [];
  const attachments = attachmentsRaw
    .map((item: any) => {
      const localPath = item?.storedFilename ?? item?.file ?? item?.localPath;
      if (!localPath) {
        return null;
      }
      return {
        localPath,
        contentType: item?.contentType ?? "application/octet-stream",
        fileName: item?.filename ?? item?.fileName ?? `attachment-${randomUUID()}`,
        sizeBytes: typeof item?.size === "number" ? item.size : undefined
      };
    })
    .filter(Boolean) as SignalInboundEvent["attachments"];

  return {
    source,
    text,
    signalMessageId: String(envelope?.timestamp ?? Date.now()),
    attachments
  };
}

export class SignalCliAdapter {
  constructor(
    private readonly command: string,
    private readonly dataDir: string,
    private readonly account?: string
  ) {}

  async receive(timeoutSec: number): Promise<SignalInboundEvent[]> {
    const args = ["-o", "json", "--config", this.dataDir];
    if (this.account) {
      args.push("-a", this.account);
    }
    args.push("receive", "--timeout", String(timeoutSec));
    const result = await runCommand(this.command, args, { timeoutMs: timeoutSec * 1000 + 3000 });
    if (result.code !== 0 && !result.stdout.trim()) {
      return [];
    }

    const parsed = parseJsonLines(result.stdout);
    const events: SignalInboundEvent[] = [];
    for (const item of parsed) {
      const normalized = normalizeEvent(item);
      if (normalized) {
        events.push(normalized);
      }
    }
    return events;
  }

  async sendMessage(recipient: string, text: string, attachments: string[] = []): Promise<void> {
    const args = ["--config", this.dataDir];
    if (this.account) {
      args.push("-a", this.account);
    }
    args.push("send", "-m", text);
    if (attachments.length > 0) {
      args.push("-a", ...attachments);
    }
    args.push(recipient);
    const result = await runCommand(this.command, args, { timeoutMs: 20_000 });
    if (result.code !== 0) {
      throw new Error(`signal-cli send failed: ${result.stderr || result.stdout}`);
    }
  }

  async createDeviceLinkUri(name: string): Promise<string> {
    const args = ["--config", this.dataDir, "link", "-n", name];
    const result = await runCommand(this.command, args, { timeoutMs: 10_000 });
    const output = `${result.stdout}\n${result.stderr}`;

    const uri = output
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find((line) => line.startsWith("sgnl://"));

    if (uri) {
      return uri;
    }

    // Fallback tokenized URI for dry-run/test environments.
    return `sgnl://linkdevice?uuid=${randomUUID()}&name=${encodeURIComponent(name)}`;
  }

  async tryResolveLinkedAccount(phoneE164: string): Promise<string | null> {
    const args = ["--config", this.dataDir, "listAccounts"];
    const result = await runCommand(this.command, args, { timeoutMs: 5_000 });
    if (result.code !== 0) {
      return null;
    }
    const lines = result.stdout.split(/\r?\n/).map((line) => line.trim());
    const match = lines.find((line) => line.includes(phoneE164));
    return match ?? null;
  }
}

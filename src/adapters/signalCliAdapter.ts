import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
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

  private extractDeviceLinkUri(output: string): string | null {
    const directMatch = output.match(/sgnl:\/\/linkdevice\?[^\s"'`<>]+/);
    if (directMatch) {
      const uri = directMatch[0];
      if (uri.includes("pub_key=") && uri.includes("uuid=")) {
        return uri;
      }
      return null;
    }

    const legacyMatch = output.match(/tsdevice:\/\?[^\s"'`<>]+/);
    if (legacyMatch) {
      const query = legacyMatch[0].slice("tsdevice:/?".length);
      const uri = `sgnl://linkdevice?${query}`;
      if (uri.includes("pub_key=") && uri.includes("uuid=")) {
        return uri;
      }
      return null;
    }

    return null;
  }

  async createDeviceLinkSession(
    name: string,
    options: { timeoutMs?: number } = {}
  ): Promise<{ uri: string; completion: Promise<void> }> {
    const timeoutMs = options.timeoutMs ?? 10 * 60_000;
    const args = ["--config", this.dataDir];
    if (this.account) {
      args.push("-a", this.account);
    }
    args.push("link", "-n", name);

    const proc = spawn(this.command, args, { stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    let uri: string | null = null;
    let completed = false;
    let completionError: Error | null = null;

    const appendOutput = (chunk: unknown): void => {
      output += String(chunk);
      if (output.length > 64_000) {
        output = output.slice(output.length - 64_000);
      }
      if (!uri) {
        uri = this.extractDeviceLinkUri(output);
      }
    };

    proc.stdout.on("data", appendOutput);
    proc.stderr.on("data", appendOutput);

    const completion = new Promise<void>((resolve, reject) => {
      proc.on("error", (err) => {
        if (completed) {
          return;
        }
        completed = true;
        completionError = new Error(`signal-cli link failed: ${String(err)}`);
        reject(completionError);
      });
      proc.on("close", (code) => {
        if (completed) {
          return;
        }
        completed = true;
        if ((code ?? 0) === 0) {
          resolve();
          return;
        }
        completionError = new Error(`signal-cli link failed (exit ${code}): ${output.trim()}`);
        reject(completionError);
      });
    });

    const timeoutHandle = setTimeout(() => {
      if (!completed) {
        proc.kill("SIGTERM");
      }
    }, timeoutMs);
    completion.finally(() => {
      clearTimeout(timeoutHandle);
    }).catch(() => {
      // caller handles completion errors
    });

    return await new Promise<{ uri: string; completion: Promise<void> }>((resolve, reject) => {
      const poll = setInterval(() => {
        if (uri) {
          clearInterval(poll);
          resolve({ uri, completion });
          return;
        }
        if (completed) {
          clearInterval(poll);
          reject(completionError ?? new Error(`signal-cli link output did not contain a valid device-link URI: ${output.trim()}`));
        }
      }, 25);

      completion.catch(() => {
        if (!uri) {
          clearInterval(poll);
          reject(completionError ?? new Error(`signal-cli link output did not contain a valid device-link URI: ${output.trim()}`));
        }
      });
    });
  }

  async createDeviceLinkUri(name: string): Promise<string> {
    const session = await this.createDeviceLinkSession(name);
    await session.completion;
    return session.uri;
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

import { promises as fs } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { Resend } from "resend";
import { GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import type { DeliveryResult } from "../types.js";
import { createEncryptedViewerBundle, generatePassword } from "./publicEncryptedBundle.js";

export interface DeliveryConfig {
  resendApiKey?: string;
  resendFrom?: string;
  storage?: {
    endpoint?: string;
    region?: string;
    bucket?: string;
    accessKey?: string;
    secretKey?: string;
    ttlSec: number;
  };
  publicDump?: {
    endpoint: string;
    fileField: string;
    timeoutSec: number;
  };
}

export interface PublicEncryptedDeliveryOptions {
  allowLocalFallback?: boolean;
}

export class DeliveryAdapter {
  private readonly resend?: Resend;
  private readonly storageClient?: S3Client;

  constructor(private readonly cfg: DeliveryConfig) {
    if (cfg.resendApiKey) {
      this.resend = new Resend(cfg.resendApiKey);
    }
    if (cfg.storage?.bucket && cfg.storage?.accessKey && cfg.storage?.secretKey && cfg.storage?.region) {
      this.storageClient = new S3Client({
        region: cfg.storage.region,
        endpoint: cfg.storage.endpoint,
        forcePathStyle: Boolean(cfg.storage.endpoint),
        credentials: {
          accessKeyId: cfg.storage.accessKey,
          secretAccessKey: cfg.storage.secretKey
        }
      });
    }
  }

  async deliverQrByEmail(email: string, pngPath: string): Promise<DeliveryResult> {
    if (!this.resend) {
      throw new Error("Resend is not configured");
    }
    const buffer = await fs.readFile(pngPath);
    const fileName = path.basename(pngPath);
    await this.resend.emails.send({
      from: this.cfg.resendFrom ?? "Cognal <noreply@example.com>",
      to: [email],
      subject: "Cognal Signal Device Linking QR",
      html: "<p>Scanne den angehängten QR-Code in Signal unter Linked Devices.</p>",
      attachments: [
        {
          filename: fileName,
          content: buffer
        }
      ]
    });

    return {
      mode: "email",
      target: email
    };
  }

  async deliverQrByLink(pngPath: string): Promise<DeliveryResult> {
    if (!this.storageClient || !this.cfg.storage?.bucket) {
      return {
        mode: "local",
        target: pngPath
      };
    }

    const key = `qr/${randomUUID()}-${path.basename(pngPath)}`;
    const body = await fs.readFile(pngPath);

    await this.storageClient.send(
      new PutObjectCommand({
        Bucket: this.cfg.storage.bucket,
        Key: key,
        Body: body,
        ContentType: "image/png"
      })
    );

    const signed = await getSignedUrl(
      this.storageClient,
      new GetObjectCommand({
        Bucket: this.cfg.storage.bucket,
        Key: key
      }),
      { expiresIn: this.cfg.storage.ttlSec }
    );

    const expiresAt = new Date(Date.now() + this.cfg.storage.ttlSec * 1000).toISOString();

    return {
      mode: "link",
      target: signed,
      expiresAt
    };
  }

  async deliverQrByPublicEncrypted(
    pngPath: string,
    options: PublicEncryptedDeliveryOptions = {}
  ): Promise<DeliveryResult> {
    const allowLocalFallback = options.allowLocalFallback ?? false;
    const password = generatePassword(20);
    const pngBytes = await fs.readFile(pngPath);
    const { html } = createEncryptedViewerBundle(pngBytes, password);

    const securePath = path.join(
      path.dirname(pngPath),
      `${path.basename(pngPath, path.extname(pngPath))}.secure.html`
    );
    await fs.writeFile(securePath, html, "utf8");

    if (!this.cfg.publicDump?.endpoint) {
      if (!allowLocalFallback) {
        throw new Error(
          "public_encrypted delivery requires a public upload endpoint (set delivery.publicDump.endpoint or COGNAL_PUBLIC_DUMP_ENDPOINT)"
        );
      }
      return {
        mode: "local",
        target: securePath,
        secret: password
      };
    }

    try {
      const url = await this.uploadPublicFile(securePath, "text/html");
      return {
        mode: "public_encrypted",
        target: url,
        secret: password
      };
    } catch (err) {
      if (!allowLocalFallback) {
        throw new Error(`public_encrypted upload failed: ${String(err)}`);
      }
      return {
        mode: "local",
        target: securePath,
        secret: password
      };
    }
  }

  private async uploadPublicFile(filePath: string, mimeType: string): Promise<string> {
    if (!this.cfg.publicDump) {
      throw new Error("public dump is not configured");
    }
    const bytes = await fs.readFile(filePath);
    const body = new FormData();
    body.append(
      this.cfg.publicDump.fileField,
      new Blob([bytes], { type: mimeType }),
      path.basename(filePath)
    );

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.cfg.publicDump.timeoutSec * 1000);

    const response = await fetch(this.cfg.publicDump.endpoint, {
      method: "POST",
      body,
      signal: controller.signal
    }).finally(() => {
      clearTimeout(timeout);
    });

    if (!response.ok) {
      throw new Error(`public upload failed (${response.status})`);
    }

    const text = (await response.text()).trim();
    const url = text
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find((line) => /^https?:\/\//i.test(line));

    if (!url) {
      throw new Error(`public upload did not return URL: ${text}`);
    }

    return url;
  }
}

import { randomUUID } from "node:crypto";

export type ErrorCategory =
  | "generic"
  | "telegram_rate_limit"
  | "telegram_transient"
  | "telegram_auth"
  | "provider_rate_limit"
  | "provider_transient"
  | "provider_auth"
  | "stt_rate_limit"
  | "stt_transient"
  | "stt_auth";

export interface ClassifiedError {
  category: ErrorCategory;
  retryable: boolean;
  retryAfterMs?: number;
}

function parseRetryAfterMs(message: string): number | undefined {
  const match = message.match(/retry[_ ]after["=: ]+(\d+)/i) ?? message.match(/too many requests: retry after (\d+)/i);
  if (!match?.[1]) {
    return undefined;
  }
  const seconds = Number(match[1]);
  if (!Number.isFinite(seconds) || seconds <= 0) {
    return undefined;
  }
  return seconds * 1000;
}

function classifyFromMessage(
  message: string,
  categories: {
    rateLimit: ErrorCategory;
    transient: ErrorCategory;
    auth: ErrorCategory;
  }
): ClassifiedError {
  const normalized = message.toLowerCase();
  const retryAfterMs = parseRetryAfterMs(message);

  if (
    normalized.includes("429") ||
    normalized.includes("rate limit") ||
    normalized.includes("too many requests")
  ) {
    return { category: categories.rateLimit, retryable: true, retryAfterMs };
  }

  if (
    normalized.includes("401") ||
    normalized.includes("403") ||
    normalized.includes("unauthorized") ||
    normalized.includes("invalid api key") ||
    normalized.includes("missing bearer")
  ) {
    return { category: categories.auth, retryable: false };
  }

  if (
    normalized.includes("fetch failed") ||
    normalized.includes("econnreset") ||
    normalized.includes("enotfound") ||
    normalized.includes("socket hang up") ||
    normalized.includes("eai_again") ||
    normalized.includes("service unavailable") ||
    normalized.includes("bad gateway") ||
    normalized.includes("gateway timeout") ||
    normalized.includes(" 502") ||
    normalized.includes(" 503") ||
    normalized.includes(" 504")
  ) {
    return { category: categories.transient, retryable: true, retryAfterMs };
  }

  return { category: "generic", retryable: false };
}

export function classifyTelegramError(error: unknown): ClassifiedError {
  return classifyFromMessage(String(error), {
    rateLimit: "telegram_rate_limit",
    transient: "telegram_transient",
    auth: "telegram_auth"
  });
}

export function classifyProviderError(error: unknown): ClassifiedError {
  return classifyFromMessage(String(error), {
    rateLimit: "provider_rate_limit",
    transient: "provider_transient",
    auth: "provider_auth"
  });
}

export function classifySttError(error: unknown): ClassifiedError {
  return classifyFromMessage(String(error), {
    rateLimit: "stt_rate_limit",
    transient: "stt_transient",
    auth: "stt_auth"
  });
}

export function createDiagnosticId(): string {
  return randomUUID().split("-")[0];
}

export function formatProviderUserError(error: unknown, diagnosticId: string): string {
  const classified = classifyProviderError(error);
  switch (classified.category) {
    case "provider_rate_limit":
      return `Agent provider is rate-limited right now. Try again shortly. Error ID: ${diagnosticId}`;
    case "provider_auth":
      return `Agent provider authentication failed on the host. Ask the host admin to fix the provider credentials. Error ID: ${diagnosticId}`;
    case "provider_transient":
      return `Agent provider had a temporary upstream failure. Try again shortly. Error ID: ${diagnosticId}`;
    default:
      return `Agent execution failed. Error ID: ${diagnosticId}`;
  }
}

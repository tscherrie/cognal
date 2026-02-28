export class Logger {
  constructor(private readonly scope: string) {}

  info(message: string, data?: Record<string, unknown>): void {
    this.log("INFO", message, data);
  }

  warn(message: string, data?: Record<string, unknown>): void {
    this.log("WARN", message, data);
  }

  error(message: string, data?: Record<string, unknown>): void {
    this.log("ERROR", message, data);
  }

  private log(level: string, message: string, data?: Record<string, unknown>): void {
    const payload = {
      ts: new Date().toISOString(),
      level,
      scope: this.scope,
      message,
      ...(data ?? {})
    };
    process.stdout.write(`${JSON.stringify(payload)}\n`);
  }
}

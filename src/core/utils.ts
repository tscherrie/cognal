import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

export interface CommandResult {
  code: number;
  stdout: string;
  stderr: string;
}

export function runCommand(
  cmd: string,
  args: string[],
  options: {
    cwd?: string;
    env?: NodeJS.ProcessEnv;
    timeoutMs?: number;
    stdin?: string;
  } = {}
): Promise<CommandResult> {
  return new Promise((resolve) => {
    const proc = spawn(cmd, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: "pipe"
    });
    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });
    proc.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });

    if (options.stdin) {
      proc.stdin.write(options.stdin);
      proc.stdin.end();
    }

    let timedOut = false;
    let timeoutHandle: NodeJS.Timeout | null = null;
    if (options.timeoutMs && options.timeoutMs > 0) {
      timeoutHandle = setTimeout(() => {
        timedOut = true;
        proc.kill("SIGTERM");
      }, options.timeoutMs);
    }

    proc.on("close", (code) => {
      if (timeoutHandle) {
        clearTimeout(timeoutHandle);
      }
      resolve({
        code: timedOut ? -1 : code ?? 0,
        stdout,
        stderr: timedOut ? `${stderr}\nTimed out` : stderr
      });
    });

    proc.on("error", (err) => {
      if (timeoutHandle) {
        clearTimeout(timeoutHandle);
      }
      resolve({ code: -1, stdout, stderr: `${stderr}\n${err.message}` });
    });
  });
}

export async function commandExists(command: string): Promise<boolean> {
  const result = await runCommand("bash", ["-lc", `command -v ${command}`], { timeoutMs: 3000 });
  return result.code === 0;
}

export function chunkText(text: string, size: number): string[] {
  if (text.length <= size) {
    return [text];
  }
  const chunks: string[] = [];
  let index = 0;
  while (index < text.length) {
    const end = Math.min(index + size, text.length);
    chunks.push(text.slice(index, end));
    index = end;
  }
  return chunks;
}

export async function ensureDir(dirPath: string): Promise<void> {
  await fs.mkdir(dirPath, { recursive: true });
}

export function nowIso(): string {
  return new Date().toISOString();
}

export function safeFileName(input: string): string {
  return input.replace(/[^a-zA-Z0-9._-]/g, "_");
}

export async function copyToTemp(srcPath: string, tempDir: string): Promise<string> {
  const ext = path.extname(srcPath);
  const out = path.join(tempDir, `${randomUUID()}${ext}`);
  await fs.copyFile(srcPath, out);
  return out;
}

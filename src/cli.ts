#!/usr/bin/env node
import { Command } from "commander";
import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import process from "node:process";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";
import {
  loadOrCreateConfig,
  getRuntimePaths,
  ensureRuntimeDirs,
  saveConfig,
  enabledFromProviderSelection,
  providerSelectionFromEnabled,
  getDefaultAgent,
  isAgentEnabled
} from "./config.js";
import type { CognalConfig, ProviderSelection } from "./config.js";
import { Db } from "./core/db.js";
import { commandExists, runCommand, runInteractiveCommand } from "./core/utils.js";
import { Logger } from "./core/logger.js";
import type { AllowedChatRecord, HealthCheckResult } from "./types.js";
import { TelegramBotAdapter } from "./adapters/telegramBotAdapter.js";

const logger = new Logger("cli");
const CLI_ENTRYPOINT_PATH = fileURLToPath(import.meta.url);
const DIST_DIR = path.dirname(CLI_ENTRYPOINT_PATH);
const DAEMON_ENTRYPOINT_PATH = path.join(DIST_DIR, "daemon.js");
const INSTALL_ROOT = path.dirname(DIST_DIR);

interface ProviderRuntimeSpec {
  label: "Claude" | "Codex";
  command: string;
  installPackage: string;
  setupArgs: string[];
  apiKeyEnv: string;
  apiKeyUrl: string;
}

type ProviderAuthMode = "api_key" | "auth_login";

function parseProviderSelection(value: string): ProviderSelection {
  const normalized = value.trim().toLowerCase();
  if (normalized === "claude" || normalized === "codex" || normalized === "both") {
    return normalized;
  }
  throw new Error(`Unknown provider selection '${value}'. Use: claude, codex, both`);
}

async function promptProviderSelection(defaultSelection: ProviderSelection): Promise<ProviderSelection> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    return defaultSelection;
  }

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    process.stdout.write("Choose provider mode:\n");
    process.stdout.write("  1) codex\n");
    process.stdout.write("  2) claude\n");
    process.stdout.write("  3) both\n");
    const answer = (await rl.question(`Providers [${defaultSelection}]: `)).trim().toLowerCase();
    if (!answer) {
      return defaultSelection;
    }
    if (answer === "1") {
      return "codex";
    }
    if (answer === "2") {
      return "claude";
    }
    if (answer === "3") {
      return "both";
    }
    return parseProviderSelection(answer);
  } finally {
    rl.close();
  }
}

async function promptYesNo(question: string, defaultYes: boolean): Promise<boolean> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    return defaultYes;
  }
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const suffix = defaultYes ? "[Y/n]" : "[y/N]";
    const answer = (await rl.question(`${question} ${suffix}: `)).trim().toLowerCase();
    if (!answer) {
      return defaultYes;
    }
    if (["y", "yes"].includes(answer)) {
      return true;
    }
    if (["n", "no"].includes(answer)) {
      return false;
    }
    return defaultYes;
  } finally {
    rl.close();
  }
}

async function promptText(question: string, defaultValue = ""): Promise<string> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    return defaultValue;
  }
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const suffix = defaultValue ? ` [${defaultValue}]` : "";
    const answer = (await rl.question(`${question}${suffix}: `)).trim();
    return answer || defaultValue;
  } finally {
    rl.close();
  }
}

function resolveProjectRoot(input?: string): string {
  return input ? path.resolve(input) : process.cwd();
}

function validateTelegramUserId(value: string): string {
  const trimmed = value.trim();
  if (!/^\d{5,20}$/.test(trimmed)) {
    throw new Error(`Invalid telegram user ID: ${value}`);
  }
  return trimmed;
}

function validateChatId(value: string): string {
  const trimmed = value.trim();
  if (!/^-?\d{5,20}$/.test(trimmed)) {
    throw new Error(`Invalid chat ID: ${value}`);
  }
  return trimmed;
}

function parseCsv(input: string): string[] {
  return input
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
}

function printTelegramBotFatherGuide(tokenEnvName: string): void {
  process.stdout.write("\nTelegram Bot Setup (BotFather) - step by step:\n");
  process.stdout.write("  1) Open Telegram and search for @BotFather\n");
  process.stdout.write("  2) Send /start\n");
  process.stdout.write("  3) Send /newbot\n");
  process.stdout.write("  4) Enter a display name (example: Cognal Project Bot)\n");
  process.stdout.write("  5) Enter a unique username ending with 'bot' (example: cognal_myproj_bot)\n");
  process.stdout.write("  6) BotFather returns an HTTP API token (format: 123456789:AA...)\n");
  process.stdout.write("  7) Paste that token below into this setup prompt\n");
  process.stdout.write("  8) Optional: use /setprivacy in BotFather and disable privacy for richer group context\n");
  process.stdout.write(`  9) Cognal stores this token in ./.cognal/cognald.env as ${tokenEnvName}\n\n`);
}

function parseEnvFile(raw: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }
    const idx = trimmed.indexOf("=");
    if (idx <= 0) {
      continue;
    }
    const key = trimmed.slice(0, idx).trim();
    let value = trimmed.slice(idx + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"') && value.length >= 2) ||
      (value.startsWith("'") && value.endsWith("'") && value.length >= 2)
    ) {
      value = value.slice(1, -1);
    }
    env[key] = value;
  }
  return env;
}

function envValueForFile(value: string): string {
  if (/^[A-Za-z0-9_./:@%+=,-]+$/.test(value)) {
    return value;
  }
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

async function readDaemonEnv(envPath: string): Promise<Record<string, string>> {
  try {
    return parseEnvFile(await fs.readFile(envPath, "utf8"));
  } catch {
    return {};
  }
}

async function writeDaemonEnv(envPath: string, env: Record<string, string>): Promise<void> {
  const lines = Object.entries(env)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${key}=${envValueForFile(value)}`);
  await fs.writeFile(envPath, `${lines.join("\n")}\n`, "utf8");
  try {
    await fs.chmod(envPath, 0o600);
  } catch {
    // best effort
  }
}

async function upsertDaemonEnv(envPath: string, updates: Record<string, string>): Promise<void> {
  const env = await readDaemonEnv(envPath);
  for (const [key, value] of Object.entries(updates)) {
    if (!value) {
      continue;
    }
    env[key] = value;
  }
  await writeDaemonEnv(envPath, env);
}

async function removeDaemonEnvKeys(envPath: string, keys: string[]): Promise<void> {
  const env = await readDaemonEnv(envPath);
  for (const key of keys) {
    delete env[key];
  }
  await writeDaemonEnv(envPath, env);
}

function parseProviderAuthMode(value: string): ProviderAuthMode {
  const normalized = value.trim().toLowerCase();
  if (normalized === "1" || normalized === "api" || normalized === "api_key" || normalized === "api-key") {
    return "api_key";
  }
  if (normalized === "2" || normalized === "auth" || normalized === "auth_login" || normalized === "auth-login") {
    return "auth_login";
  }
  throw new Error(`Unknown auth mode '${value}'. Use: api_key or auth_login`);
}

async function promptProviderAuthMode(spec: ProviderRuntimeSpec): Promise<ProviderAuthMode> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    return process.env[spec.apiKeyEnv]?.trim() ? "api_key" : "auth_login";
  }

  process.stdout.write(`Choose ${spec.label} auth mode:\n`);
  process.stdout.write("  1) api_key (recommended for servers)\n");
  process.stdout.write("  2) auth_login (browser OAuth)\n");
  const answer = await promptText(`Auth mode for ${spec.label} [api_key]`);
  if (!answer.trim()) {
    return "api_key";
  }
  return parseProviderAuthMode(answer);
}

async function openDb(projectRoot: string): Promise<{ db: Db; paths: ReturnType<typeof getRuntimePaths> }> {
  const paths = getRuntimePaths(projectRoot);
  await ensureRuntimeDirs(paths);
  const db = new Db(paths.dbPath);
  await db.migrate();
  return { db, paths };
}

async function loadProjectConfig(projectRoot: string): Promise<{
  paths: ReturnType<typeof getRuntimePaths>;
  cfg: Awaited<ReturnType<typeof loadOrCreateConfig>>;
}> {
  const paths = getRuntimePaths(projectRoot);
  await ensureRuntimeDirs(paths);
  const cfg = await loadOrCreateConfig(paths);
  return { paths, cfg };
}

async function getConfigAndDb(projectRoot: string): Promise<{
  db: Db;
  paths: ReturnType<typeof getRuntimePaths>;
  cfg: Awaited<ReturnType<typeof loadOrCreateConfig>>;
}> {
  const { db, paths } = await openDb(projectRoot);
  const cfg = await loadOrCreateConfig(paths);
  return { db, paths, cfg };
}

async function installSystemdUnit(projectRoot: string, cfg: CognalConfig, extraEnv: Record<string, string> = {}): Promise<void> {
  const serviceName = cfg.runtime.serviceName;
  const runUser = process.env.SUDO_USER || process.env.USER || "root";
  const unit = `[Unit]
Description=Cognal Daemon
After=network.target

[Service]
Type=simple
WorkingDirectory=${projectRoot}
EnvironmentFile=${projectRoot}/.cognal/cognald.env
ExecStart=${process.execPath} ${DAEMON_ENTRYPOINT_PATH}
User=${runUser}
Restart=always
RestartSec=2

[Install]
WantedBy=multi-user.target
`;

  const paths = getRuntimePaths(projectRoot);
  const localUnitPath = path.join(paths.cognalDir, `${serviceName}.service`);
  const envPath = path.join(paths.cognalDir, "cognald.env");
  await fs.writeFile(localUnitPath, unit, "utf8");
  await upsertDaemonEnv(envPath, {
    COGNAL_PROJECT_ROOT: projectRoot,
    ...extraEnv
  });

  const hasSystemctl = await commandExists("systemctl");
  if (!hasSystemctl) {
    logger.warn("systemctl not found. Skipping systemd install.");
    return;
  }

  const copyCode = await runInteractiveCommand("bash", ["-lc", `sudo cp '${localUnitPath}' /etc/systemd/system/${serviceName}.service`]);
  if (copyCode !== 0) {
    logger.warn("could not install systemd unit automatically", {
      stderr: "sudo cp failed",
      hint: `Manual install: sudo cp '${localUnitPath}' /etc/systemd/system/${serviceName}.service`
    });
    return;
  }

  const enableCode = await runInteractiveCommand("bash", ["-lc", `sudo systemctl daemon-reload && sudo systemctl enable --now ${serviceName}`]);
  if (enableCode !== 0) {
    logger.warn("could not enable service automatically", {
      stderr: "sudo systemctl enable/start failed",
      hint: `Run: sudo systemctl daemon-reload && sudo systemctl enable --now ${serviceName}`
    });
    return;
  }

  logger.info("systemd unit installed", { service: serviceName });
}

async function uninstallSystemdUnit(cfg: CognalConfig): Promise<void> {
  const serviceName = cfg.runtime.serviceName;
  const hasSystemctl = await commandExists("systemctl");
  if (!hasSystemctl) {
    process.stdout.write("systemctl not found. Skipping service cleanup.\n");
    return;
  }

  const cmd = [
    `sudo systemctl disable --now ${serviceName} >/dev/null 2>&1 || true`,
    `sudo rm -f /etc/systemd/system/${serviceName}.service`,
    "sudo systemctl daemon-reload",
    "sudo systemctl reset-failed"
  ].join(" && ");

  const code = await runInteractiveCommand("bash", ["-lc", cmd]);
  if (code !== 0) {
    process.stdout.write(`Warning: service uninstall may be incomplete for ${serviceName}\n`);
    return;
  }
  process.stdout.write(`Removed service ${serviceName}\n`);
}

function enabledProviderSpecs(cfg: CognalConfig): ProviderRuntimeSpec[] {
  const specs: ProviderRuntimeSpec[] = [];
  if (cfg.agents.enabled.claude) {
    specs.push({
      label: "Claude",
      command: cfg.agents.claude.command,
      installPackage: "@anthropic-ai/claude-code@latest",
      setupArgs: ["auth", "login"],
      apiKeyEnv: "ANTHROPIC_API_KEY",
      apiKeyUrl: "https://console.anthropic.com/settings/keys"
    });
  }
  if (cfg.agents.enabled.codex) {
    specs.push({
      label: "Codex",
      command: cfg.agents.codex.command,
      installPackage: "@openai/codex@latest",
      setupArgs: ["login"],
      apiKeyEnv: "OPENAI_API_KEY",
      apiKeyUrl: "https://platform.openai.com/api-keys"
    });
  }
  return specs;
}

async function installProviderCli(spec: ProviderRuntimeSpec): Promise<void> {
  process.stdout.write(`Installing ${spec.label} CLI (${spec.installPackage})...\n`);
  const code = await runInteractiveCommand("npm", ["i", "-g", spec.installPackage]);
  if (code !== 0) {
    throw new Error(`Failed to install ${spec.label} CLI via npm i -g ${spec.installPackage}`);
  }
  const ok = await commandExists(spec.command);
  if (!ok) {
    throw new Error(`${spec.label} CLI install completed but '${spec.command}' is still missing in PATH`);
  }
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

async function runProviderSetupWithArgs(command: string, args: string[]): Promise<void> {
  const fullCommand = [command, ...args].map(shellQuote).join(" ");
  const code = await runInteractiveCommand("bash", ["-lc", fullCommand]);
  if (code !== 0) {
    throw new Error(`${command} ${args.join(" ")} exited with code ${code}`);
  }
}

async function runSetupOnboarding(projectRoot: string, cfg: CognalConfig): Promise<void> {
  const { db } = await openDb(projectRoot);
  try {
    const addNow = await promptYesNo("Add initial allowed Telegram users/chats now?", false);
    if (!addNow) {
      return;
    }

    process.stdout.write("Telegram user ID example: 123456789\n");
    const usersRaw = await promptText("Allowed Telegram user IDs (comma-separated, empty to skip)");
    for (const rawId of parseCsv(usersRaw)) {
      const userId = validateTelegramUserId(rawId);
      await db.addOrUpdateTelegramUser(userId, {
        status: "active",
        defaultActiveAgent: getDefaultAgent(cfg)
      });
      process.stdout.write(`Allowed user: ${userId}\n`);
    }

    if (cfg.telegram.allowGroups) {
      process.stdout.write("Telegram group chat ID example: -1001234567890\n");
      const chatsRaw = await promptText("Allowed group/supergroup chat IDs (comma-separated, empty to skip)");
      for (const rawChat of parseCsv(chatsRaw)) {
        const chatId = validateChatId(rawChat);
        await db.allowChat(chatId, "supergroup", null);
        process.stdout.write(`Allowed chat: ${chatId}\n`);
      }
    }
  } finally {
    await db.close();
  }
}

async function doctorChecks(projectRoot: string, cfg: CognalConfig): Promise<HealthCheckResult[]> {
  const checks: HealthCheckResult[] = [];
  const binaries = ["node", "npm", "systemctl"];
  if (cfg.agents.enabled.claude) {
    binaries.push("claude");
  }
  if (cfg.agents.enabled.codex) {
    binaries.push("codex");
  }

  for (const bin of binaries) {
    const ok = await commandExists(bin);
    checks.push({ name: `binary:${bin}`, ok, details: ok ? "ok" : "missing" });
  }

  const distro = await runCommand("bash", ["-lc", "source /etc/os-release && echo ${ID:-unknown}"], { timeoutMs: 2_000 });
  const distroId = distro.stdout.trim();
  checks.push({
    name: "os:distro",
    ok: distroId === "ubuntu" || distroId === "debian",
    details: distroId || "unknown"
  });

  const paths = getRuntimePaths(projectRoot);
  try {
    await fs.access(paths.configPath);
    checks.push({ name: "config", ok: true, details: paths.configPath });
  } catch {
    checks.push({ name: "config", ok: false, details: "missing config.toml" });
  }

  const envPath = path.join(paths.cognalDir, "cognald.env");
  const daemonEnv = await readDaemonEnv(envPath);
  const botToken = daemonEnv[cfg.telegram.botTokenEnv] || process.env[cfg.telegram.botTokenEnv] || "";
  checks.push({
    name: `env:${cfg.telegram.botTokenEnv}`,
    ok: Boolean(botToken),
    details: botToken ? "set" : "missing"
  });

  if (botToken) {
    try {
      const adapter = new TelegramBotAdapter(botToken, paths.telegramOffsetPath, cfg.telegram.botUsername);
      const me = await adapter.getIdentity();
      checks.push({ name: "telegram:getMe", ok: true, details: `@${me.username}` });
    } catch (err) {
      checks.push({ name: "telegram:getMe", ok: false, details: String(err) });
    }
  } else {
    checks.push({ name: "telegram:getMe", ok: false, details: "skipped (missing token)" });
  }

  const serviceName = cfg.runtime.serviceName;
  const serviceEnabled = await runCommand("bash", ["-lc", `systemctl is-enabled ${serviceName}`], { timeoutMs: 3_000 });
  checks.push({
    name: `service:${serviceName}:enabled`,
    ok: serviceEnabled.code === 0,
    details: serviceEnabled.stdout.trim() || serviceEnabled.stderr.trim() || "unknown"
  });

  const serviceActive = await runCommand("bash", ["-lc", `systemctl is-active ${serviceName}`], { timeoutMs: 3_000 });
  checks.push({
    name: `service:${serviceName}:active`,
    ok: serviceActive.code === 0,
    details: serviceActive.stdout.trim() || serviceActive.stderr.trim() || "unknown"
  });

  return checks;
}

const program = new Command();

program
  .name("cognal")
  .description("Telegram bridge for Claude Code and Codex")
  .option("-p, --project-root <path>", "Project root path")
  .showHelpAfterError();

program
  .command("setup")
  .option("--run-provider-setup", "Force native Claude/Codex setup flows (also without TTY)", false)
  .option("--skip-provider-install", "Skip automatic install for missing provider CLIs", false)
  .option("--skip-provider-setup", "Skip native provider login/setup flows", false)
  .option("--distro <ubuntu|debian>", "Set distro in config")
  .option("--providers <claude|codex|both>", "Enabled providers")
  .option("--skip-onboarding", "Skip interactive onboarding", false)
  .action(async (opts, cmd) => {
    const projectRoot = resolveProjectRoot(cmd.parent?.opts().projectRoot);
    const { db, paths, cfg } = await getConfigAndDb(projectRoot);

    const defaultProviders = providerSelectionFromEnabled(cfg.agents.enabled);
    const selectedProviders = opts.providers ? parseProviderSelection(opts.providers) : await promptProviderSelection(defaultProviders);
    cfg.agents.enabled = enabledFromProviderSelection(selectedProviders);

    if (opts.distro) {
      cfg.runtime.distro = opts.distro;
    }

    if (process.stdin.isTTY && process.stdout.isTTY) {
      cfg.telegram.allowGroups = await promptYesNo("Enable Telegram group/supergroup chats?", true);
    }

    const envPath = path.join(paths.cognalDir, "cognald.env");
    const daemonEnv = await readDaemonEnv(envPath);
    const currentToken = daemonEnv[cfg.telegram.botTokenEnv] || process.env[cfg.telegram.botTokenEnv] || "";
    if (process.stdin.isTTY && process.stdout.isTTY && !currentToken) {
      printTelegramBotFatherGuide(cfg.telegram.botTokenEnv);
    }
    const tokenPrompt = currentToken ? `${cfg.telegram.botTokenEnv} (leave empty to keep current)` : `${cfg.telegram.botTokenEnv}`;
    const enteredToken = (await promptText(`Telegram bot token ${tokenPrompt}`)).trim();
    const finalToken = enteredToken || currentToken;
    if (!finalToken) {
      await db.close();
      throw new Error(`Missing Telegram bot token (${cfg.telegram.botTokenEnv})`);
    }

    const telegram = new TelegramBotAdapter(finalToken, paths.telegramOffsetPath, cfg.telegram.botUsername);
    const identity = await telegram.getIdentity();
    cfg.telegram.botUsername = identity.username;

    await saveConfig(paths, cfg);
    await upsertDaemonEnv(envPath, { [cfg.telegram.botTokenEnv]: finalToken, COGNAL_PROJECT_ROOT: projectRoot });

    process.stdout.write(`Provider mode: ${selectedProviders}\n`);
    process.stdout.write(`Telegram bot: @${identity.username}\n`);

    const checks = await doctorChecks(projectRoot, cfg);
    for (const check of checks) {
      process.stdout.write(`${check.ok ? "[OK]" : "[WARN]"} ${check.name} -> ${check.details}\n`);
    }

    const providerSpecs = enabledProviderSpecs(cfg);
    const providerAuthModes = new Map<string, ProviderAuthMode>();
    const daemonEnvUpdates: Record<string, string> = {
      [cfg.telegram.botTokenEnv]: finalToken
    };

    if (!opts.skipOnboarding) {
      await runSetupOnboarding(projectRoot, cfg);
    }

    if (!opts.skipProviderInstall) {
      for (const spec of providerSpecs) {
        const exists = await commandExists(spec.command);
        if (!exists) {
          await installProviderCli(spec);
          process.stdout.write(`[OK] ${spec.label} CLI installed.\n`);
        }
      }
    }

    let shouldRunProviderSetup = false;
    if (!opts.skipProviderSetup) {
      if (opts.runProviderSetup) {
        shouldRunProviderSetup = true;
      } else {
        shouldRunProviderSetup = process.stdin.isTTY && process.stdout.isTTY;
        if (!shouldRunProviderSetup) {
          process.stdout.write("[WARN] Non-interactive shell detected. Skipping native provider setup/login. Use --run-provider-setup to force.\n");
        }
      }
    }

    if (shouldRunProviderSetup) {
      for (const spec of providerSpecs) {
        const authMode = await promptProviderAuthMode(spec);
        providerAuthModes.set(spec.command, authMode);

        if (authMode !== "api_key") {
          if (spec.label === "Claude" && (process.env.SSH_CONNECTION || process.env.SSH_CLIENT || process.env.SSH_TTY)) {
            process.stdout.write("[WARN] Claude auth_login on SSH/headless hosts may hang after browser auth; api_key is more reliable.\n");
          }
          continue;
        }

        process.stdout.write(`${spec.label} API key URL: ${spec.apiKeyUrl}\n`);
        const existing = process.env[spec.apiKeyEnv]?.trim() ?? "";
        const keyPrompt = existing ? `Paste ${spec.apiKeyEnv} (leave empty to keep current value)` : `Paste ${spec.apiKeyEnv}`;
        const entered = (await promptText(keyPrompt)).trim();
        const finalKey = entered || existing;
        if (!finalKey) {
          process.stdout.write(`[WARN] No ${spec.apiKeyEnv} provided. Falling back to native ${spec.label} auth login.\n`);
          providerAuthModes.set(spec.command, "auth_login");
          continue;
        }

        daemonEnvUpdates[spec.apiKeyEnv] = finalKey;
        process.env[spec.apiKeyEnv] = finalKey;
        process.stdout.write(`[OK] ${spec.apiKeyEnv} configured for ${spec.label}.\n`);
      }

      for (const spec of providerSpecs) {
        const exists = await commandExists(spec.command);
        if (!exists) {
          process.stdout.write(`[WARN] Skipping ${spec.label} setup because '${spec.command}' is missing.\n`);
          continue;
        }

        const authMode = providerAuthModes.get(spec.command) ?? (process.env[spec.apiKeyEnv]?.trim() ? "api_key" : "auth_login");
        if (authMode === "api_key" && process.env[spec.apiKeyEnv]?.trim()) {
          process.stdout.write(`[OK] Using ${spec.apiKeyEnv} for ${spec.label}. Skipping auth login.\n`);
          continue;
        }

        process.stdout.write(`Running native ${spec.label} setup...\n`);
        await runProviderSetupWithArgs(spec.command, spec.setupArgs);
      }
    }

    await installSystemdUnit(projectRoot, cfg, daemonEnvUpdates);
    await db.close();
    process.stdout.write("Setup complete. Run 'cognal doctor' for final verification.\n");
  });

program
  .command("start")
  .action(async (_, cmd) => {
    const projectRoot = resolveProjectRoot(cmd.parent?.opts().projectRoot);
    const { cfg } = await loadProjectConfig(projectRoot);
    const result = await runInteractiveCommand("bash", ["-lc", `sudo systemctl start ${cfg.runtime.serviceName}`]);
    if (result !== 0) {
      throw new Error(`Failed to start ${cfg.runtime.serviceName}`);
    }
    process.stdout.write(`${cfg.runtime.serviceName} started\n`);
  });

program
  .command("stop")
  .action(async (_, cmd) => {
    const projectRoot = resolveProjectRoot(cmd.parent?.opts().projectRoot);
    const { cfg } = await loadProjectConfig(projectRoot);
    const result = await runInteractiveCommand("bash", ["-lc", `sudo systemctl stop ${cfg.runtime.serviceName}`]);
    if (result !== 0) {
      throw new Error(`Failed to stop ${cfg.runtime.serviceName}`);
    }
    process.stdout.write(`${cfg.runtime.serviceName} stopped\n`);
  });

program
  .command("restart")
  .action(async (_, cmd) => {
    const projectRoot = resolveProjectRoot(cmd.parent?.opts().projectRoot);
    const { cfg } = await loadProjectConfig(projectRoot);
    const result = await runInteractiveCommand("bash", ["-lc", `sudo systemctl restart ${cfg.runtime.serviceName}`]);
    if (result !== 0) {
      throw new Error(`Failed to restart ${cfg.runtime.serviceName}`);
    }
    process.stdout.write(`${cfg.runtime.serviceName} restarted\n`);
  });

program
  .command("status")
  .action(async (_, cmd) => {
    const projectRoot = resolveProjectRoot(cmd.parent?.opts().projectRoot);
    const { cfg } = await loadProjectConfig(projectRoot);
    const result = await runCommand("bash", ["-lc", `systemctl is-active ${cfg.runtime.serviceName}`], { timeoutMs: 3_000 });
    process.stdout.write((result.stdout.trim() || "unknown") + "\n");
  });

program
  .command("logs")
  .option("--follow", "Follow logs", false)
  .action(async (opts, cmd) => {
    const projectRoot = resolveProjectRoot(cmd.parent?.opts().projectRoot);
    const { cfg } = await loadProjectConfig(projectRoot);
    const args = opts.follow ? ["-u", cfg.runtime.serviceName, "-f"] : ["-u", cfg.runtime.serviceName, "-n", "200"];
    const proc = spawn("journalctl", args, { stdio: "inherit" });
    await new Promise<void>((resolve) => {
      proc.on("exit", () => resolve());
    });
  });

async function userAddAction(telegramUserIdRaw: string, projectRoot: string, username?: string): Promise<void> {
  const telegramUserId = validateTelegramUserId(telegramUserIdRaw);
  const { db, cfg } = await getConfigAndDb(projectRoot);
  try {
    const user = await db.addOrUpdateTelegramUser(telegramUserId, {
      username: username ?? null,
      status: "active",
      defaultActiveAgent: getDefaultAgent(cfg)
    });
    const binding = await db.getBinding(user.id, getDefaultAgent(cfg));
    if (!isAgentEnabled(cfg, binding.activeAgent)) {
      await db.setActiveAgent(user.id, getDefaultAgent(cfg));
    }
    process.stdout.write(`Allowed Telegram user ${telegramUserId}\n`);
  } finally {
    await db.close();
  }
}

async function userListAction(projectRoot: string): Promise<void> {
  const { db } = await getConfigAndDb(projectRoot);
  try {
    const users = await db.listUsers();
    const rows = users.map((u) => ({
      id: u.id,
      telegramUserId: u.telegramUserId ?? "-",
      telegramUsername: u.telegramUsername ?? "-",
      displayName: u.displayName ?? "-",
      status: u.status,
      lastSeenAt: u.lastSeenAt ?? "-",
      createdAt: u.createdAt
    }));
    console.table(rows);
  } finally {
    await db.close();
  }
}

async function userRevokeAction(telegramUserIdRaw: string, projectRoot: string): Promise<void> {
  const telegramUserId = validateTelegramUserId(telegramUserIdRaw);
  const { db } = await getConfigAndDb(projectRoot);
  try {
    const changed = await db.revokeByTelegramUserId(telegramUserId);
    if (!changed) {
      throw new Error(`Unknown Telegram user ID: ${telegramUserId}`);
    }
    process.stdout.write(`Revoked Telegram user ${telegramUserId}\n`);
  } finally {
    await db.close();
  }
}

async function userRequestsAction(projectRoot: string): Promise<void> {
  const { db } = await getConfigAndDb(projectRoot);
  try {
    const requests = await db.listAccessRequests("pending");
    const rows = requests.map((r) => ({
      telegramUserId: r.telegramUserId,
      chatId: r.chatId,
      username: r.username ?? "-",
      displayName: r.displayName ?? "-",
      firstSeenAt: r.firstSeenAt,
      lastSeenAt: r.lastSeenAt,
      status: r.status
    }));
    console.table(rows);
  } finally {
    await db.close();
  }
}

async function userApproveAction(telegramUserIdRaw: string, projectRoot: string): Promise<void> {
  const telegramUserId = validateTelegramUserId(telegramUserIdRaw);
  const { db, cfg } = await getConfigAndDb(projectRoot);
  try {
    await db.approveAccessRequest(telegramUserId, getDefaultAgent(cfg));
    process.stdout.write(`Approved Telegram user ${telegramUserId}\n`);
  } finally {
    await db.close();
  }
}

async function chatAllowAction(chatIdRaw: string, projectRoot: string, type: AllowedChatRecord["chatType"], title?: string): Promise<void> {
  const chatId = validateChatId(chatIdRaw);
  const { db } = await getConfigAndDb(projectRoot);
  try {
    await db.allowChat(chatId, type, title ?? null);
    process.stdout.write(`Allowed chat ${chatId} (${type})\n`);
  } finally {
    await db.close();
  }
}

async function chatRevokeAction(chatIdRaw: string, projectRoot: string): Promise<void> {
  const chatId = validateChatId(chatIdRaw);
  const { db } = await getConfigAndDb(projectRoot);
  try {
    const changed = await db.revokeChat(chatId);
    if (!changed) {
      throw new Error(`Unknown chat ID: ${chatId}`);
    }
    process.stdout.write(`Revoked chat ${chatId}\n`);
  } finally {
    await db.close();
  }
}

async function chatListAction(projectRoot: string): Promise<void> {
  const { db } = await getConfigAndDb(projectRoot);
  try {
    const chats = await db.listAllowedChats();
    console.table(
      chats.map((chat) => ({
        chatId: chat.chatId,
        chatType: chat.chatType,
        title: chat.title ?? "-",
        createdAt: chat.createdAt
      }))
    );
  } finally {
    await db.close();
  }
}

const userCommand = program.command("user").description("User management");

userCommand
  .command("add")
  .requiredOption("--telegram-user-id <id>", "Telegram user ID")
  .option("--username <name>", "Telegram username")
  .action(async (opts, cmd) => {
    const projectRoot = resolveProjectRoot(cmd.parent?.parent?.opts().projectRoot);
    await userAddAction(opts.telegramUserId, projectRoot, opts.username);
  });

userCommand.command("list").action(async (_, cmd) => {
  const projectRoot = resolveProjectRoot(cmd.parent?.parent?.opts().projectRoot);
  await userListAction(projectRoot);
});

userCommand
  .command("revoke")
  .requiredOption("--telegram-user-id <id>", "Telegram user ID")
  .action(async (opts, cmd) => {
    const projectRoot = resolveProjectRoot(cmd.parent?.parent?.opts().projectRoot);
    await userRevokeAction(opts.telegramUserId, projectRoot);
  });

userCommand.command("requests").action(async (_, cmd) => {
  const projectRoot = resolveProjectRoot(cmd.parent?.parent?.opts().projectRoot);
  await userRequestsAction(projectRoot);
});

userCommand
  .command("approve")
  .requiredOption("--telegram-user-id <id>", "Telegram user ID")
  .action(async (opts, cmd) => {
    const projectRoot = resolveProjectRoot(cmd.parent?.parent?.opts().projectRoot);
    await userApproveAction(opts.telegramUserId, projectRoot);
  });

// Legacy aliases
program
  .command("user:add")
  .requiredOption("--telegram-user-id <id>", "Telegram user ID")
  .option("--username <name>", "Telegram username")
  .action(async (opts, cmd) => {
    const projectRoot = resolveProjectRoot(cmd.parent?.opts().projectRoot);
    await userAddAction(opts.telegramUserId, projectRoot, opts.username);
  });

program.command("user:list").action(async (_, cmd) => {
  const projectRoot = resolveProjectRoot(cmd.parent?.opts().projectRoot);
  await userListAction(projectRoot);
});

program
  .command("user:revoke")
  .requiredOption("--telegram-user-id <id>", "Telegram user ID")
  .action(async (opts, cmd) => {
    const projectRoot = resolveProjectRoot(cmd.parent?.opts().projectRoot);
    await userRevokeAction(opts.telegramUserId, projectRoot);
  });

program.command("user:requests").action(async (_, cmd) => {
  const projectRoot = resolveProjectRoot(cmd.parent?.opts().projectRoot);
  await userRequestsAction(projectRoot);
});

program
  .command("user:approve")
  .requiredOption("--telegram-user-id <id>", "Telegram user ID")
  .action(async (opts, cmd) => {
    const projectRoot = resolveProjectRoot(cmd.parent?.opts().projectRoot);
    await userApproveAction(opts.telegramUserId, projectRoot);
  });

const chatCommand = program.command("chat").description("Telegram chat allow-list management");

chatCommand
  .command("allow")
  .requiredOption("--chat-id <id>", "Telegram chat ID")
  .option("--type <private|group|supergroup|channel>", "Chat type", "supergroup")
  .option("--title <title>", "Optional chat title")
  .action(async (opts, cmd) => {
    const projectRoot = resolveProjectRoot(cmd.parent?.parent?.opts().projectRoot);
    const type = opts.type as AllowedChatRecord["chatType"];
    if (!["private", "group", "supergroup", "channel"].includes(type)) {
      throw new Error(`Invalid chat type: ${opts.type}`);
    }
    await chatAllowAction(opts.chatId, projectRoot, type, opts.title);
  });

chatCommand
  .command("revoke")
  .requiredOption("--chat-id <id>", "Telegram chat ID")
  .action(async (opts, cmd) => {
    const projectRoot = resolveProjectRoot(cmd.parent?.parent?.opts().projectRoot);
    await chatRevokeAction(opts.chatId, projectRoot);
  });

chatCommand.command("list").action(async (_, cmd) => {
  const projectRoot = resolveProjectRoot(cmd.parent?.parent?.opts().projectRoot);
  await chatListAction(projectRoot);
});

program
  .command("doctor")
  .action(async (_, cmd) => {
    const projectRoot = resolveProjectRoot(cmd.parent?.opts().projectRoot);
    const { cfg } = await loadProjectConfig(projectRoot);
    const checks = await doctorChecks(projectRoot, cfg);
    for (const check of checks) {
      process.stdout.write(`${check.ok ? "[OK]" : "[WARN]"} ${check.name}: ${check.details}\n`);
    }
  });

program
  .command("update")
  .action(async (__, cmd) => {
    const projectRoot = resolveProjectRoot(cmd.parent?.opts().projectRoot);
    const { cfg } = await loadProjectConfig(projectRoot);

    const steps: Array<{ title: string; command: string }> = [
      { title: "Update Cognal (git)", command: `cd '${INSTALL_ROOT}' && git fetch --all --tags && git pull --ff-only` },
      { title: "Install dependencies", command: `cd '${INSTALL_ROOT}' && npm install` },
      { title: "Build", command: `cd '${INSTALL_ROOT}' && npm run build` },
      { title: "Relink", command: "npm link" }
    ];

    if (cfg.agents.enabled.claude) {
      steps.push({ title: "Update Claude", command: "npm i -g @anthropic-ai/claude-code@latest" });
    }
    if (cfg.agents.enabled.codex) {
      steps.push({ title: "Update Codex", command: "npm i -g @openai/codex@latest" });
    }

    steps.push(
      { title: "Restart service", command: `sudo systemctl restart ${cfg.runtime.serviceName}` },
      { title: "Doctor", command: `node '${path.join(INSTALL_ROOT, "dist/cli.js")}' -p '${projectRoot}' doctor` }
    );

    for (const step of steps) {
      process.stdout.write(`==> ${step.title}\n`);
      const code = await runInteractiveCommand("bash", ["-lc", step.command]);
      if (code !== 0) {
        throw new Error(`Update step failed: ${step.title}`);
      }
    }

    process.stdout.write("Update complete.\n");
  });

program
  .command("uninstall")
  .description("Remove Cognal service and optionally workspace/global/provider and telegram access state")
  .option("--yes", "Skip confirmation prompts", false)
  .option("--remove-workspace", "Remove project-local .cognal directory", false)
  .option("--remove-global", "Run npm unlink -g cognal", false)
  .option("--remove-claude-cli", "Run npm uninstall -g @anthropic-ai/claude-code", false)
  .option("--remove-codex-cli", "Run npm uninstall -g @openai/codex", false)
  .option("--remove-providers", "Remove both provider CLIs", false)
  .option("--remove-telegram-state", "Remove telegram token + chat/user allow data from workspace state", false)
  .option("--all", "Remove service, workspace, global link, providers, and telegram state", false)
  .action(async (opts, cmd) => {
    const projectRoot = resolveProjectRoot(cmd.parent?.opts().projectRoot);
    const { cfg, paths } = await loadProjectConfig(projectRoot);

    const hasClaude = await commandExists("claude");
    const hasCodex = await commandExists("codex");

    const removeService = true;
    const removeWorkspace = opts.all || opts.removeWorkspace || (opts.yes ? false : await promptYesNo(`Remove workspace state '${paths.cognalDir}'?`, false));
    const removeGlobal = opts.all || opts.removeGlobal || (opts.yes ? false : await promptYesNo("Remove global CLI link (npm unlink -g cognal)?", false));

    const removeClaude =
      opts.all ||
      opts.removeProviders ||
      opts.removeClaudeCli ||
      (!opts.yes && hasClaude ? await promptYesNo("Remove Claude CLI (npm uninstall -g @anthropic-ai/claude-code)?", false) : false);

    const removeCodex =
      opts.all ||
      opts.removeProviders ||
      opts.removeCodexCli ||
      (!opts.yes && hasCodex ? await promptYesNo("Remove Codex CLI (npm uninstall -g @openai/codex)?", false) : false);

    const removeTelegramState =
      opts.all ||
      opts.removeTelegramState ||
      (!opts.yes && !removeWorkspace ? await promptYesNo("Remove Telegram token + access allow-lists from workspace state?", false) : false);

    if (removeService) {
      if (!opts.yes) {
        const confirm = await promptYesNo(`Remove systemd service '${cfg.runtime.serviceName}'?`, true);
        if (confirm) {
          await uninstallSystemdUnit(cfg);
        }
      } else {
        await uninstallSystemdUnit(cfg);
      }
    }

    if (removeTelegramState && !removeWorkspace) {
      const { db } = await openDb(projectRoot);
      await db.clearTelegramAccessState();
      await db.close();
      const envPath = path.join(paths.cognalDir, "cognald.env");
      await removeDaemonEnvKeys(envPath, [cfg.telegram.botTokenEnv]);
      cfg.telegram.botUsername = undefined;
      await saveConfig(paths, cfg);
      process.stdout.write("Removed Telegram token and access allow-lists from workspace state\n");
    }

    if (removeWorkspace) {
      await fs.rm(paths.cognalDir, { recursive: true, force: true });
      process.stdout.write(`Removed ${paths.cognalDir}\n`);
    }

    if (removeGlobal) {
      const code = await runInteractiveCommand("bash", ["-lc", "npm unlink -g cognal"]);
      if (code !== 0) {
        process.stdout.write("Warning: npm unlink -g cognal returned non-zero\n");
      } else {
        process.stdout.write("Removed global cognal link\n");
      }
    }

    if (removeClaude) {
      const code = await runInteractiveCommand("bash", ["-lc", "npm uninstall -g @anthropic-ai/claude-code"]);
      if (code !== 0) {
        process.stdout.write("Warning: Claude CLI uninstall may have failed\n");
      } else {
        process.stdout.write("Removed Claude CLI\n");
      }
    }

    if (removeCodex) {
      const code = await runInteractiveCommand("bash", ["-lc", "npm uninstall -g @openai/codex"]);
      if (code !== 0) {
        process.stdout.write("Warning: Codex CLI uninstall may have failed\n");
      } else {
        process.stdout.write("Removed Codex CLI\n");
      }
    }

    process.stdout.write("Uninstall complete.\n");
  });

program.parseAsync(process.argv).catch((err) => {
  logger.error("command failed", { error: String(err) });
  process.stderr.write(`Error: ${String(err)}\n`);
  process.exit(1);
});

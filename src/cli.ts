#!/usr/bin/env node
import { Command } from "commander";
import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import process from "node:process";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";
import QRCode from "qrcode";
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
import { Db } from "./core/db.js";
import { commandExists, runCommand, runInteractiveCommand, safeFileName } from "./core/utils.js";
import { Logger } from "./core/logger.js";
import type { HealthCheckResult } from "./types.js";
import type { CognalConfig, ProviderSelection } from "./config.js";
import { SignalCliAdapter } from "./adapters/signalCliAdapter.js";
import { DeliveryAdapter } from "./adapters/deliveryAdapter.js";

const logger = new Logger("cli");
const MAX_LINK_ATTEMPTS = 3;
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

  const rl = createInterface({
    input: process.stdin,
    output: process.stdout
  });

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
  const rl = createInterface({
    input: process.stdin,
    output: process.stdout
  });
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
  const rl = createInterface({
    input: process.stdin,
    output: process.stdout
  });
  try {
    const suffix = defaultValue ? ` [${defaultValue}]` : "";
    const answer = (await rl.question(`${question}${suffix}: `)).trim();
    if (!answer) {
      return defaultValue;
    }
    return answer;
  } finally {
    rl.close();
  }
}

function resolveProjectRoot(input?: string): string {
  return input ? path.resolve(input) : process.cwd();
}

function validatePhone(phone: string): void {
  if (!/^\+[1-9]\d{7,14}$/.test(phone)) {
    throw new Error(`Invalid E.164 phone number: ${phone}`);
  }
}

function makeRecordEmail(phone: string): string {
  return `no-email+${phone.replace(/\D/g, "")}@local.invalid`;
}

function signalCliInstallHint(): string {
  return [
    "signal-cli is not installed or not in PATH.",
    "Re-run the Cognal one-line installer; it now auto-installs java + signal-cli on Ubuntu/Debian.",
    "Or install signal-cli manually from https://github.com/AsamK/signal-cli/releases/latest",
    "and make sure `signal-cli` is available in PATH.",
    "Then verify with: signal-cli --version"
  ].join("\n");
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
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
  return shellQuote(value);
}

async function upsertDaemonEnv(envPath: string, updates: Record<string, string>): Promise<void> {
  let env: Record<string, string> = {};
  try {
    env = parseEnvFile(await fs.readFile(envPath, "utf8"));
  } catch {
    env = {};
  }
  for (const [key, value] of Object.entries(updates)) {
    if (!value) {
      continue;
    }
    env[key] = value;
  }
  const lines = Object.entries(env)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${key}=${envValueForFile(value)}`);
  await fs.writeFile(envPath, `${lines.join("\n")}\n`, "utf8");
  try {
    await fs.chmod(envPath, 0o600);
  } catch {
    // best-effort hardening for local secret file permissions
  }
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
  process.stdout.write(`  1) api_key (recommended for servers)\n`);
  process.stdout.write(`  2) auth_login (browser OAuth)\n`);
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

async function installSystemdUnit(
  projectRoot: string,
  cfg: CognalConfig,
  extraEnv: Record<string, string> = {}
): Promise<void> {
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

async function runSetupOnboarding(projectRoot: string): Promise<void> {
  const { cfg } = await loadProjectConfig(projectRoot);
  if (!(await commandExists(cfg.signal.command))) {
    process.stdout.write("[WARN] signal-cli not found. Skipping interactive user onboarding.\n");
    process.stdout.write(`${signalCliInstallHint()}\n`);
    return;
  }

  const addNow = await promptYesNo("Add allowed Signal users now?", false);
  if (!addNow) {
    return;
  }

  process.stdout.write("Example phone format: +4915123456789\n");
  process.stdout.write("QR delivery mode is fixed to: public_encrypted (public link + separate password)\n");

  while (true) {
    const phone = await promptText("Signal phone in E.164 (example: +4915123456789, empty to finish)");
    if (!phone.trim()) {
      break;
    }
    const normalizedPhone = phone.trim();
    try {
      validatePhone(normalizedPhone);
    } catch {
      process.stdout.write(`Invalid phone format: ${normalizedPhone}\n`);
      continue;
    }

    try {
      await userAddAction(normalizedPhone, projectRoot);
    } catch (err) {
      process.stdout.write(`Failed to add user ${normalizedPhone}: ${String(err)}\n`);
    }

    const addAnother = await promptYesNo("Add another user?", true);
    if (!addAnother) {
      break;
    }
  }
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

async function runProviderSetupWithArgs(command: string, args: string[]): Promise<void> {
  const fullCommand = [command, ...args].map(shellQuote).join(" ");
  const code = await runInteractiveCommand("bash", ["-lc", fullCommand]);
  if (code !== 0) {
    throw new Error(`${command} ${args.join(" ")} exited with code ${code}`);
  }
}

async function doctorChecks(projectRoot: string, cfg: CognalConfig): Promise<HealthCheckResult[]> {
  const checks: HealthCheckResult[] = [];
  const binaries = ["node", "npm", "java", "systemctl", "signal-cli"];
  if (cfg.agents.enabled.claude) {
    binaries.push("claude");
  }
  if (cfg.agents.enabled.codex) {
    binaries.push("codex");
  }
  for (const bin of binaries) {
    const ok = await commandExists(bin);
    checks.push({
      name: `binary:${bin}`,
      ok,
      details: ok ? "ok" : "missing"
    });
  }

  const distro = await runCommand("bash", ["-lc", "source /etc/os-release && echo ${ID:-unknown}"], { timeoutMs: 2_000 });
  const distroId = distro.stdout.trim();
  checks.push({
    name: "os:distro",
    ok: distroId === "ubuntu" || distroId === "debian",
    details: distroId || "unknown"
  });

  const cfgPath = getRuntimePaths(projectRoot).configPath;
  try {
    await fs.access(cfgPath);
    checks.push({ name: "config", ok: true, details: cfgPath });
  } catch {
    checks.push({ name: "config", ok: false, details: "missing config.toml" });
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

function createDeliveryAdapterFromEnv(cfg: Awaited<ReturnType<typeof loadOrCreateConfig>>): DeliveryAdapter {
  const resendApiKey = process.env[cfg.delivery.resend.apiKeyEnv];
  const storage = cfg.delivery.storage;
  const publicDump = cfg.delivery.publicDump;
  return new DeliveryAdapter({
    resendApiKey,
    resendFrom: cfg.delivery.resend.from,
    storage: {
      endpoint: storage.endpoint,
      region: storage.region,
      bucket: storage.bucket,
      accessKey: storage.accessKeyEnv ? process.env[storage.accessKeyEnv] : undefined,
      secretKey: storage.secretKeyEnv ? process.env[storage.secretKeyEnv] : undefined,
      ttlSec: storage.presignedTtlSec
    },
    publicDump: {
      endpoint: process.env.COGNAL_PUBLIC_DUMP_ENDPOINT || publicDump.endpoint,
      fileField: publicDump.fileField,
      timeoutSec: publicDump.timeoutSec,
      extraFields: publicDump.extraFields
    }
  });
}

async function deliverQr(pngPath: string, deliveryAdapter: DeliveryAdapter) {
  return await deliveryAdapter.deliverQrByPublicEncrypted(pngPath, { allowLocalFallback: false });
}

async function createQrPng(uri: string, linksDir: string, baseName: string): Promise<string> {
  const filePath = path.join(linksDir, `${safeFileName(baseName)}.png`);
  await QRCode.toFile(filePath, uri, {
    type: "png",
    errorCorrectionLevel: "H",
    margin: 1,
    width: 512
  });
  return filePath;
}

function isRetriableLinkError(err: unknown): boolean {
  const message = String(err);
  return /Connection closed!/i.test(message) || /exit 3/i.test(message) || /Timed out/i.test(message);
}

async function runLinkDeliveryFlow(
  params: {
    db: Db;
    userId: string;
    phone: string;
    paths: ReturnType<typeof getRuntimePaths>;
    signal: SignalCliAdapter;
    delivery: DeliveryAdapter;
  }
): Promise<void> {
  for (let attempt = 1; attempt <= MAX_LINK_ATTEMPTS; attempt += 1) {
    const linkSession = await params.signal.createDeviceLinkSession(`cognal-${params.phone}`);
    const pngPath = await createQrPng(linkSession.uri, params.paths.linksDir, `${params.phone}-${Date.now()}-a${attempt}`);
    const result = await deliverQr(pngPath, params.delivery);

    await params.db.recordDelivery(params.userId, result.mode, result.target, null, result.expiresAt ?? null);

    process.stdout.write(`QR delivery mode: ${result.mode}\n`);
    process.stdout.write(`Target: ${result.target}\n`);
    if (result.expiresAt) {
      process.stdout.write(`Expires at: ${result.expiresAt}\n`);
    }
    if (result.secret) {
      process.stdout.write(`Password: ${result.secret}\n`);
      process.stdout.write("Share link and password separately.\n");
    }
    process.stdout.write(`Link attempt ${attempt}/${MAX_LINK_ATTEMPTS}. QR is valid only briefly (~60s).\n`);
    process.stdout.write("Waiting for Signal device-link confirmation. Keep this command running until completion.\n");

    try {
      await linkSession.completion;
      process.stdout.write("Signal device-link completed.\n");
      return;
    } catch (err) {
      if (attempt < MAX_LINK_ATTEMPTS && isRetriableLinkError(err)) {
        process.stdout.write("Signal link window closed before completion. Generating a fresh QR...\n");
        continue;
      }
      throw err;
    }
  }

  throw new Error("Signal device-link failed after maximum retry attempts.");
}

const program = new Command();

program
  .name("cognal")
  .description("Signal bridge for Claude Code and Codex")
  .option("-p, --project-root <path>", "Project root path")
  .showHelpAfterError();

program
  .command("setup")
  .option("--run-provider-setup", "Force native Claude/Codex setup flows (also without TTY)", false)
  .option("--skip-provider-install", "Skip automatic install for missing provider CLIs", false)
  .option("--skip-provider-setup", "Skip native provider login/setup flows", false)
  .option("--distro <ubuntu|debian>", "Set distro in config")
  .option("--providers <claude|codex|both>", "Enabled providers")
  .option("--skip-onboarding", "Skip interactive user onboarding", false)
  .action(async (opts, cmd) => {
    const projectRoot = resolveProjectRoot(cmd.parent?.opts().projectRoot);
    const { db, paths, cfg } = await getConfigAndDb(projectRoot);

    const defaultProviders = providerSelectionFromEnabled(cfg.agents.enabled);
    const selectedProviders = opts.providers
      ? parseProviderSelection(opts.providers)
      : await promptProviderSelection(defaultProviders);
    cfg.agents.enabled = enabledFromProviderSelection(selectedProviders);

    if (opts.distro) {
      cfg.runtime.distro = opts.distro;
    }
    await saveConfig(paths, cfg);
    process.stdout.write(`Provider mode: ${selectedProviders}\n`);

    const checks = await doctorChecks(projectRoot, cfg);
    for (const check of checks) {
      process.stdout.write(`${check.ok ? "[OK]" : "[WARN]"} ${check.name} -> ${check.details}\n`);
    }

    const providerSpecs = enabledProviderSpecs(cfg);
    const providerAuthModes = new Map<string, ProviderAuthMode>();
    const daemonEnvUpdates: Record<string, string> = {};

    if (!opts.skipProviderInstall) {
      for (const spec of providerSpecs) {
        const exists = await commandExists(spec.command);
        if (exists) {
          continue;
        }
        process.stdout.write(`${spec.label} CLI is missing. Installing automatically...\n`);
        await installProviderCli(spec);
        process.stdout.write(`[OK] ${spec.label} CLI installed.\n`);
      }
    }

    let shouldRunProviderSetup = false;
    if (!opts.skipProviderSetup) {
      if (opts.runProviderSetup) {
        shouldRunProviderSetup = true;
      } else {
        shouldRunProviderSetup = process.stdin.isTTY && process.stdout.isTTY;
        if (!shouldRunProviderSetup) {
          process.stdout.write(
            "[WARN] Non-interactive shell detected. Skipping native provider setup/login. Use --run-provider-setup to force.\n"
          );
        }
      }
    }

    await db.close();
    if (!opts.skipOnboarding) {
      await runSetupOnboarding(projectRoot);
    }

    if (shouldRunProviderSetup) {
      for (const spec of providerSpecs) {
        const authMode = await promptProviderAuthMode(spec);
        providerAuthModes.set(spec.command, authMode);

        if (authMode !== "api_key") {
          if (spec.label === "Claude" && (process.env.SSH_CONNECTION || process.env.SSH_CLIENT || process.env.SSH_TTY)) {
            process.stdout.write(
              "[WARN] Claude auth_login on SSH/headless hosts may hang after browser auth because the localhost callback cannot complete reliably.\n"
            );
            process.stdout.write(
              "[WARN] If login does not complete, re-run setup and choose api_key instead.\n"
            );
          }
          continue;
        }

        process.stdout.write(`${spec.label} API key URL: ${spec.apiKeyUrl}\n`);
        const existing = process.env[spec.apiKeyEnv]?.trim() ?? "";
        const keyPrompt = existing
          ? `Paste ${spec.apiKeyEnv} (leave empty to keep current value)`
          : `Paste ${spec.apiKeyEnv}`;
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
        if (authMode === "api_key") {
          if (process.env[spec.apiKeyEnv]?.trim()) {
            process.stdout.write(`[OK] Using ${spec.apiKeyEnv} for ${spec.label}. Skipping auth login.\n`);
            continue;
          }
          process.stdout.write(`[WARN] ${spec.apiKeyEnv} missing. Falling back to native ${spec.label} auth login.\n`);
        }

        if (process.env[spec.apiKeyEnv]?.trim() && !providerAuthModes.has(spec.command)) {
          process.stdout.write(`[OK] ${spec.apiKeyEnv} detected. Skipping native ${spec.label} login.\n`);
          continue;
        }
        process.stdout.write(`Running native ${spec.label} setup...\n`);
        await runProviderSetupWithArgs(spec.command, spec.setupArgs);
      }
    }

    await installSystemdUnit(projectRoot, cfg, daemonEnvUpdates);
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
    const args = opts.follow
      ? ["-u", cfg.runtime.serviceName, "-f"]
      : ["-u", cfg.runtime.serviceName, "-n", "200"];
    const proc = spawn("journalctl", args, { stdio: "inherit" });
    await new Promise<void>((resolve) => {
      proc.on("exit", () => resolve());
    });
  });

async function userAddAction(phone: string, projectRoot: string): Promise<void> {
  validatePhone(phone);
  const { db, paths, cfg } = await getConfigAndDb(projectRoot);
  try {
    if (!(await commandExists(cfg.signal.command))) {
      throw new Error(signalCliInstallHint());
    }
    const recordEmail = makeRecordEmail(phone);

    let user = await db.getUserByPhone(phone);
    if (!user) {
      user = await db.addUser(phone, recordEmail, getDefaultAgent(cfg));
    } else {
      const binding = await db.getBinding(user.id, getDefaultAgent(cfg));
      if (!isAgentEnabled(cfg, binding.activeAgent)) {
        await db.setActiveAgent(user.id, getDefaultAgent(cfg));
      }
    }

    process.stdout.write(`User registered in pending state: ${phone}\n`);
    const signal = new SignalCliAdapter(cfg.signal.command, cfg.signal.dataDir, cfg.signal.account);
    const deliveryAdapter = createDeliveryAdapterFromEnv(cfg);
    await runLinkDeliveryFlow({
      db,
      userId: user.id,
      phone,
      paths,
      signal,
      delivery: deliveryAdapter
    });
  } finally {
    await db.close();
  }
}

async function userListAction(projectRoot: string): Promise<void> {
  const { db } = await getConfigAndDb(projectRoot);
  const users = await db.listUsers();
  await db.close();
  const rows = users.map((u) => ({
    id: u.id,
    phone: u.phoneE164,
    status: u.status,
    signalAccountId: u.signalAccountId ?? "-",
    createdAt: u.createdAt
  }));
  console.table(rows);
}

async function userRevokeAction(phone: string, projectRoot: string): Promise<void> {
  validatePhone(phone);
  const { db } = await getConfigAndDb(projectRoot);
  const user = await db.getUserByPhone(phone);
  if (!user) {
    throw new Error(`Unknown user: ${phone}`);
  }
  await db.setUserStatus(user.id, "revoked");
  await db.close();
  process.stdout.write(`Revoked user ${phone}\n`);
}

async function userRelinkAction(phone: string, projectRoot: string): Promise<void> {
  validatePhone(phone);
  const { db, paths, cfg } = await getConfigAndDb(projectRoot);
  try {
    if (!(await commandExists(cfg.signal.command))) {
      throw new Error(signalCliInstallHint());
    }
    const user = await db.getUserByPhone(phone);
    if (!user) {
      throw new Error(`Unknown user: ${phone}`);
    }
    const binding = await db.getBinding(user.id, getDefaultAgent(cfg));
    if (!isAgentEnabled(cfg, binding.activeAgent)) {
      await db.setActiveAgent(user.id, getDefaultAgent(cfg));
    }

    await db.setUserStatus(user.id, "pending");
    process.stdout.write(`Relink generated for ${phone}\n`);

    const signal = new SignalCliAdapter(cfg.signal.command, cfg.signal.dataDir, cfg.signal.account);
    const delivery = createDeliveryAdapterFromEnv(cfg);
    await runLinkDeliveryFlow({
      db,
      userId: user.id,
      phone,
      paths,
      signal,
      delivery
    });
  } finally {
    await db.close();
  }
}

const userCommand = program.command("user").description("User management");
userCommand
  .command("add")
  .requiredOption("--phone <phone>", "Phone in E.164 format")
  .action(async (opts, cmd) => {
    const projectRoot = resolveProjectRoot(cmd.parent?.parent?.opts().projectRoot);
    await userAddAction(opts.phone, projectRoot);
  });

userCommand
  .command("list")
  .action(async (_, cmd) => {
    const projectRoot = resolveProjectRoot(cmd.parent?.parent?.opts().projectRoot);
    await userListAction(projectRoot);
  });

userCommand
  .command("revoke")
  .requiredOption("--phone <phone>", "Phone in E.164 format")
  .action(async (opts, cmd) => {
    const projectRoot = resolveProjectRoot(cmd.parent?.parent?.opts().projectRoot);
    await userRevokeAction(opts.phone, projectRoot);
  });

userCommand
  .command("relink")
  .requiredOption("--phone <phone>", "Phone in E.164 format")
  .action(async (opts, cmd) => {
    const projectRoot = resolveProjectRoot(cmd.parent?.parent?.opts().projectRoot);
    await userRelinkAction(opts.phone, projectRoot);
  });

program
  .command("user:add")
  .requiredOption("--phone <phone>", "Phone in E.164 format")
  .action(async (opts, cmd) => {
    const projectRoot = resolveProjectRoot(cmd.parent?.opts().projectRoot);
    await userAddAction(opts.phone, projectRoot);
  });

program
  .command("user:list")
  .action(async (_, cmd) => {
    const projectRoot = resolveProjectRoot(cmd.parent?.opts().projectRoot);
    await userListAction(projectRoot);
  });

program
  .command("user:revoke")
  .requiredOption("--phone <phone>", "Phone in E.164 format")
  .action(async (opts, cmd) => {
    const projectRoot = resolveProjectRoot(cmd.parent?.opts().projectRoot);
    await userRevokeAction(opts.phone, projectRoot);
  });

program
  .command("user:relink")
  .requiredOption("--phone <phone>", "Phone in E.164 format")
  .action(async (opts, cmd) => {
    const projectRoot = resolveProjectRoot(cmd.parent?.opts().projectRoot);
    await userRelinkAction(opts.phone, projectRoot);
  });

program
  .command("doctor")
  .action(async (_, cmd) => {
    const projectRoot = resolveProjectRoot(cmd.parent?.opts().projectRoot);
    const paths = getRuntimePaths(projectRoot);
    await ensureRuntimeDirs(paths);
    const cfg = await loadOrCreateConfig(paths);
    const checks = await doctorChecks(projectRoot, cfg);
    let hasFail = false;
    for (const check of checks) {
      process.stdout.write(`${check.ok ? "[OK]" : "[WARN]"} ${check.name}: ${check.details}\n`);
      if (!check.ok) {
        hasFail = true;
      }
    }
    if (hasFail) {
      process.exitCode = 1;
    }
  });

program
  .command("update")
  .action(async (_, cmd) => {
    const projectRoot = resolveProjectRoot(cmd.parent?.opts().projectRoot);
    const paths = getRuntimePaths(projectRoot);
    await ensureRuntimeDirs(paths);
    const cfg = await loadOrCreateConfig(paths);
    const steps: Array<{ title: string; command: string }> = [
      { title: "Update Cognal repository", command: `cd '${INSTALL_ROOT}' && git fetch --all && git pull --ff-only` }
    ];
    if (cfg.agents.enabled.claude) {
      steps.push({ title: "Update Claude", command: "claude update" });
    }
    if (cfg.agents.enabled.codex) {
      steps.push({ title: "Update Codex", command: "npm i -g @openai/codex@latest" });
    }
    steps.push(
      { title: "Update signal-cli", command: "sudo apt-get update && sudo apt-get install -y --only-upgrade signal-cli" },
      { title: `Restart ${cfg.runtime.serviceName}`, command: `sudo systemctl restart ${cfg.runtime.serviceName}` },
      { title: "Run doctor", command: `${process.execPath} '${CLI_ENTRYPOINT_PATH}' -p '${projectRoot}' doctor` }
    );

    for (const step of steps) {
      process.stdout.write(`==> ${step.title}\n`);
      const needsInteractive = /\bsudo\b/.test(step.command);
      if (needsInteractive) {
        const exitCode = await runInteractiveCommand("bash", ["-lc", step.command]);
        if (exitCode !== 0) {
          process.stdout.write(`[WARN] ${step.title} failed\n`);
        } else {
          process.stdout.write("[OK]\n");
        }
        continue;
      }
      const result = await runCommand("bash", ["-lc", step.command], { timeoutMs: 120_000 });
      if (result.code !== 0) {
        process.stdout.write(`[WARN] ${step.title} failed\n${result.stderr || result.stdout}\n`);
      } else {
        process.stdout.write("[OK]\n");
      }
    }
  });

program
  .command("uninstall")
  .description("Remove Cognal service and optionally workspace/global/provider installations")
  .option("--yes", "Skip interactive prompts and use defaults", false)
  .option("--remove-workspace", "Remove .cognal directory in project root", false)
  .option("--remove-global", "Run npm unlink -g cognal", false)
  .option("--remove-claude-cli", "Run npm uninstall -g @anthropic-ai/claude-code", false)
  .option("--remove-codex-cli", "Run npm uninstall -g @openai/codex", false)
  .option("--remove-providers", "Remove both provider CLIs (Claude + Codex)", false)
  .option("--all", "Remove service, workspace, global Cognal link, and provider CLIs", false)
  .action(async (opts, cmd) => {
    const projectRoot = resolveProjectRoot(cmd.parent?.opts().projectRoot);
    const { paths, cfg } = await loadProjectConfig(projectRoot);
    const hasClaudeCli = await commandExists("claude");
    const hasCodexCli = await commandExists("codex");

    const removeService = opts.all
      ? true
      : opts.yes
      ? true
      : await promptYesNo(`Remove systemd service '${cfg.runtime.serviceName}'?`, true);
    const removeWorkspace = opts.all || opts.removeWorkspace
      ? true
      : opts.yes
        ? false
        : await promptYesNo(`Remove workspace state '${paths.cognalDir}'?`, false);
    const removeGlobal = opts.all || opts.removeGlobal
      ? true
      : opts.yes
        ? false
        : await promptYesNo("Remove global CLI link (npm unlink -g cognal)?", false);
    const removeClaudeCli = opts.all || opts.removeProviders || opts.removeClaudeCli
      ? true
      : opts.yes
        ? false
        : hasClaudeCli
          ? await promptYesNo("Remove Claude CLI (npm uninstall -g @anthropic-ai/claude-code)?", false)
          : false;
    const removeCodexCli = opts.all || opts.removeProviders || opts.removeCodexCli
      ? true
      : opts.yes
        ? false
        : hasCodexCli
          ? await promptYesNo("Remove Codex CLI (npm uninstall -g @openai/codex)?", false)
          : false;

    if (removeService) {
      await uninstallSystemdUnit(cfg);
    }
    if (removeWorkspace) {
      await fs.rm(paths.cognalDir, { recursive: true, force: true });
      process.stdout.write(`Removed ${paths.cognalDir}\n`);
    }
    if (removeGlobal) {
      const code = await runInteractiveCommand("bash", ["-lc", "npm unlink -g cognal || true"]);
      if (code !== 0) {
        process.stdout.write("Warning: global unlink may have failed\n");
      } else {
        process.stdout.write("Removed global cognal link\n");
      }
    }
    if (removeClaudeCli) {
      const code = await runInteractiveCommand("bash", ["-lc", "npm uninstall -g @anthropic-ai/claude-code"]);
      if (code !== 0) {
        process.stdout.write("Warning: Claude CLI uninstall may have failed\n");
      } else {
        process.stdout.write("Removed Claude CLI\n");
      }
    }
    if (removeCodexCli) {
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
  process.stderr.write(`Error: ${String(err)}\n`);
  process.exit(1);
});

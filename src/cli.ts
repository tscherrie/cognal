#!/usr/bin/env node
import { Command } from "commander";
import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import process from "node:process";
import { createInterface } from "node:readline/promises";
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
type DeliveryMode = "email" | "link" | "public_encrypted";

function parseDeliveryModeInput(value: string): DeliveryMode | null {
  const normalized = value.trim().toLowerCase();
  if (normalized === "email") {
    return "email";
  }
  if (normalized === "link") {
    return "link";
  }
  if (normalized === "public_encrypted" || normalized === "public-encrypted" || normalized === "public") {
    return "public_encrypted";
  }
  return null;
}

function isLikelyEmail(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

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

async function installSystemdUnit(projectRoot: string, cfg: CognalConfig): Promise<void> {
  const serviceName = cfg.runtime.serviceName;
  const runUser = process.env.SUDO_USER || process.env.USER || "root";
  const unit = `[Unit]
Description=Cognal Daemon
After=network.target

[Service]
Type=simple
WorkingDirectory=${projectRoot}
EnvironmentFile=${projectRoot}/.cognal/cognald.env
ExecStart=${process.execPath} ${projectRoot}/dist/daemon.js
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
  await fs.writeFile(envPath, `COGNAL_PROJECT_ROOT=${projectRoot}\n`, "utf8");

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
  const addNow = await promptYesNo("Add allowed Signal users now?", false);
  if (!addNow) {
    return;
  }

  process.stdout.write("Example phone format: +4915123456789\n");
  process.stdout.write("Delivery modes: public_encrypted (recommended), email, link\n");

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

    const deliveryRaw = await promptText(
      "Delivery mode [public_encrypted|email|link] (public_encrypted = public link + separate password)",
      "public_encrypted"
    );
    const deliveryMode = parseDeliveryModeInput(deliveryRaw);
    if (!deliveryMode) {
      process.stdout.write(`Invalid delivery mode: ${deliveryRaw}\n`);
      continue;
    }

    let email = "";
    if (deliveryMode === "email") {
      while (true) {
        const candidate = await promptText("Email for QR delivery (example: user@example.com)");
        if (!candidate.trim()) {
          process.stdout.write("Email is required for delivery mode 'email'.\n");
          continue;
        }
        if (!isLikelyEmail(candidate.trim())) {
          process.stdout.write("Please enter a valid email format (example: user@example.com).\n");
          continue;
        }
        email = candidate.trim();
        break;
      }
    } else {
      const candidate = (await promptText(
        "Email for record (optional, example: user@example.com). Leave empty to skip",
        ""
      )).trim();
      if (candidate && !isLikelyEmail(candidate)) {
        process.stdout.write("Invalid email format, using internal placeholder.\n");
      }
      email = candidate && isLikelyEmail(candidate)
        ? candidate
        : `no-email+${normalizedPhone.replace(/\D/g, "")}@local.invalid`;
    }

    try {
      await userAddAction(normalizedPhone, email, deliveryMode, projectRoot);
    } catch (err) {
      process.stdout.write(`Failed to add user ${normalizedPhone}: ${String(err)}\n`);
    }

    const addAnother = await promptYesNo("Add another user?", true);
    if (!addAnother) {
      break;
    }
  }
}

async function runProviderSetup(command: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const proc = spawn(command, [], { stdio: "inherit" });
    proc.on("exit", (code) => {
      if ((code ?? 0) !== 0) {
        reject(new Error(`${command} setup exited with code ${code}`));
        return;
      }
      resolve();
    });
    proc.on("error", reject);
  });
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
      timeoutSec: publicDump.timeoutSec
    }
  });
}

function resolveDeliveryMode(
  requested: string | undefined,
  cfg: Awaited<ReturnType<typeof loadOrCreateConfig>>
): DeliveryMode {
  const selected = String(requested ?? cfg.delivery.modeDefault).trim().toLowerCase();
  if (selected === "email") {
    return "email";
  }
  if (selected === "link") {
    return "link";
  }
  if (selected === "public_encrypted" || selected === "public-encrypted" || selected === "public") {
    return "public_encrypted";
  }
  throw new Error(`Unknown delivery mode '${selected}'. Use: email, link, public_encrypted`);
}

async function deliverQr(
  mode: DeliveryMode,
  email: string,
  pngPath: string,
  deliveryAdapter: DeliveryAdapter
) {
  if (mode === "email") {
    return await deliveryAdapter.deliverQrByEmail(email, pngPath).catch(async (err) => {
      logger.warn("email delivery failed; fallback to public_encrypted", { error: String(err) });
      return await deliveryAdapter.deliverQrByPublicEncrypted(pngPath);
    });
  }
  if (mode === "link") {
    return await deliveryAdapter.deliverQrByLink(pngPath);
  }
  return await deliveryAdapter.deliverQrByPublicEncrypted(pngPath);
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

const program = new Command();

program
  .name("cognal")
  .description("Signal bridge for Claude Code and Codex")
  .option("-p, --project-root <path>", "Project root path")
  .showHelpAfterError();

program
  .command("setup")
  .option("--run-provider-setup", "Run native Claude/Codex setup flows", false)
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

    if (opts.runProviderSetup) {
      if (cfg.agents.enabled.claude) {
        process.stdout.write("Running native Claude setup...\n");
        await runProviderSetup(cfg.agents.claude.command);
      }
      if (cfg.agents.enabled.codex) {
        process.stdout.write("Running native Codex setup...\n");
        await runProviderSetup(cfg.agents.codex.command);
      }
    }

    await installSystemdUnit(projectRoot, cfg);
    await db.close();
    if (!opts.skipOnboarding) {
      await runSetupOnboarding(projectRoot);
    }
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

async function userAddAction(phone: string, email: string, deliver: string | undefined, projectRoot: string): Promise<void> {
  validatePhone(phone);
  const { db, paths, cfg } = await getConfigAndDb(projectRoot);

  let user = await db.getUserByPhone(phone);
  if (!user) {
    user = await db.addUser(phone, email, getDefaultAgent(cfg));
  } else {
    const binding = await db.getBinding(user.id, getDefaultAgent(cfg));
    if (!isAgentEnabled(cfg, binding.activeAgent)) {
      await db.setActiveAgent(user.id, getDefaultAgent(cfg));
    }
  }

  const signal = new SignalCliAdapter(cfg.signal.command, cfg.signal.dataDir, cfg.signal.account);
  const uri = await signal.createDeviceLinkUri(`cognal-${phone}`);
  const pngPath = await createQrPng(uri, paths.linksDir, `${phone}-${Date.now()}`);

  const mode = resolveDeliveryMode(deliver, cfg);
  const deliveryAdapter = createDeliveryAdapterFromEnv(cfg);
  const result = await deliverQr(mode, email, pngPath, deliveryAdapter);

  await db.recordDelivery(user.id, result.mode, result.target, null, result.expiresAt ?? null);
  await db.close();

  process.stdout.write(`User registered in pending state: ${phone}\n`);
  process.stdout.write(`QR delivery mode: ${result.mode}\n`);
  process.stdout.write(`Target: ${result.target}\n`);
  if (result.expiresAt) {
    process.stdout.write(`Expires at: ${result.expiresAt}\n`);
  }
  if (result.secret) {
    process.stdout.write(`Password: ${result.secret}\n`);
    process.stdout.write("Share link and password separately.\n");
  }
}

async function userListAction(projectRoot: string): Promise<void> {
  const { db } = await getConfigAndDb(projectRoot);
  const users = await db.listUsers();
  await db.close();
  const rows = users.map((u) => ({
    id: u.id,
    phone: u.phoneE164,
    email: u.email,
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

async function userRelinkAction(phone: string, deliver: string | undefined, projectRoot: string): Promise<void> {
  validatePhone(phone);
  const { db, paths, cfg } = await getConfigAndDb(projectRoot);
  const user = await db.getUserByPhone(phone);
  if (!user) {
    throw new Error(`Unknown user: ${phone}`);
  }
  const binding = await db.getBinding(user.id, getDefaultAgent(cfg));
  if (!isAgentEnabled(cfg, binding.activeAgent)) {
    await db.setActiveAgent(user.id, getDefaultAgent(cfg));
  }

  await db.setUserStatus(user.id, "pending");
  const signal = new SignalCliAdapter(cfg.signal.command, cfg.signal.dataDir, cfg.signal.account);
  const uri = await signal.createDeviceLinkUri(`cognal-${phone}`);
  const pngPath = await createQrPng(uri, paths.linksDir, `${phone}-${Date.now()}`);
  const delivery = createDeliveryAdapterFromEnv(cfg);
  const mode = resolveDeliveryMode(deliver, cfg);
  const result = await deliverQr(mode, user.email, pngPath, delivery);

  await db.recordDelivery(user.id, result.mode, result.target, null, result.expiresAt ?? null);
  await db.close();
  process.stdout.write(`Relink generated for ${phone}\n`);
  process.stdout.write(`Delivery: ${result.mode} -> ${result.target}\n`);
  if (result.secret) {
    process.stdout.write(`Password: ${result.secret}\n`);
    process.stdout.write("Share link and password separately.\n");
  }
}

const userCommand = program.command("user").description("User management");
userCommand
  .command("add")
  .requiredOption("--phone <phone>", "Phone in E.164 format")
  .requiredOption("--email <email>", "User email")
  .option("--deliver <email|link|public_encrypted>", "Delivery mode")
  .action(async (opts, cmd) => {
    const projectRoot = resolveProjectRoot(cmd.parent?.parent?.opts().projectRoot);
    await userAddAction(opts.phone, opts.email, opts.deliver, projectRoot);
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
  .option("--deliver <email|link|public_encrypted>", "Delivery mode")
  .action(async (opts, cmd) => {
    const projectRoot = resolveProjectRoot(cmd.parent?.parent?.opts().projectRoot);
    await userRelinkAction(opts.phone, opts.deliver, projectRoot);
  });

program
  .command("user:add")
  .requiredOption("--phone <phone>", "Phone in E.164 format")
  .requiredOption("--email <email>", "User email")
  .option("--deliver <email|link|public_encrypted>", "Delivery mode")
  .action(async (opts, cmd) => {
    const projectRoot = resolveProjectRoot(cmd.parent?.opts().projectRoot);
    await userAddAction(opts.phone, opts.email, opts.deliver, projectRoot);
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
  .option("--deliver <email|link|public_encrypted>", "Delivery mode")
  .action(async (opts, cmd) => {
    const projectRoot = resolveProjectRoot(cmd.parent?.opts().projectRoot);
    await userRelinkAction(opts.phone, opts.deliver, projectRoot);
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
      { title: "Update Cognal repository", command: `cd '${projectRoot}' && git fetch --all && git pull --ff-only` }
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
      { title: "Run doctor", command: `cd '${projectRoot}' && ${process.execPath} dist/cli.js -p '${projectRoot}' doctor` }
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
  .description("Remove Cognal service and optionally workspace/global installation")
  .option("--yes", "Skip interactive prompts and use defaults", false)
  .option("--remove-workspace", "Remove .cognal directory in project root", false)
  .option("--remove-global", "Run npm unlink -g cognal", false)
  .action(async (opts, cmd) => {
    const projectRoot = resolveProjectRoot(cmd.parent?.opts().projectRoot);
    const { paths, cfg } = await loadProjectConfig(projectRoot);

    const removeService = opts.yes
      ? true
      : await promptYesNo(`Remove systemd service '${cfg.runtime.serviceName}'?`, true);
    const removeWorkspace = opts.removeWorkspace
      ? true
      : opts.yes
        ? false
        : await promptYesNo(`Remove workspace state '${paths.cognalDir}'?`, false);
    const removeGlobal = opts.removeGlobal
      ? true
      : opts.yes
        ? false
        : await promptYesNo("Remove global CLI link (npm unlink -g cognal)?", false);

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
    process.stdout.write("Uninstall complete.\n");
  });

program.parseAsync(process.argv).catch((err) => {
  process.stderr.write(`Error: ${String(err)}\n`);
  process.exit(1);
});

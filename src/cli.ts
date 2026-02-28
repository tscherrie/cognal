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

async function getConfigAndDb(projectRoot: string): Promise<{
  db: Db;
  paths: ReturnType<typeof getRuntimePaths>;
  cfg: Awaited<ReturnType<typeof loadOrCreateConfig>>;
}> {
  const { db, paths } = await openDb(projectRoot);
  const cfg = await loadOrCreateConfig(paths);
  return { db, paths, cfg };
}

async function installSystemdUnit(projectRoot: string): Promise<void> {
  const unit = `[Unit]
Description=Cognal Daemon
After=network.target

[Service]
Type=simple
WorkingDirectory=${projectRoot}
EnvironmentFile=${projectRoot}/.cognal/cognald.env
ExecStart=${process.execPath} ${projectRoot}/dist/daemon.js
Restart=always
RestartSec=2

[Install]
WantedBy=multi-user.target
`;

  const paths = getRuntimePaths(projectRoot);
  const localUnitPath = path.join(paths.cognalDir, "cognald.service");
  const envPath = path.join(paths.cognalDir, "cognald.env");
  await fs.writeFile(localUnitPath, unit, "utf8");
  await fs.writeFile(envPath, `COGNAL_PROJECT_ROOT=${projectRoot}\n`, "utf8");

  const hasSystemctl = await commandExists("systemctl");
  if (!hasSystemctl) {
    logger.warn("systemctl not found. Skipping systemd install.");
    return;
  }

  const copyCode = await runInteractiveCommand("bash", ["-lc", `sudo cp '${localUnitPath}' /etc/systemd/system/cognald.service`]);
  if (copyCode !== 0) {
    logger.warn("could not install systemd unit automatically", {
      stderr: "sudo cp failed",
      hint: `Manual install: sudo cp '${localUnitPath}' /etc/systemd/system/cognald.service`
    });
    return;
  }

  const enableCode = await runInteractiveCommand("bash", ["-lc", "sudo systemctl daemon-reload && sudo systemctl enable --now cognald"]);
  if (enableCode !== 0) {
    logger.warn("could not enable cognald automatically", {
      stderr: "sudo systemctl enable/start failed",
      hint: "Run: sudo systemctl daemon-reload && sudo systemctl enable --now cognald"
    });
    return;
  }
  logger.info("systemd unit installed", { service: "cognald" });
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

    await installSystemdUnit(projectRoot);
    await db.close();
    process.stdout.write("Setup complete. Run 'cognal doctor' for final verification.\n");
  });

program
  .command("start")
  .action(async () => {
    const result = await runInteractiveCommand("bash", ["-lc", "sudo systemctl start cognald"]);
    if (result !== 0) {
      throw new Error("Failed to start cognald");
    }
    process.stdout.write("cognald started\n");
  });

program
  .command("stop")
  .action(async () => {
    const result = await runInteractiveCommand("bash", ["-lc", "sudo systemctl stop cognald"]);
    if (result !== 0) {
      throw new Error("Failed to stop cognald");
    }
    process.stdout.write("cognald stopped\n");
  });

program
  .command("restart")
  .action(async () => {
    const result = await runInteractiveCommand("bash", ["-lc", "sudo systemctl restart cognald"]);
    if (result !== 0) {
      throw new Error("Failed to restart cognald");
    }
    process.stdout.write("cognald restarted\n");
  });

program
  .command("status")
  .action(async () => {
    const result = await runCommand("bash", ["-lc", "systemctl is-active cognald"], { timeoutMs: 3_000 });
    process.stdout.write((result.stdout.trim() || "unknown") + "\n");
  });

program
  .command("logs")
  .option("--follow", "Follow logs", false)
  .action(async (opts) => {
    const args = opts.follow ? ["-u", "cognald", "-f"] : ["-u", "cognald", "-n", "200"];
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
      { title: "Restart cognald", command: "sudo systemctl restart cognald" },
      { title: "Run doctor", command: `cd '${projectRoot}' && ${process.execPath} dist/cli.js doctor` }
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

program.parseAsync(process.argv).catch((err) => {
  process.stderr.write(`Error: ${String(err)}\n`);
  process.exit(1);
});

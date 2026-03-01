import { describe, expect, it } from "vitest";
import { computeServiceName, defaultConfig, normalizeConfig } from "../src/config.js";

describe("config multi-project defaults", () => {
  it("creates stable service name per project root", () => {
    const a = computeServiceName("/srv/project-a", "project-a");
    const b = computeServiceName("/srv/project-a", "project-a");
    expect(a).toBe(b);
    expect(a.startsWith("cognald-project-a-")).toBe(true);
  });

  it("uses different service names for different roots", () => {
    const a = computeServiceName("/srv/project-a", "project");
    const b = computeServiceName("/srv/project-b", "project");
    expect(a).not.toBe(b);
  });

  it("defaults telegram config", () => {
    const cfg = defaultConfig("/srv/project-a");
    expect(cfg.telegram.botTokenEnv).toBe("TELEGRAM_BOT_TOKEN");
    expect(cfg.telegram.receiveTimeoutSec).toBe(30);
    expect(cfg.telegram.allowGroups).toBe(true);
    expect(cfg.routing.responseChunkSize).toBe(3500);
  });

  it("migrates legacy signal receive timeout into telegram timeout", () => {
    const cfg = defaultConfig("/srv/project-a") as any;
    delete cfg.telegram;
    cfg.signal = { receiveTimeoutSec: 9 };
    const normalized = normalizeConfig(cfg, "/srv/project-a");
    expect(normalized.telegram.receiveTimeoutSec).toBe(9);
    expect(normalized.telegram.botTokenEnv).toBe("TELEGRAM_BOT_TOKEN");
  });

  it("ensures at least one agent is enabled", () => {
    const cfg = defaultConfig("/srv/project-a");
    cfg.agents.enabled.claude = false;
    cfg.agents.enabled.codex = false;
    const normalized = normalizeConfig(cfg, "/srv/project-a");
    expect(normalized.agents.enabled.codex).toBe(true);
  });
});

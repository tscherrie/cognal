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

  it("defaults signal data dir to project-local path", () => {
    const cfg = defaultConfig("/srv/project-a");
    expect(cfg.signal.dataDir).toBe("/srv/project-a/.cognal/signal-cli");
  });

  it("defaults public dump config to litterbox", () => {
    const cfg = defaultConfig("/srv/project-a");
    expect(cfg.delivery.modeDefault).toBe("public_encrypted");
    expect(cfg.delivery.publicDump.endpoint).toBe("https://litterbox.catbox.moe/resources/internals/api.php");
    expect(cfg.delivery.publicDump.fileField).toBe("fileToUpload");
    expect(cfg.delivery.publicDump.extraFields).toEqual({ reqtype: "fileupload", time: "24h" });
  });

  it("migrates legacy 0x0 dump config to litterbox defaults", () => {
    const cfg = defaultConfig("/srv/project-a");
    cfg.delivery.publicDump.endpoint = "https://0x0.st";
    cfg.delivery.publicDump.fileField = "file";
    const normalized = normalizeConfig(cfg, "/srv/project-a");
    expect(normalized.delivery.publicDump.endpoint).toBe("https://litterbox.catbox.moe/resources/internals/api.php");
    expect(normalized.delivery.publicDump.fileField).toBe("fileToUpload");
    expect(normalized.delivery.publicDump.extraFields).toEqual({ reqtype: "fileupload", time: "24h" });
    expect(normalized.delivery.modeDefault).toBe("public_encrypted");
  });

  it("migrates legacy uguu dump config to litterbox defaults", () => {
    const cfg = defaultConfig("/srv/project-a");
    cfg.delivery.publicDump.endpoint = "https://uguu.se/upload.php";
    cfg.delivery.publicDump.fileField = "files[]";
    const normalized = normalizeConfig(cfg, "/srv/project-a");
    expect(normalized.delivery.publicDump.endpoint).toBe("https://litterbox.catbox.moe/resources/internals/api.php");
    expect(normalized.delivery.publicDump.fileField).toBe("fileToUpload");
    expect(normalized.delivery.publicDump.extraFields).toEqual({ reqtype: "fileupload", time: "24h" });
    expect(normalized.delivery.modeDefault).toBe("public_encrypted");
  });

  it("migrates legacy catbox dump config to litterbox defaults", () => {
    const cfg = defaultConfig("/srv/project-a");
    cfg.delivery.publicDump.endpoint = "https://catbox.moe/user/api.php";
    cfg.delivery.publicDump.fileField = "fileToUpload";
    const normalized = normalizeConfig(cfg, "/srv/project-a");
    expect(normalized.delivery.publicDump.endpoint).toBe("https://litterbox.catbox.moe/resources/internals/api.php");
    expect(normalized.delivery.publicDump.fileField).toBe("fileToUpload");
    expect(normalized.delivery.publicDump.extraFields).toEqual({ reqtype: "fileupload", time: "24h" });
    expect(normalized.delivery.modeDefault).toBe("public_encrypted");
  });
});

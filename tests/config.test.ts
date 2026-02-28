import { describe, expect, it } from "vitest";
import { computeServiceName, defaultConfig } from "../src/config.js";

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
});

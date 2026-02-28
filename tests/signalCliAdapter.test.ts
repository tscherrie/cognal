import { beforeEach, describe, expect, it, vi } from "vitest";

const runCommandMock = vi.fn();

vi.mock("../src/core/utils.js", () => {
  return {
    runCommand: (...args: unknown[]) => runCommandMock(...args)
  };
});

import { SignalCliAdapter } from "../src/adapters/signalCliAdapter.js";

describe("SignalCliAdapter createDeviceLinkUri", () => {
  beforeEach(() => {
    runCommandMock.mockReset();
  });

  it("returns direct sgnl URI", async () => {
    runCommandMock.mockResolvedValue({
      code: 0,
      stdout: "sgnl://linkdevice?uuid=abc&pub_key=def\n",
      stderr: ""
    });
    const adapter = new SignalCliAdapter("signal-cli", "/tmp/signal", undefined);
    const uri = await adapter.createDeviceLinkUri("cognal");
    expect(uri).toBe("sgnl://linkdevice?uuid=abc&pub_key=def");
  });

  it("converts legacy tsdevice URI to sgnl URI", async () => {
    runCommandMock.mockResolvedValue({
      code: 0,
      stdout: "tsdevice:/?uuid=abc&pub_key=def\n",
      stderr: ""
    });
    const adapter = new SignalCliAdapter("signal-cli", "/tmp/signal", undefined);
    const uri = await adapter.createDeviceLinkUri("cognal");
    expect(uri).toBe("sgnl://linkdevice?uuid=abc&pub_key=def");
  });

  it("throws when signal-cli exits non-zero", async () => {
    runCommandMock.mockResolvedValue({
      code: 127,
      stdout: "",
      stderr: "signal-cli: command not found"
    });
    const adapter = new SignalCliAdapter("signal-cli", "/tmp/signal", undefined);
    await expect(adapter.createDeviceLinkUri("cognal")).rejects.toThrow(
      "signal-cli link failed"
    );
  });

  it("throws when no valid URI is present", async () => {
    runCommandMock.mockResolvedValue({
      code: 0,
      stdout: "Linking device, please wait...",
      stderr: ""
    });
    const adapter = new SignalCliAdapter("signal-cli", "/tmp/signal", undefined);
    await expect(adapter.createDeviceLinkUri("cognal")).rejects.toThrow(
      "did not contain a valid device-link URI"
    );
  });

  it("throws when URI does not contain pub_key", async () => {
    runCommandMock.mockResolvedValue({
      code: 0,
      stdout: "sgnl://linkdevice?uuid=abc\n",
      stderr: ""
    });
    const adapter = new SignalCliAdapter("signal-cli", "/tmp/signal", undefined);
    await expect(adapter.createDeviceLinkUri("cognal")).rejects.toThrow(
      "incomplete link URI"
    );
  });
});

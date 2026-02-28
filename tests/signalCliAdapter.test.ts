import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const spawnMock = vi.fn();
const runCommandMock = vi.fn();

vi.mock("node:child_process", () => {
  return {
    spawn: (...args: unknown[]) => spawnMock(...args)
  };
});

vi.mock("../src/core/utils.js", () => {
  return {
    runCommand: (...args: unknown[]) => runCommandMock(...args)
  };
});

import { SignalCliAdapter } from "../src/adapters/signalCliAdapter.js";

class MockChild extends EventEmitter {
  stdout = new EventEmitter();
  stderr = new EventEmitter();

  kill = vi.fn(() => {
    this.emit("close", -1);
    return true;
  });
}

describe("SignalCliAdapter createDeviceLinkSession", () => {
  beforeEach(() => {
    spawnMock.mockReset();
    runCommandMock.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns direct sgnl URI and completion resolves", async () => {
    const proc = new MockChild();
    spawnMock.mockReturnValue(proc);
    const adapter = new SignalCliAdapter("signal-cli", "/tmp/signal", undefined);

    const sessionPromise = adapter.createDeviceLinkSession("cognal", { timeoutMs: 30_000 });
    proc.stdout.emit("data", "sgnl://linkdevice?uuid=abc&pub_key=def\n");
    const session = await sessionPromise;
    expect(session.uri).toBe("sgnl://linkdevice?uuid=abc&pub_key=def");

    proc.emit("close", 0);
    await expect(session.completion).resolves.toBeUndefined();
  });

  it("converts legacy tsdevice URI to sgnl URI", async () => {
    const proc = new MockChild();
    spawnMock.mockReturnValue(proc);
    const adapter = new SignalCliAdapter("signal-cli", "/tmp/signal", undefined);

    const sessionPromise = adapter.createDeviceLinkSession("cognal", { timeoutMs: 30_000 });
    proc.stderr.emit("data", "tsdevice:/?uuid=abc&pub_key=def\n");
    const session = await sessionPromise;
    expect(session.uri).toBe("sgnl://linkdevice?uuid=abc&pub_key=def");

    proc.emit("close", 0);
    await expect(session.completion).resolves.toBeUndefined();
  });

  it("rejects if command exits before emitting URI", async () => {
    const proc = new MockChild();
    spawnMock.mockReturnValue(proc);
    const adapter = new SignalCliAdapter("signal-cli", "/tmp/signal", undefined);

    const sessionPromise = adapter.createDeviceLinkSession("cognal", { timeoutMs: 30_000 });
    proc.stderr.emit("data", "signal-cli: command not found");
    proc.emit("close", 127);

    await expect(sessionPromise).rejects.toThrow("signal-cli link failed");
  });

  it("returns URI but completion rejects if linking later fails", async () => {
    const proc = new MockChild();
    spawnMock.mockReturnValue(proc);
    const adapter = new SignalCliAdapter("signal-cli", "/tmp/signal", undefined);

    const sessionPromise = adapter.createDeviceLinkSession("cognal", { timeoutMs: 30_000 });
    proc.stdout.emit("data", "sgnl://linkdevice?uuid=abc&pub_key=def\n");
    const session = await sessionPromise;
    proc.stderr.emit("data", "Timed out");
    proc.emit("close", -1);

    await expect(session.completion).rejects.toThrow("signal-cli link failed");
  });

  it("kills the process when session timeout is reached", async () => {
    vi.useFakeTimers();
    const proc = new MockChild();
    spawnMock.mockReturnValue(proc);
    const adapter = new SignalCliAdapter("signal-cli", "/tmp/signal", undefined);

    const sessionPromise = adapter.createDeviceLinkSession("cognal", { timeoutMs: 1000 });
    vi.advanceTimersByTime(1100);

    expect(proc.kill).toHaveBeenCalledWith("SIGTERM");
    await expect(sessionPromise).rejects.toThrow("signal-cli link failed");
  });
});

describe("SignalCliAdapter receive", () => {
  beforeEach(() => {
    runCommandMock.mockReset();
  });

  it("parses regular inbound dataMessage events", async () => {
    runCommandMock.mockResolvedValue({
      code: 0,
      stdout: JSON.stringify({
        envelope: {
          sourceNumber: "+4915123456789",
          sourceDevice: 1,
          timestamp: 1700000000000,
          dataMessage: {
            message: "hello",
            attachments: []
          }
        }
      }),
      stderr: ""
    });

    const adapter = new SignalCliAdapter("signal-cli", "/tmp/signal", undefined);
    const events = await adapter.receive(5);
    expect(events).toEqual([
      {
        source: "+4915123456789",
        sourceDevice: 1,
        isSyncSent: false,
        text: "hello",
        signalMessageId: "1700000000000",
        attachments: []
      }
    ]);
  });

  it("parses syncMessage sentMessage events used for linked-device chat", async () => {
    runCommandMock.mockResolvedValue({
      code: 0,
      stdout: JSON.stringify({
        envelope: {
          sourceNumber: "+4915123456789",
          sourceDevice: 1,
          timestamp: 1700000000100,
          syncMessage: {
            sentMessage: {
              timestamp: 1700000000200,
              message: "/codex",
              attachments: []
            }
          }
        }
      }),
      stderr: ""
    });

    const adapter = new SignalCliAdapter("signal-cli", "/tmp/signal", undefined);
    const events = await adapter.receive(5);
    expect(events).toEqual([
      {
        source: "+4915123456789",
        sourceDevice: 1,
        isSyncSent: true,
        text: "/codex",
        signalMessageId: "1700000000200",
        attachments: []
      }
    ]);
  });
});

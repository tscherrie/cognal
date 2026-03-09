import { describe, expect, it, vi, beforeEach } from "vitest";
import { ClaudeAdapter } from "../src/agents/claudeAdapter.js";

const queryMock = vi.fn();

vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  query: (...args: unknown[]) => queryMock(...args)
}));

describe("ClaudeAdapter", () => {
  beforeEach(() => {
    queryMock.mockReset();
  });

  it("uses local command output when the result body is empty", async () => {
    const iterator = (async function* () {
      yield {
        type: "system",
        subtype: "local_command_output",
        content: "Error: No messages to compact",
        session_id: "s1"
      };
      yield {
        type: "result",
        subtype: "success",
        result: "",
        session_id: "s1"
      };
    })();
    queryMock.mockReturnValue({
      [Symbol.asyncIterator]() {
        return iterator;
      },
      close() {}
    });

    const adapter = new ClaudeAdapter("claude");
    const runtime = await adapter.start({ userId: "u1", sessionRef: null, fresh: true });
    const output = await adapter.send(runtime, "/compact", 0, 1_000);

    expect(output.text).toBe("Error: No messages to compact");
    expect(output.sessionRef).toBe("s1");
  });
});

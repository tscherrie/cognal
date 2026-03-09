import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import os from "node:os";
import path from "node:path";
import { promises as fs } from "node:fs";
import { TelegramBotAdapter } from "../src/adapters/telegramBotAdapter.js";

function mockJsonResponse(data: unknown): Response {
  return new Response(JSON.stringify(data), {
    status: 200,
    headers: { "content-type": "application/json" }
  });
}

describe("TelegramBotAdapter", () => {
  const fetchMock = vi.fn();
  const statePath = path.join(os.tmpdir(), `cognal-test-offset-${Date.now()}.txt`);

  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    try {
      await fs.unlink(statePath);
    } catch {
      // ignore
    }
  });

  it("parses updates and normalizes command mentions", async () => {
    fetchMock
      .mockResolvedValueOnce(
        mockJsonResponse({
          ok: true,
          result: {
            id: 42,
            username: "mybot"
          }
        })
      )
      .mockResolvedValueOnce(
        mockJsonResponse({
          ok: true,
          result: [
            {
              update_id: 100,
              message: {
                message_id: 55,
                date: 1_700_000_000,
                text: "/codex@mybot",
                from: {
                  id: 123456789,
                  username: "jeremias",
                  first_name: "Jeremias"
                },
                chat: {
                  id: -1001234,
                  type: "supergroup",
                  title: "Team"
                },
                entities: [{ type: "bot_command", offset: 0, length: 12 }],
                photo: [{ file_id: "p1", file_size: 100 }, { file_id: "p2", file_size: 200 }]
              }
            }
          ]
        })
      );

    const adapter = new TelegramBotAdapter("TOKEN", statePath, "mybot");
    const events = await adapter.receive(5);

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      chatId: "-1001234",
      chatType: "supergroup",
      fromUserId: "123456789",
      fromUsername: "jeremias",
      text: "/codex@mybot",
      isCommand: true,
      isMentioned: true,
      isReplyToBot: false,
      transportMessageId: "55"
    });
    expect(events[0].attachments).toEqual([
      {
        type: "image",
        fileId: "p2",
        fileName: "photo-55.jpg",
        contentType: "image/jpeg",
        sizeBytes: 200
      }
    ]);
  });

  it("downloads attachment via getFile and file endpoint", async () => {
    fetchMock
      .mockResolvedValueOnce(
        mockJsonResponse({
          ok: true,
          result: {
            file_path: "documents/test.txt"
          }
        })
      )
      .mockResolvedValueOnce(new Response("hello-file", { status: 200 }));

    const adapter = new TelegramBotAdapter("TOKEN", statePath, "mybot");
    const outPath = path.join(os.tmpdir(), `cognal-download-${Date.now()}.txt`);
    await adapter.downloadAttachment("file123", outPath);

    const content = await fs.readFile(outPath, "utf8");
    expect(content).toBe("hello-file");

    const firstCall = fetchMock.mock.calls[0][0] as string;
    const secondCall = fetchMock.mock.calls[1][0] as string;
    expect(firstCall).toContain("/botTOKEN/getFile");
    expect(secondCall).toContain("/file/botTOKEN/documents/test.txt");

    await fs.unlink(outPath);
  });

  it("retries transient Telegram send failures", async () => {
    fetchMock
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            ok: false,
            error_code: 429,
            description: "Too Many Requests: retry after 1"
          }),
          { status: 429, headers: { "content-type": "application/json" } }
        )
      )
      .mockResolvedValueOnce(mockJsonResponse({ ok: true, result: true }));

    const adapter = new TelegramBotAdapter("TOKEN", statePath, "mybot");
    await adapter.sendMessage("123", "hello");

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

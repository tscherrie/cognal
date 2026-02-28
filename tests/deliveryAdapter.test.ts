import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DeliveryAdapter } from "../src/adapters/deliveryAdapter.js";

async function createTempPng(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "cognal-delivery-test-"));
  const filePath = path.join(dir, "qr.png");
  await fs.writeFile(filePath, Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3]));
  return filePath;
}

async function cleanupTempFile(filePath: string): Promise<void> {
  await fs.rm(path.dirname(filePath), { recursive: true, force: true });
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("DeliveryAdapter public_encrypted", () => {
  it("fails if no public endpoint is configured", async () => {
    const pngPath = await createTempPng();
    const adapter = new DeliveryAdapter({
      publicDump: {
        endpoint: "",
        fileField: "file",
        timeoutSec: 5
      }
    });

    await expect(adapter.deliverQrByPublicEncrypted(pngPath)).rejects.toThrow(
      "public_encrypted delivery requires a public upload endpoint"
    );

    await cleanupTempFile(pngPath);
  });

  it("returns local only when fallback is explicitly enabled", async () => {
    const pngPath = await createTempPng();
    const adapter = new DeliveryAdapter({
      publicDump: {
        endpoint: "",
        fileField: "file",
        timeoutSec: 5
      }
    });

    const result = await adapter.deliverQrByPublicEncrypted(pngPath, { allowLocalFallback: true });

    expect(result.mode).toBe("local");
    expect(result.target.endsWith(".secure.html")).toBe(true);
    expect(result.secret).toBeTruthy();

    await cleanupTempFile(pngPath);
  });

  it("returns a public URL when upload succeeds", async () => {
    const pngPath = await createTempPng();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("https://0x0.st/abc123\n", { status: 200 }))
    );

    const adapter = new DeliveryAdapter({
      publicDump: {
        endpoint: "https://0x0.st",
        fileField: "file",
        timeoutSec: 5
      }
    });

    const result = await adapter.deliverQrByPublicEncrypted(pngPath);

    expect(result.mode).toBe("public_encrypted");
    expect(result.target).toBe("https://0x0.st/abc123");
    expect(result.secret).toBeTruthy();

    await cleanupTempFile(pngPath);
  });

  it("extracts a public URL from JSON responses", async () => {
    const pngPath = await createTempPng();
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              success: true,
              files: [{ url: "https://o.uguu.se/FRBfJJKc" }]
            }),
            { status: 200 }
          )
      )
    );

    const adapter = new DeliveryAdapter({
      publicDump: {
        endpoint: "https://uguu.se/upload.php",
        fileField: "files[]",
        timeoutSec: 5
      }
    });

    const result = await adapter.deliverQrByPublicEncrypted(pngPath);

    expect(result.mode).toBe("public_encrypted");
    expect(result.target).toBe("https://o.uguu.se/FRBfJJKc");
    expect(result.secret).toBeTruthy();

    await cleanupTempFile(pngPath);
  });

  it("fails clearly when upload fails and fallback is disabled", async () => {
    const pngPath = await createTempPng();
    vi.stubGlobal("fetch", vi.fn(async () => new Response("down", { status: 503 })));
    const adapter = new DeliveryAdapter({
      publicDump: {
        endpoint: "https://0x0.st",
        fileField: "file",
        timeoutSec: 5
      }
    });

    await expect(adapter.deliverQrByPublicEncrypted(pngPath)).rejects.toThrow(
      "public_encrypted upload failed"
    );

    await cleanupTempFile(pngPath);
  });

  it("includes network cause details when fetch throws", async () => {
    const pngPath = await createTempPng();
    const fetchErr = Object.assign(new Error("fetch failed"), {
      cause: { code: "ETIMEDOUT", message: "connect ETIMEDOUT 168.119.145.117:443" }
    });
    vi.stubGlobal("fetch", vi.fn(async () => { throw fetchErr; }));
    const adapter = new DeliveryAdapter({
      publicDump: {
        endpoint: "https://0x0.st",
        fileField: "file",
        timeoutSec: 5
      }
    });

    await expect(adapter.deliverQrByPublicEncrypted(pngPath)).rejects.toThrow(/ETIMEDOUT/);

    await cleanupTempFile(pngPath);
  });
});

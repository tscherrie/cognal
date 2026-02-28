import { describe, expect, it } from "vitest";
import {
  createEncryptedViewerBundle,
  decryptQrPngForTest,
  generatePassword
} from "../src/adapters/publicEncryptedBundle.js";

describe("public encrypted QR bundle", () => {
  it("encrypts/decrypts bytes with password", () => {
    const pngBytes = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3, 4, 5, 6]);
    const password = generatePassword(22);

    const bundle = createEncryptedViewerBundle(pngBytes, password);
    const decrypted = decryptQrPngForTest(bundle.payload, password);

    expect(decrypted.equals(pngBytes)).toBe(true);
  });

  it("does not leak password in generated html", () => {
    const pngBytes = Buffer.from([1, 2, 3, 4, 5]);
    const password = "TopSecretPass123";

    const bundle = createEncryptedViewerBundle(pngBytes, password);

    expect(bundle.html).not.toContain(password);
    expect(bundle.html).toContain("decrypt");
  });

  it("fails decryption with wrong password", () => {
    const pngBytes = Buffer.from([99, 88, 77, 66, 55]);
    const bundle = createEncryptedViewerBundle(pngBytes, "CorrectPass123");

    expect(() => decryptQrPngForTest(bundle.payload, "WrongPass123")).toThrow();
  });
});

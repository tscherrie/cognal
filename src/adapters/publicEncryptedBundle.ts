import { createCipheriv, createDecipheriv, pbkdf2Sync, randomBytes } from "node:crypto";

export interface EncryptedViewerPayload {
  v: 1;
  alg: "AES-256-GCM";
  kdf: "PBKDF2-SHA256";
  iterations: number;
  saltB64: string;
  ivB64: string;
  tagB64: string;
  ciphertextB64: string;
}

const KDF_ITERATIONS = 210_000;
const KEY_BYTES = 32;
const SALT_BYTES = 16;
const IV_BYTES = 12;

function toB64(input: Uint8Array): string {
  return Buffer.from(input).toString("base64");
}

function fromB64(input: string): Buffer {
  return Buffer.from(input, "base64");
}

function deriveKey(password: string, salt: Buffer, iterations: number): Buffer {
  return pbkdf2Sync(password, salt, iterations, KEY_BYTES, "sha256");
}

export function generatePassword(length = 20): string {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789";
  const random = randomBytes(length);
  let out = "";
  for (let i = 0; i < length; i += 1) {
    out += alphabet[random[i] % alphabet.length];
  }
  return out;
}

export function encryptQrPng(pngBytes: Buffer, password: string): EncryptedViewerPayload {
  const salt = randomBytes(SALT_BYTES);
  const iv = randomBytes(IV_BYTES);
  const key = deriveKey(password, salt, KDF_ITERATIONS);

  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(pngBytes), cipher.final()]);
  const tag = cipher.getAuthTag();

  return {
    v: 1,
    alg: "AES-256-GCM",
    kdf: "PBKDF2-SHA256",
    iterations: KDF_ITERATIONS,
    saltB64: toB64(salt),
    ivB64: toB64(iv),
    tagB64: toB64(tag),
    ciphertextB64: toB64(ciphertext)
  };
}

export function decryptQrPngForTest(payload: EncryptedViewerPayload, password: string): Buffer {
  const salt = fromB64(payload.saltB64);
  const iv = fromB64(payload.ivB64);
  const tag = fromB64(payload.tagB64);
  const ciphertext = fromB64(payload.ciphertextB64);

  const key = deriveKey(password, salt, payload.iterations);
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);

  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

export function buildEncryptedViewerHtml(payload: EncryptedViewerPayload): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <title>Cognal Secure QR</title>
  <style>
    body { font-family: -apple-system, Segoe UI, Roboto, sans-serif; margin: 24px; color: #111; }
    .card { max-width: 560px; border: 1px solid #ddd; border-radius: 10px; padding: 18px; }
    input { width: 100%; padding: 10px; font-size: 14px; margin: 8px 0; }
    button { padding: 10px 14px; font-size: 14px; cursor: pointer; }
    #status { margin-top: 10px; color: #444; white-space: pre-wrap; }
    img { margin-top: 14px; max-width: 100%; border: 1px solid #ddd; border-radius: 8px; display: none; }
    .muted { color: #666; font-size: 13px; }
  </style>
</head>
<body>
  <div class="card">
    <h2>Cognal Secure Signal QR</h2>
    <p class="muted">Enter the one-time password you received separately to decrypt and reveal the QR image.</p>
    <input id="pwd" type="password" placeholder="Password" autocomplete="off" />
    <button id="openBtn" type="button">Decrypt QR</button>
    <div id="status"></div>
    <img id="qr" alt="Signal device-link QR" />
  </div>

  <script>
    const payload = ${JSON.stringify(payload)};

    const statusEl = document.getElementById("status");
    const imgEl = document.getElementById("qr");
    const pwdEl = document.getElementById("pwd");
    const openBtn = document.getElementById("openBtn");

    const b64ToBytes = (b64) => Uint8Array.from(atob(b64), c => c.charCodeAt(0));
    const concat = (a, b) => {
      const out = new Uint8Array(a.length + b.length);
      out.set(a, 0);
      out.set(b, a.length);
      return out;
    };

    async function decryptAndShow() {
      const password = String(pwdEl.value || "");
      if (!password) {
        statusEl.textContent = "Password required.";
        return;
      }

      statusEl.textContent = "Decrypting...";
      try {
        const enc = new TextEncoder();
        const keyMat = await crypto.subtle.importKey("raw", enc.encode(password), "PBKDF2", false, ["deriveKey"]);
        const key = await crypto.subtle.deriveKey(
          {
            name: "PBKDF2",
            salt: b64ToBytes(payload.saltB64),
            iterations: payload.iterations,
            hash: "SHA-256"
          },
          keyMat,
          { name: "AES-GCM", length: 256 },
          false,
          ["decrypt"]
        );

        const ciphertext = b64ToBytes(payload.ciphertextB64);
        const tag = b64ToBytes(payload.tagB64);
        const encrypted = concat(ciphertext, tag);

        const plain = await crypto.subtle.decrypt(
          {
            name: "AES-GCM",
            iv: b64ToBytes(payload.ivB64),
            tagLength: 128
          },
          key,
          encrypted
        );

        const blob = new Blob([plain], { type: "image/png" });
        const url = URL.createObjectURL(blob);
        imgEl.src = url;
        imgEl.style.display = "block";
        statusEl.textContent = "Success. Open Signal on your phone and scan this QR from the linked-device flow.";
      } catch (_err) {
        statusEl.textContent = "Wrong password or invalid payload.";
        imgEl.style.display = "none";
        imgEl.removeAttribute("src");
      }
    }

    openBtn.addEventListener("click", decryptAndShow);
    pwdEl.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        decryptAndShow();
      }
    });
  </script>
</body>
</html>
`;
}

export function createEncryptedViewerBundle(pngBytes: Buffer, password: string): {
  payload: EncryptedViewerPayload;
  html: string;
} {
  const payload = encryptQrPng(pngBytes, password);
  return {
    payload,
    html: buildEncryptedViewerHtml(payload)
  };
}

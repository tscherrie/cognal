import { describe, expect, it } from "vitest";
import { chunkTelegramHtml, formatTelegramHtml } from "../src/core/telegramFormat.js";

describe("formatTelegramHtml", () => {
  it("formats headings, bullets, and local markdown links for Telegram HTML", () => {
    const input = [
      "**Projektziel**",
      "Das steht in [README.md](/home/user/project/README.md).",
      "",
      "- Ein Punkt",
      "## Abschnitt"
    ].join("\n");

    const html = formatTelegramHtml(input);

    expect(html).toContain("<b>Projektziel</b>");
    expect(html).toContain("<code>README.md</code>");
    expect(html).toContain("• Ein Punkt");
    expect(html).toContain("<b>Abschnitt</b>");
    expect(html).not.toContain("[README.md]");
  });

  it("converts markdown tables into readable bullet pairs", () => {
    const input = [
      "| Bereich | Stand |",
      "|---|---|",
      "| **DIP API-Integration** | Vollständig |",
      "| **Cron-Sync** | Vorhanden |"
    ].join("\n");

    const html = formatTelegramHtml(input);

    expect(html).toContain("• <b>Bereich:</b> <b>DIP API-Integration</b>");
    expect(html).toContain("<b>Stand:</b> Vollständig");
    expect(html).not.toContain("|");
  });

  it("preserves fenced code blocks as preformatted HTML", () => {
    const input = ["```ts", "const x = 1 < 2;", "```"].join("\n");
    const html = formatTelegramHtml(input);
    expect(html).toBe("<pre>const x = 1 &lt; 2;</pre>");
  });
});

describe("chunkTelegramHtml", () => {
  it("chunks on paragraph boundaries where possible", () => {
    const html = ["<b>One</b>", "Alpha", "", "<b>Two</b>", "Beta"].join("\n");
    const chunks = chunkTelegramHtml(html, 18);

    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks[0]).toContain("<b>One</b>");
    expect(chunks[1]).toContain("<b>Two</b>");
  });
});

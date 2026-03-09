function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function isLikelyUrl(value: string): boolean {
  return /^https?:\/\//i.test(value.trim());
}

function stripLocalMarkdownLinks(text: string): string {
  return text.replace(/\[([^\]]+)\]\((\/[^)\s]+)\)/g, (_match, label) => `<code>${escapeHtml(String(label))}</code>`);
}

function convertMarkdownLinks(text: string): string {
  return text.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_match, label, href) => {
    const safeLabel = escapeHtml(String(label));
    const safeHref = escapeHtml(String(href));
    if (!isLikelyUrl(String(href))) {
      return `<code>${safeLabel}</code>`;
    }
    return `<a href="${safeHref}">${safeLabel}</a>`;
  });
}

function convertInlineCode(text: string): string {
  return text.replace(/`([^`]+)`/g, (_match, code) => `<code>${escapeHtml(String(code))}</code>`);
}

function convertBold(text: string): string {
  return text.replace(/\*\*([^*]+)\*\*/g, (_match, content) => `<b>${content.trim()}</b>`);
}

function convertItalic(text: string): string {
  return text.replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, (_match, prefix, content) => `${prefix}<i>${content.trim()}</i>`);
}

function normalizeLine(line: string): string {
  let out = escapeHtml(line);
  out = stripLocalMarkdownLinks(out);
  out = convertMarkdownLinks(out);
  out = convertInlineCode(out);
  out = convertBold(out);
  out = convertItalic(out);
  return out;
}

function isDivider(line: string): boolean {
  return /^-{3,}\s*$/.test(line.trim());
}

function isTableLine(line: string): boolean {
  const trimmed = line.trim();
  return trimmed.startsWith("|") && trimmed.endsWith("|") && trimmed.split("|").length >= 4;
}

function splitTableCells(line: string): string[] {
  return line
    .trim()
    .slice(1, -1)
    .split("|")
    .map((cell) => cell.trim());
}

function isTableSeparator(line: string): boolean {
  return splitTableCells(line).every((cell) => /^:?-{2,}:?$/.test(cell));
}

function formatTableRow(headers: string[], row: string[]): string {
  if (headers.length >= 2 && row.length >= 2) {
    return `• <b>${normalizeLine(headers[0])}:</b> ${normalizeLine(row[0])}\n  <b>${normalizeLine(headers[1])}:</b> ${normalizeLine(
      row[1]
    )}`;
  }
  return `• ${row.map((cell) => normalizeLine(cell)).join(" | ")}`;
}

function consumeTable(lines: string[], start: number): { html: string[]; nextIndex: number } {
  const headerCells = splitTableCells(lines[start]);
  let index = start + 1;
  if (index < lines.length && isTableSeparator(lines[index])) {
    index += 1;
  }
  const html: string[] = [];
  while (index < lines.length && isTableLine(lines[index])) {
    html.push(formatTableRow(headerCells, splitTableCells(lines[index])));
    index += 1;
  }
  return { html, nextIndex: index };
}

function normalizeHeading(line: string): string | null {
  const trimmed = line.trim();
  const hashMatch = trimmed.match(/^#{1,6}\s+(.+)$/);
  if (hashMatch?.[1]) {
    return `<b>${normalizeLine(hashMatch[1])}</b>`;
  }
  const boldOnly = trimmed.match(/^\*\*([^*]+)\*\*$/);
  if (boldOnly?.[1]) {
    return `<b>${normalizeLine(boldOnly[1])}</b>`;
  }
  return null;
}

export function formatTelegramHtml(text: string): string {
  const normalized = text.replace(/\r\n/g, "\n").trim();
  if (!normalized) {
    return "";
  }

  const lines = normalized.split("\n");
  const output: string[] = [];
  let inCodeBlock = false;
  let codeLines: string[] = [];

  for (let idx = 0; idx < lines.length; idx += 1) {
    const line = lines[idx];
    const trimmed = line.trim();

    if (trimmed.startsWith("```")) {
      if (inCodeBlock) {
        output.push(`<pre>${escapeHtml(codeLines.join("\n"))}</pre>`);
        codeLines = [];
        inCodeBlock = false;
      } else {
        inCodeBlock = true;
      }
      continue;
    }

    if (inCodeBlock) {
      codeLines.push(line);
      continue;
    }

    if (!trimmed) {
      output.push("");
      continue;
    }

    if (isDivider(line)) {
      output.push("");
      continue;
    }

    if (isTableLine(line)) {
      const table = consumeTable(lines, idx);
      output.push(...table.html);
      idx = table.nextIndex - 1;
      continue;
    }

    const heading = normalizeHeading(line);
    if (heading) {
      output.push(heading);
      continue;
    }

    if (/^[-*]\s+/.test(trimmed)) {
      output.push(`• ${normalizeLine(trimmed.replace(/^[-*]\s+/, ""))}`);
      continue;
    }

    output.push(normalizeLine(line));
  }

  if (inCodeBlock && codeLines.length > 0) {
    output.push(`<pre>${escapeHtml(codeLines.join("\n"))}</pre>`);
  }

  return output.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

export function chunkTelegramHtml(html: string, size: number): string[] {
  if (html.length <= size) {
    return [html];
  }

  const paragraphs = html.split(/\n{2,}/);
  const chunks: string[] = [];
  let current = "";

  const pushCurrent = (): void => {
    if (current.trim()) {
      chunks.push(current.trim());
      current = "";
    }
  };

  for (const paragraph of paragraphs) {
    const piece = paragraph.trim();
    if (!piece) {
      continue;
    }

    const candidate = current ? `${current}\n\n${piece}` : piece;
    if (candidate.length <= size) {
      current = candidate;
      continue;
    }

    pushCurrent();

    if (piece.length <= size) {
      current = piece;
      continue;
    }

    const lines = piece.split("\n");
    let lineChunk = "";
    for (const line of lines) {
      const next = lineChunk ? `${lineChunk}\n${line}` : line;
      if (next.length <= size) {
        lineChunk = next;
        continue;
      }
      if (lineChunk) {
        chunks.push(lineChunk.trim());
      }
      if (line.length <= size) {
        lineChunk = line;
      } else {
        let index = 0;
        while (index < line.length) {
          chunks.push(line.slice(index, index + size).trim());
          index += size;
        }
        lineChunk = "";
      }
    }
    current = lineChunk;
  }

  pushCurrent();
  return chunks.length > 0 ? chunks : [html];
}

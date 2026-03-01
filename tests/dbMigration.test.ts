import { afterEach, describe, expect, it } from "vitest";
import os from "node:os";
import path from "node:path";
import { promises as fs } from "node:fs";
import sqlite3 from "sqlite3";
import { Db } from "../src/core/db.js";

sqlite3.verbose();

async function runSql(dbPath: string, sql: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const db = new sqlite3.Database(dbPath);
    db.exec(sql, (err) => {
      if (err) {
        reject(err);
        return;
      }
      db.close((closeErr) => {
        if (closeErr) {
          reject(closeErr);
          return;
        }
        resolve();
      });
    });
  });
}

async function allRows<T>(dbPath: string, sql: string): Promise<T[]> {
  return await new Promise<T[]>((resolve, reject) => {
    const db = new sqlite3.Database(dbPath);
    db.all(sql, [], (err, rows) => {
      if (err) {
        reject(err);
        return;
      }
      db.close((closeErr) => {
        if (closeErr) {
          reject(closeErr);
          return;
        }
        resolve(rows as T[]);
      });
    });
  });
}

describe("Db migrations", () => {
  const dbPath = path.join(os.tmpdir(), `cognal-migrate-${Date.now()}.sqlite`);

  afterEach(async () => {
    try {
      await fs.unlink(dbPath);
    } catch {
      // ignore
    }
  });

  it("is idempotent on legacy signal schema and adds telegram columns/tables", async () => {
    await runSql(
      dbPath,
      `
      CREATE TABLE users (
        id TEXT PRIMARY KEY,
        phone_e164 TEXT NOT NULL UNIQUE,
        email TEXT NOT NULL,
        signal_account_id TEXT,
        status TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE messages (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        signal_message_id TEXT,
        direction TEXT NOT NULL,
        body TEXT,
        created_at TEXT NOT NULL
      );
      `
    );

    const db = new Db(dbPath);
    await db.migrate();
    await db.migrate();
    await db.close();

    const userCols = await allRows<{ name: string }>(dbPath, "PRAGMA table_info(users)");
    const messageCols = await allRows<{ name: string }>(dbPath, "PRAGMA table_info(messages)");
    const tables = await allRows<{ name: string }>(
      dbPath,
      `SELECT name FROM sqlite_master WHERE type='table' AND name IN ('allowed_chats', 'access_requests')`
    );

    expect(userCols.map((c) => c.name)).toContain("telegram_user_id");
    expect(userCols.map((c) => c.name)).toContain("telegram_username");
    expect(userCols.map((c) => c.name)).toContain("display_name");
    expect(userCols.map((c) => c.name)).toContain("last_seen_at");

    expect(messageCols.map((c) => c.name)).toContain("transport_message_id");
    expect(messageCols.map((c) => c.name)).toContain("chat_id");

    expect(tables.map((t) => t.name).sort()).toEqual(["access_requests", "allowed_chats"]);
  });
});

import sqlite3 from "sqlite3";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import type { AgentType, SessionBinding, UserRecord, UserStatus } from "../types.js";

sqlite3.verbose();

interface RunResult {
  lastID: number;
  changes: number;
}

export class Db {
  private readonly db: sqlite3.Database;

  constructor(dbPath: string) {
    this.db = new sqlite3.Database(dbPath);
  }

  async close(): Promise<void> {
    await promisify(this.db.close.bind(this.db))();
  }

  private run(sql: string, params: unknown[] = []): Promise<RunResult> {
    return new Promise((resolve, reject) => {
      this.db.run(sql, params, function onRun(err) {
        if (err) {
          reject(err);
          return;
        }
        resolve({ lastID: this.lastID, changes: this.changes });
      });
    });
  }

  private get<T>(sql: string, params: unknown[] = []): Promise<T | undefined> {
    return new Promise((resolve, reject) => {
      this.db.get(sql, params, (err, row) => {
        if (err) {
          reject(err);
          return;
        }
        resolve(row as T | undefined);
      });
    });
  }

  private all<T>(sql: string, params: unknown[] = []): Promise<T[]> {
    return new Promise((resolve, reject) => {
      this.db.all(sql, params, (err, rows) => {
        if (err) {
          reject(err);
          return;
        }
        resolve(rows as T[]);
      });
    });
  }

  async migrate(): Promise<void> {
    await this.run(`
      CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY,
        phone_e164 TEXT NOT NULL UNIQUE,
        email TEXT NOT NULL,
        signal_account_id TEXT,
        status TEXT NOT NULL,
        created_at TEXT NOT NULL
      )
    `);
    await this.run(`
      CREATE TABLE IF NOT EXISTS bindings (
        user_id TEXT PRIMARY KEY,
        active_agent TEXT NOT NULL,
        claude_session_ref TEXT,
        codex_session_ref TEXT,
        updated_at TEXT NOT NULL,
        FOREIGN KEY(user_id) REFERENCES users(id)
      )
    `);
    await this.run(`
      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        signal_message_id TEXT,
        direction TEXT NOT NULL,
        body TEXT,
        created_at TEXT NOT NULL,
        FOREIGN KEY(user_id) REFERENCES users(id)
      )
    `);
    await this.run(`
      CREATE TABLE IF NOT EXISTS attachments (
        id TEXT PRIMARY KEY,
        message_id TEXT NOT NULL,
        type TEXT NOT NULL,
        path TEXT NOT NULL,
        mime TEXT NOT NULL,
        size_bytes INTEGER NOT NULL,
        expires_at TEXT NOT NULL,
        deleted_at TEXT,
        FOREIGN KEY(message_id) REFERENCES messages(id)
      )
    `);
    await this.run(`
      CREATE TABLE IF NOT EXISTS deliveries (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        mode TEXT NOT NULL,
        target TEXT NOT NULL,
        token TEXT,
        expires_at TEXT,
        delivered_at TEXT,
        created_at TEXT NOT NULL,
        FOREIGN KEY(user_id) REFERENCES users(id)
      )
    `);
    await this.run(`
      CREATE TABLE IF NOT EXISTS agent_runtime (
        user_id TEXT NOT NULL,
        agent TEXT NOT NULL,
        pid INTEGER,
        started_at TEXT,
        stopped_at TEXT,
        last_error TEXT,
        PRIMARY KEY (user_id, agent),
        FOREIGN KEY(user_id) REFERENCES users(id)
      )
    `);
  }

  async addUser(phoneE164: string, email: string): Promise<UserRecord> {
    const now = new Date().toISOString();
    const id = randomUUID();
    await this.run(
      `INSERT INTO users (id, phone_e164, email, signal_account_id, status, created_at)
       VALUES (?, ?, ?, NULL, 'pending', ?)` ,
      [id, phoneE164, email, now]
    );
    await this.run(
      `INSERT INTO bindings (user_id, active_agent, claude_session_ref, codex_session_ref, updated_at)
       VALUES (?, 'codex', NULL, NULL, ?)` ,
      [id, now]
    );
    return {
      id,
      phoneE164,
      email,
      signalAccountId: null,
      status: "pending",
      createdAt: now
    };
  }

  async getUserByPhone(phoneE164: string): Promise<UserRecord | null> {
    const row = await this.get<{
      id: string;
      phone_e164: string;
      email: string;
      signal_account_id: string | null;
      status: UserStatus;
      created_at: string;
    }>(`SELECT * FROM users WHERE phone_e164 = ?`, [phoneE164]);
    if (!row) {
      return null;
    }
    return {
      id: row.id,
      phoneE164: row.phone_e164,
      email: row.email,
      signalAccountId: row.signal_account_id,
      status: row.status,
      createdAt: row.created_at
    };
  }

  async getUserById(id: string): Promise<UserRecord | null> {
    const row = await this.get<{
      id: string;
      phone_e164: string;
      email: string;
      signal_account_id: string | null;
      status: UserStatus;
      created_at: string;
    }>(`SELECT * FROM users WHERE id = ?`, [id]);
    if (!row) {
      return null;
    }
    return {
      id: row.id,
      phoneE164: row.phone_e164,
      email: row.email,
      signalAccountId: row.signal_account_id,
      status: row.status,
      createdAt: row.created_at
    };
  }

  async listUsers(): Promise<UserRecord[]> {
    const rows = await this.all<{
      id: string;
      phone_e164: string;
      email: string;
      signal_account_id: string | null;
      status: UserStatus;
      created_at: string;
    }>(`SELECT * FROM users ORDER BY created_at ASC`);
    return rows.map((row) => ({
      id: row.id,
      phoneE164: row.phone_e164,
      email: row.email,
      signalAccountId: row.signal_account_id,
      status: row.status,
      createdAt: row.created_at
    }));
  }

  async setUserStatus(userId: string, status: UserStatus): Promise<void> {
    await this.run(`UPDATE users SET status = ? WHERE id = ?`, [status, userId]);
  }

  async setUserSignalAccountId(userId: string, signalAccountId: string): Promise<void> {
    await this.run(`UPDATE users SET signal_account_id = ?, status = 'active' WHERE id = ?`, [signalAccountId, userId]);
  }

  async getBinding(userId: string): Promise<SessionBinding> {
    const row = await this.get<{
      user_id: string;
      active_agent: AgentType;
      claude_session_ref: string | null;
      codex_session_ref: string | null;
      updated_at: string;
    }>(`SELECT * FROM bindings WHERE user_id = ?`, [userId]);
    if (!row) {
      const now = new Date().toISOString();
      await this.run(
        `INSERT INTO bindings (user_id, active_agent, claude_session_ref, codex_session_ref, updated_at)
         VALUES (?, 'codex', NULL, NULL, ?)` ,
        [userId, now]
      );
      return {
        userId,
        activeAgent: "codex",
        claudeSessionRef: null,
        codexSessionRef: null,
        updatedAt: now
      };
    }
    return {
      userId: row.user_id,
      activeAgent: row.active_agent,
      claudeSessionRef: row.claude_session_ref,
      codexSessionRef: row.codex_session_ref,
      updatedAt: row.updated_at
    };
  }

  async setActiveAgent(userId: string, activeAgent: AgentType): Promise<void> {
    const now = new Date().toISOString();
    await this.run(`UPDATE bindings SET active_agent = ?, updated_at = ? WHERE user_id = ?`, [activeAgent, now, userId]);
  }

  async updateSessionRef(userId: string, agent: AgentType, sessionRef: string): Promise<void> {
    const now = new Date().toISOString();
    if (agent === "claude") {
      await this.run(
        `UPDATE bindings SET claude_session_ref = ?, updated_at = ? WHERE user_id = ?`,
        [sessionRef, now, userId]
      );
      return;
    }
    await this.run(
      `UPDATE bindings SET codex_session_ref = ?, updated_at = ? WHERE user_id = ?`,
      [sessionRef, now, userId]
    );
  }

  async insertMessage(userId: string, signalMessageId: string | null, direction: "in" | "out", body: string): Promise<string> {
    const id = randomUUID();
    const now = new Date().toISOString();
    await this.run(
      `INSERT INTO messages (id, user_id, signal_message_id, direction, body, created_at)
       VALUES (?, ?, ?, ?, ?, ?)` ,
      [id, userId, signalMessageId, direction, body, now]
    );
    return id;
  }

  async insertAttachment(
    messageId: string,
    data: {
      type: "audio" | "image" | "document";
      path: string;
      mime: string;
      sizeBytes: number;
      expiresAt: string;
    }
  ): Promise<string> {
    const id = randomUUID();
    await this.run(
      `INSERT INTO attachments (id, message_id, type, path, mime, size_bytes, expires_at, deleted_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, NULL)` ,
      [id, messageId, data.type, data.path, data.mime, data.sizeBytes, data.expiresAt]
    );
    return id;
  }

  async listExpiredAttachmentPaths(nowIso: string): Promise<string[]> {
    const rows = await this.all<{ path: string }>(
      `SELECT path FROM attachments WHERE deleted_at IS NULL AND expires_at <= ?`,
      [nowIso]
    );
    return rows.map((row) => row.path);
  }

  async markAttachmentDeleted(path: string): Promise<void> {
    await this.run(
      `UPDATE attachments SET deleted_at = ? WHERE path = ?`,
      [new Date().toISOString(), path]
    );
  }

  async recordDelivery(userId: string, mode: "email" | "link" | "local", target: string, token: string | null, expiresAt: string | null): Promise<void> {
    await this.run(
      `INSERT INTO deliveries (id, user_id, mode, target, token, expires_at, delivered_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [randomUUID(), userId, mode, target, token, expiresAt, new Date().toISOString(), new Date().toISOString()]
    );
  }

  async setRuntimePid(userId: string, agent: AgentType, pid: number): Promise<void> {
    await this.run(
      `INSERT INTO agent_runtime (user_id, agent, pid, started_at, stopped_at, last_error)
       VALUES (?, ?, ?, ?, NULL, NULL)
       ON CONFLICT(user_id, agent) DO UPDATE SET pid=excluded.pid, started_at=excluded.started_at, stopped_at=NULL, last_error=NULL`,
      [userId, agent, pid, new Date().toISOString()]
    );
  }

  async clearRuntimePid(userId: string, agent: AgentType, error: string | null = null): Promise<void> {
    await this.run(
      `INSERT INTO agent_runtime (user_id, agent, pid, started_at, stopped_at, last_error)
       VALUES (?, ?, NULL, NULL, ?, ?)
       ON CONFLICT(user_id, agent) DO UPDATE SET pid=NULL, stopped_at=excluded.stopped_at, last_error=excluded.last_error`,
      [userId, agent, new Date().toISOString(), error]
    );
  }
}

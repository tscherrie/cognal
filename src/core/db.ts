import sqlite3 from "sqlite3";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import type { AccessRequestRecord, AgentType, AllowedChatRecord, SessionBinding, UserRecord, UserStatus } from "../types.js";

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

  private async columnExists(tableName: string, columnName: string): Promise<boolean> {
    const rows = await this.all<{ name: string }>(`PRAGMA table_info(${tableName})`);
    return rows.some((row) => row.name === columnName);
  }

  private async addColumnIfMissing(tableName: string, columnName: string, columnSql: string): Promise<void> {
    if (await this.columnExists(tableName, columnName)) {
      return;
    }
    await this.run(`ALTER TABLE ${tableName} ADD COLUMN ${columnSql}`);
  }

  private mapUser(row: {
    id: string;
    telegram_user_id: string | null;
    telegram_username: string | null;
    display_name: string | null;
    status: UserStatus;
    last_seen_at: string | null;
    created_at: string;
  }): UserRecord {
    return {
      id: row.id,
      telegramUserId: row.telegram_user_id,
      telegramUsername: row.telegram_username,
      displayName: row.display_name,
      status: row.status,
      lastSeenAt: row.last_seen_at,
      createdAt: row.created_at
    };
  }

  async migrate(): Promise<void> {
    // Keep legacy columns to avoid destructive migrations on existing Signal DBs.
    await this.run(`
      CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY,
        phone_e164 TEXT NOT NULL UNIQUE,
        email TEXT NOT NULL,
        signal_account_id TEXT,
        status TEXT NOT NULL,
        created_at TEXT NOT NULL,
        telegram_user_id TEXT,
        telegram_username TEXT,
        display_name TEXT,
        last_seen_at TEXT
      )
    `);

    await this.addColumnIfMissing("users", "telegram_user_id", "telegram_user_id TEXT");
    await this.addColumnIfMissing("users", "telegram_username", "telegram_username TEXT");
    await this.addColumnIfMissing("users", "display_name", "display_name TEXT");
    await this.addColumnIfMissing("users", "last_seen_at", "last_seen_at TEXT");

    await this.run(`CREATE UNIQUE INDEX IF NOT EXISTS idx_users_telegram_user_id ON users(telegram_user_id)`);

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
        transport_message_id TEXT,
        chat_id TEXT,
        direction TEXT NOT NULL,
        body TEXT,
        created_at TEXT NOT NULL,
        FOREIGN KEY(user_id) REFERENCES users(id)
      )
    `);
    await this.addColumnIfMissing("messages", "transport_message_id", "transport_message_id TEXT");
    await this.addColumnIfMissing("messages", "chat_id", "chat_id TEXT");

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

    await this.run(`
      CREATE TABLE IF NOT EXISTS allowed_chats (
        chat_id TEXT PRIMARY KEY,
        chat_type TEXT NOT NULL,
        title TEXT,
        created_at TEXT NOT NULL
      )
    `);

    await this.run(`
      CREATE TABLE IF NOT EXISTS access_requests (
        telegram_user_id TEXT NOT NULL,
        chat_id TEXT NOT NULL,
        username TEXT,
        display_name TEXT,
        first_seen_at TEXT NOT NULL,
        last_seen_at TEXT NOT NULL,
        status TEXT NOT NULL,
        PRIMARY KEY (telegram_user_id, chat_id)
      )
    `);
  }

  async addOrUpdateTelegramUser(
    telegramUserId: string,
    options: {
      username?: string | null;
      displayName?: string | null;
      status?: UserStatus;
      defaultActiveAgent?: AgentType;
    } = {}
  ): Promise<UserRecord> {
    const now = new Date().toISOString();
    const existing = await this.getUserByTelegramUserId(telegramUserId);
    const status = options.status ?? "active";

    if (existing) {
      await this.run(
        `UPDATE users
         SET telegram_username = COALESCE(?, telegram_username),
             display_name = COALESCE(?, display_name),
             status = ?,
             last_seen_at = ?
         WHERE id = ?`,
        [options.username ?? null, options.displayName ?? null, status, now, existing.id]
      );
      const updated = await this.getUserByTelegramUserId(telegramUserId);
      if (!updated) {
        throw new Error(`failed to reload user ${telegramUserId}`);
      }
      await this.getBinding(updated.id, options.defaultActiveAgent ?? "codex");
      return updated;
    }

    const id = randomUUID();
    const fallbackPhone = `tg:${telegramUserId}`;
    const fallbackEmail = `no-email+tg${telegramUserId}@local.invalid`;
    await this.run(
      `INSERT INTO users (
         id, phone_e164, email, signal_account_id, status, created_at,
         telegram_user_id, telegram_username, display_name, last_seen_at
       )
       VALUES (?, ?, ?, NULL, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        fallbackPhone,
        fallbackEmail,
        status,
        now,
        telegramUserId,
        options.username ?? null,
        options.displayName ?? null,
        now
      ]
    );
    await this.run(
      `INSERT INTO bindings (user_id, active_agent, claude_session_ref, codex_session_ref, updated_at)
       VALUES (?, ?, NULL, NULL, ?)`,
      [id, options.defaultActiveAgent ?? "codex", now]
    );

    const created = await this.getUserByTelegramUserId(telegramUserId);
    if (!created) {
      throw new Error(`failed to create user ${telegramUserId}`);
    }
    return created;
  }

  async touchTelegramUserSeen(
    telegramUserId: string,
    username: string | null,
    displayName: string | null
  ): Promise<void> {
    await this.run(
      `UPDATE users
       SET telegram_username = COALESCE(?, telegram_username),
           display_name = COALESCE(?, display_name),
           last_seen_at = ?
       WHERE telegram_user_id = ?`,
      [username, displayName, new Date().toISOString(), telegramUserId]
    );
  }

  async getUserByTelegramUserId(telegramUserId: string): Promise<UserRecord | null> {
    const row = await this.get<{
      id: string;
      telegram_user_id: string | null;
      telegram_username: string | null;
      display_name: string | null;
      status: UserStatus;
      last_seen_at: string | null;
      created_at: string;
    }>(`SELECT * FROM users WHERE telegram_user_id = ?`, [telegramUserId]);
    return row ? this.mapUser(row) : null;
  }

  async getUserById(id: string): Promise<UserRecord | null> {
    const row = await this.get<{
      id: string;
      telegram_user_id: string | null;
      telegram_username: string | null;
      display_name: string | null;
      status: UserStatus;
      last_seen_at: string | null;
      created_at: string;
    }>(`SELECT * FROM users WHERE id = ?`, [id]);
    return row ? this.mapUser(row) : null;
  }

  async listUsers(): Promise<UserRecord[]> {
    const rows = await this.all<{
      id: string;
      telegram_user_id: string | null;
      telegram_username: string | null;
      display_name: string | null;
      status: UserStatus;
      last_seen_at: string | null;
      created_at: string;
    }>(`SELECT * FROM users ORDER BY created_at ASC`);
    return rows.map((row) => this.mapUser(row));
  }

  async revokeByTelegramUserId(telegramUserId: string): Promise<boolean> {
    const result = await this.run(`UPDATE users SET status = 'revoked' WHERE telegram_user_id = ?`, [telegramUserId]);
    return result.changes > 0;
  }

  async setUserStatus(userId: string, status: UserStatus): Promise<void> {
    await this.run(`UPDATE users SET status = ? WHERE id = ?`, [status, userId]);
  }

  async recordAccessRequest(
    telegramUserId: string,
    chatId: string,
    username: string | null,
    displayName: string | null,
    status: "pending" | "approved" | "rejected" = "pending"
  ): Promise<void> {
    const now = new Date().toISOString();
    await this.run(
      `INSERT INTO access_requests (telegram_user_id, chat_id, username, display_name, first_seen_at, last_seen_at, status)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(telegram_user_id, chat_id) DO UPDATE SET
         username=excluded.username,
         display_name=excluded.display_name,
         last_seen_at=excluded.last_seen_at,
         status=excluded.status`,
      [telegramUserId, chatId, username, displayName, now, now, status]
    );
  }

  async listAccessRequests(status: "pending" | "approved" | "rejected" = "pending"): Promise<AccessRequestRecord[]> {
    const rows = await this.all<{
      telegram_user_id: string;
      chat_id: string;
      username: string | null;
      display_name: string | null;
      first_seen_at: string;
      last_seen_at: string;
      status: "pending" | "approved" | "rejected";
    }>(`SELECT * FROM access_requests WHERE status = ? ORDER BY last_seen_at DESC`, [status]);

    return rows.map((row) => ({
      telegramUserId: row.telegram_user_id,
      chatId: row.chat_id,
      username: row.username,
      displayName: row.display_name,
      firstSeenAt: row.first_seen_at,
      lastSeenAt: row.last_seen_at,
      status: row.status
    }));
  }

  async approveAccessRequest(telegramUserId: string, defaultActiveAgent: AgentType = "codex"): Promise<UserRecord | null> {
    const latestRequest = await this.get<{
      telegram_user_id: string;
      username: string | null;
      display_name: string | null;
    }>(
      `SELECT telegram_user_id, username, display_name
       FROM access_requests
       WHERE telegram_user_id = ?
       ORDER BY last_seen_at DESC
       LIMIT 1`,
      [telegramUserId]
    );

    const user = await this.addOrUpdateTelegramUser(telegramUserId, {
      username: latestRequest?.username ?? null,
      displayName: latestRequest?.display_name ?? null,
      status: "active",
      defaultActiveAgent
    });

    await this.run(`UPDATE access_requests SET status = 'approved' WHERE telegram_user_id = ?`, [telegramUserId]);
    return user;
  }

  async allowChat(chatId: string, chatType: AllowedChatRecord["chatType"], title: string | null = null): Promise<void> {
    await this.run(
      `INSERT INTO allowed_chats (chat_id, chat_type, title, created_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(chat_id) DO UPDATE SET chat_type=excluded.chat_type, title=excluded.title`,
      [chatId, chatType, title, new Date().toISOString()]
    );
  }

  async revokeChat(chatId: string): Promise<boolean> {
    const result = await this.run(`DELETE FROM allowed_chats WHERE chat_id = ?`, [chatId]);
    return result.changes > 0;
  }

  async isChatAllowed(chatId: string): Promise<boolean> {
    const row = await this.get<{ chat_id: string }>(`SELECT chat_id FROM allowed_chats WHERE chat_id = ?`, [chatId]);
    return Boolean(row?.chat_id);
  }

  async listAllowedChats(): Promise<AllowedChatRecord[]> {
    const rows = await this.all<{
      chat_id: string;
      chat_type: "private" | "group" | "supergroup" | "channel";
      title: string | null;
      created_at: string;
    }>(`SELECT * FROM allowed_chats ORDER BY created_at ASC`);

    return rows.map((row) => ({
      chatId: row.chat_id,
      chatType: row.chat_type,
      title: row.title,
      createdAt: row.created_at
    }));
  }

  async clearTelegramAccessState(): Promise<void> {
    await this.run(`DELETE FROM access_requests`);
    await this.run(`DELETE FROM allowed_chats`);
    await this.run(`UPDATE users SET status = 'revoked' WHERE telegram_user_id IS NOT NULL`);
  }

  async getBinding(userId: string, defaultActiveAgent: AgentType = "codex"): Promise<SessionBinding> {
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
         VALUES (?, ?, NULL, NULL, ?)`,
        [userId, defaultActiveAgent, now]
      );
      return {
        userId,
        activeAgent: defaultActiveAgent,
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
      await this.run(`UPDATE bindings SET claude_session_ref = ?, updated_at = ? WHERE user_id = ?`, [sessionRef, now, userId]);
      return;
    }
    await this.run(`UPDATE bindings SET codex_session_ref = ?, updated_at = ? WHERE user_id = ?`, [sessionRef, now, userId]);
  }

  async insertMessage(
    userId: string,
    transportMessageId: string | null,
    chatId: string | null,
    direction: "in" | "out",
    body: string
  ): Promise<string> {
    const id = randomUUID();
    const now = new Date().toISOString();
    await this.run(
      `INSERT INTO messages (id, user_id, signal_message_id, transport_message_id, chat_id, direction, body, created_at)
       VALUES (?, ?, NULL, ?, ?, ?, ?, ?)`,
      [id, userId, transportMessageId, chatId, direction, body, now]
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
       VALUES (?, ?, ?, ?, ?, ?, ?, NULL)`,
      [id, messageId, data.type, data.path, data.mime, data.sizeBytes, data.expiresAt]
    );
    return id;
  }

  async listExpiredAttachmentPaths(nowIso: string): Promise<string[]> {
    const rows = await this.all<{ path: string }>(`SELECT path FROM attachments WHERE deleted_at IS NULL AND expires_at <= ?`, [nowIso]);
    return rows.map((row) => row.path);
  }

  async markAttachmentDeleted(filePath: string): Promise<void> {
    await this.run(`UPDATE attachments SET deleted_at = ? WHERE path = ?`, [new Date().toISOString(), filePath]);
  }

  async setRuntimePid(userId: string, agent: AgentType, pid: number | null): Promise<void> {
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

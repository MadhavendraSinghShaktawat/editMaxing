import { DatabaseSync } from "node:sqlite";
import type { StatementSync } from "node:sqlite";
import { join } from "node:path";
import { HOME } from "./config.ts";

const MIGRATIONS = [
  `CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
   CREATE TABLE accounts (
     id TEXT PRIMARY KEY, label TEXT NOT NULL, config_dir TEXT, kind TEXT NOT NULL DEFAULT 'subscription',
     email TEXT, plan TEXT, signed_in INTEGER NOT NULL DEFAULT 0, models TEXT, limits TEXT, limits_at INTEGER,
     created_at INTEGER NOT NULL);
   CREATE TABLE chats (
     id TEXT PRIMARY KEY, name TEXT NOT NULL, look INTEGER NOT NULL, account_id TEXT NOT NULL REFERENCES accounts(id),
     model TEXT NOT NULL, effort TEXT, session_id TEXT, cwd TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'idle',
     detail TEXT NOT NULL DEFAULT '', station TEXT NOT NULL DEFAULT 'living', stage TEXT, mission TEXT,
     cost REAL NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, ended_at INTEGER);
   CREATE TABLE messages (
     id INTEGER PRIMARY KEY AUTOINCREMENT, chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
     role TEXT NOT NULL, kind TEXT NOT NULL DEFAULT 'text', text TEXT NOT NULL DEFAULT '', data TEXT, created_at INTEGER NOT NULL);
   CREATE INDEX messages_chat ON messages(chat_id, id);
   CREATE TABLE files (
     hash TEXT PRIMARY KEY, path TEXT NOT NULL, name TEXT NOT NULL, size INTEGER NOT NULL, mime TEXT, kind TEXT NOT NULL,
     meta TEXT, created_at INTEGER NOT NULL);
   CREATE TABLE decisions (
     id TEXT PRIMARY KEY, chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE, kind TEXT NOT NULL,
     payload TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'open', answer TEXT, created_at INTEGER NOT NULL);
   CREATE TABLE review_items (
     id INTEGER PRIMARY KEY AUTOINCREMENT, chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
     at_seconds REAL, text TEXT NOT NULL, kind TEXT NOT NULL DEFAULT 'call', data TEXT, created_at INTEGER NOT NULL);
   CREATE TABLE jobs (
     id TEXT PRIMARY KEY, kind TEXT NOT NULL, status TEXT NOT NULL, priority INTEGER NOT NULL DEFAULT 5, resource TEXT NOT NULL,
     progress REAL NOT NULL DEFAULT 0, message TEXT, payload TEXT NOT NULL, result TEXT, error TEXT,
     created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
   CREATE INDEX jobs_status ON jobs(status);
   CREATE TABLE tool_cache (key TEXT PRIMARY KEY, result TEXT NOT NULL, created_at INTEGER NOT NULL);
   CREATE TABLE edit_docs (
     chat_id TEXT NOT NULL, version INTEGER NOT NULL, doc TEXT NOT NULL, note TEXT, created_at INTEGER NOT NULL,
     PRIMARY KEY (chat_id, version));
   CREATE TABLE styles (
     id TEXT PRIMARY KEY, name TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'approved', mode TEXT, kind TEXT NOT NULL DEFAULT 'editing',
     card TEXT NOT NULL, source_hash TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
   CREATE TABLE memory_rules (
     id TEXT PRIMARY KEY, text TEXT NOT NULL, mode TEXT, style_id TEXT, status TEXT NOT NULL DEFAULT 'active',
     evidence TEXT, created_at INTEGER NOT NULL);
   CREATE TABLE corrections (
     id INTEGER PRIMARY KEY AUTOINCREMENT, text TEXT NOT NULL, tokens TEXT NOT NULL, chat_id TEXT, created_at INTEGER NOT NULL);
   CREATE TABLE recipes (
     id TEXT PRIMARY KEY, title TEXT NOT NULL, text TEXT NOT NULL, uses INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL);
   CREATE TABLE clips (
     id TEXT PRIMARY KEY, file_hash TEXT NOT NULL UNIQUE, name TEXT NOT NULL, source TEXT, collection TEXT NOT NULL DEFAULT 'general',
     duration REAL, width INTEGER, height INTEGER, fps REAL, rights TEXT, status TEXT NOT NULL DEFAULT 'pending', error TEXT,
     created_at INTEGER NOT NULL);
   CREATE TABLE shots (
     id TEXT PRIMARY KEY, clip_id TEXT NOT NULL REFERENCES clips(id) ON DELETE CASCADE, t0 REAL NOT NULL, t1 REAL NOT NULL,
     filmstrip TEXT, facts TEXT, phash TEXT, print BLOB, duplicate_of TEXT, card TEXT, meaning TEXT, tree TEXT,
     card_model TEXT, embedding BLOB, embed_model TEXT, uses INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL);
   CREATE INDEX shots_clip ON shots(clip_id);
   CREATE VIRTUAL TABLE shots_fts USING fts5(shot_id UNINDEXED, meaning, tokenize='porter unicode61');
   CREATE TABLE choices (
     id INTEGER PRIMARY KEY AUTOINCREMENT, line TEXT NOT NULL, shot_id TEXT NOT NULL, accepted INTEGER NOT NULL, chat_id TEXT,
     embedding BLOB, created_at INTEGER NOT NULL);
   CREATE TABLE usage_notes (id INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT NOT NULL, amount REAL NOT NULL, units REAL NOT NULL, created_at INTEGER NOT NULL);`,
];

export class Database {
  raw: DatabaseSync;
  private cache = new Map<string, StatementSync>();

  constructor(path = join(HOME, "dojo.db")) {
    this.raw = new DatabaseSync(path);
    this.raw.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
    this.migrate();
  }

  private migrate() {
    const version = (this.raw.prepare("PRAGMA user_version").get() as { user_version: number }).user_version;
    for (let v = version; v < MIGRATIONS.length; v++) {
      this.tx(() => {
        this.raw.exec(MIGRATIONS[v]);
        this.raw.exec(`PRAGMA user_version = ${v + 1}`);
      });
    }
  }

  private statement(sql: string) {
    let s = this.cache.get(sql);
    if (!s) {
      s = this.raw.prepare(sql);
      this.cache.set(sql, s);
    }
    return s;
  }

  run(sql: string, ...params: (string | number | bigint | null | Uint8Array)[]) {
    return this.statement(sql).run(...params);
  }

  get<T>(sql: string, ...params: (string | number | bigint | null | Uint8Array)[]) {
    return this.statement(sql).get(...params) as T | undefined;
  }

  all<T>(sql: string, ...params: (string | number | bigint | null | Uint8Array)[]) {
    return this.statement(sql).all(...params) as T[];
  }

  tx<T>(fn: () => T) {
    this.raw.exec("BEGIN IMMEDIATE");
    try {
      const out = fn();
      this.raw.exec("COMMIT");
      return out;
    } catch (e) {
      this.raw.exec("ROLLBACK");
      throw e;
    }
  }

  setting(key: string) {
    return this.get<{ value: string }>("SELECT value FROM settings WHERE key = ?", key)?.value ?? null;
  }

  setSetting(key: string, value: string) {
    this.run("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", key, value);
  }
}

export const json = <T>(text: string | null | undefined, fallback: T): T => {
  if (!text) return fallback;
  try {
    return JSON.parse(text) as T;
  } catch {
    return fallback;
  }
};

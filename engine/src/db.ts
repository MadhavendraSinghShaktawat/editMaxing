import { randomBytes, randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import type { StatementSync } from "node:sqlite";
import { join } from "node:path";
import { HOME } from "./config.ts";

type Migration = string | ((db: DatabaseSync) => void);

/**
 * Version 2 adds people. Everything already on this Mac belongs to one Owner, so a
 * single-user studio keeps working exactly as before and a Studio Hub starts from it.
 */
const TEAM = `
  CREATE TABLE members (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, role TEXT NOT NULL CHECK (role IN ('owner', 'admin', 'editor')),
    status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'removed', 'archived')),
    webauthn_id TEXT NOT NULL UNIQUE, created_at INTEGER NOT NULL, last_seen_at INTEGER, ended_at INTEGER);
  CREATE UNIQUE INDEX one_owner ON members(role) WHERE role = 'owner';
  CREATE TABLE passkeys (
    id TEXT PRIMARY KEY, member_id TEXT NOT NULL REFERENCES members(id) ON DELETE CASCADE, public_key BLOB NOT NULL,
    counter INTEGER NOT NULL DEFAULT 0, transports TEXT, device_type TEXT, backed_up INTEGER NOT NULL DEFAULT 0,
    rp_id TEXT NOT NULL, label TEXT, created_at INTEGER NOT NULL, last_used_at INTEGER);
  CREATE INDEX passkeys_member ON passkeys(member_id);
  CREATE TABLE invites (
    id TEXT PRIMARY KEY, token_hash TEXT NOT NULL UNIQUE, name TEXT NOT NULL, role TEXT NOT NULL CHECK (role IN ('admin', 'editor')),
    created_by TEXT NOT NULL REFERENCES members(id), created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL,
    used_at INTEGER, used_by TEXT REFERENCES members(id), revoked_at INTEGER);
  CREATE TABLE sessions (
    id TEXT PRIMARY KEY, token_hash TEXT NOT NULL UNIQUE, member_id TEXT NOT NULL REFERENCES members(id) ON DELETE CASCADE,
    device TEXT, created_at INTEGER NOT NULL, last_seen_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, revoked_at INTEGER);
  CREATE INDEX sessions_member ON sessions(member_id);
  CREATE TABLE audit_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT, actor_id TEXT, action TEXT NOT NULL, target_type TEXT, target_id TEXT,
    target_owner TEXT, detail TEXT, created_at INTEGER NOT NULL);
  CREATE INDEX audit_time ON audit_log(created_at);
  CREATE TABLE clients (id TEXT PRIMARY KEY, name TEXT NOT NULL, created_by TEXT NOT NULL REFERENCES members(id), created_at INTEGER NOT NULL, archived_at INTEGER);
  CREATE TABLE client_members (
    client_id TEXT NOT NULL REFERENCES clients(id) ON DELETE CASCADE, member_id TEXT NOT NULL REFERENCES members(id) ON DELETE CASCADE,
    PRIMARY KEY (client_id, member_id));
  CREATE TABLE libraries (
    id TEXT PRIMARY KEY, owner_id TEXT NOT NULL REFERENCES members(id), name TEXT NOT NULL, drive_folder_id TEXT,
    created_at INTEGER NOT NULL, removed_at INTEGER);
  CREATE TABLE library_clips (
    library_id TEXT NOT NULL REFERENCES libraries(id) ON DELETE CASCADE, clip_id TEXT NOT NULL REFERENCES clips(id) ON DELETE CASCADE,
    added_by TEXT REFERENCES members(id), added_at INTEGER NOT NULL, drive_file_id TEXT, PRIMARY KEY (library_id, clip_id));
  CREATE INDEX library_clips_clip ON library_clips(clip_id);
  CREATE TABLE shares (
    resource_type TEXT NOT NULL CHECK (resource_type IN ('library', 'style')), resource_id TEXT NOT NULL,
    grantee TEXT NOT NULL, permission TEXT NOT NULL CHECK (permission IN ('use', 'add', 'edit')),
    granted_by TEXT REFERENCES members(id), created_at INTEGER NOT NULL, PRIMARY KEY (resource_type, resource_id, grantee));
  CREATE TABLE file_access (hash TEXT NOT NULL, member_id TEXT NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY (hash, member_id));
  CREATE TABLE memory_signals (
    id INTEGER PRIMARY KEY AUTOINCREMENT, member_id TEXT NOT NULL, chat_id TEXT, client_id TEXT, kind TEXT NOT NULL,
    text TEXT NOT NULL, data TEXT, created_at INTEGER NOT NULL, processed_at INTEGER);
  CREATE INDEX memory_signals_open ON memory_signals(chat_id, processed_at);
  ALTER TABLE chats ADD COLUMN owner_id TEXT REFERENCES members(id);
  ALTER TABLE chats ADD COLUMN client_id TEXT REFERENCES clients(id);
  ALTER TABLE accounts ADD COLUMN owner_id TEXT REFERENCES members(id);
  ALTER TABLE styles ADD COLUMN owner_id TEXT REFERENCES members(id);
  ALTER TABLE recipes ADD COLUMN owner_id TEXT REFERENCES members(id);
  ALTER TABLE jobs ADD COLUMN owner_id TEXT REFERENCES members(id);
  ALTER TABLE choices ADD COLUMN member_id TEXT REFERENCES members(id);
  ALTER TABLE usage_notes ADD COLUMN member_id TEXT REFERENCES members(id);
  ALTER TABLE memory_rules ADD COLUMN scope TEXT NOT NULL DEFAULT 'personal';
  ALTER TABLE memory_rules ADD COLUMN owner_id TEXT REFERENCES members(id);
  ALTER TABLE memory_rules ADD COLUMN client_id TEXT REFERENCES clients(id);
  ALTER TABLE memory_rules ADD COLUMN area TEXT NOT NULL DEFAULT 'general';
  ALTER TABLE memory_rules ADD COLUMN confidence REAL NOT NULL DEFAULT 0.7;
  ALTER TABLE memory_rules ADD COLUMN superseded_by TEXT;
  ALTER TABLE memory_rules ADD COLUMN uses INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE memory_rules ADD COLUMN last_used_at INTEGER;
  ALTER TABLE memory_rules ADD COLUMN updated_at INTEGER;
  ALTER TABLE memory_rules ADD COLUMN created_by TEXT;
  CREATE INDEX chats_owner ON chats(owner_id, ended_at);
  CREATE INDEX memory_scope ON memory_rules(scope, owner_id, client_id, status);`;

function adoptExisting(db: DatabaseSync) {
  db.exec(TEAM);
  const owner = randomUUID();
  const now = Date.now();
  db.prepare("INSERT INTO members (id, name, role, webauthn_id, created_at) VALUES (?, 'You', 'owner', ?, ?)").run(owner, randomBytes(32).toString("base64url"), now);
  for (const table of ["chats", "accounts", "styles", "recipes", "jobs"]) db.prepare(`UPDATE ${table} SET owner_id = ?`).run(owner);
  db.prepare("UPDATE choices SET member_id = ?").run(owner);
  db.prepare("UPDATE usage_notes SET member_id = ?").run(owner);
  db.prepare("UPDATE memory_rules SET owner_id = ?, created_by = ?, updated_at = created_at").run(owner, owner);
  db.prepare("INSERT INTO file_access (hash, member_id, created_at) SELECT hash, ?, ? FROM files").run(owner, now);
  const library = randomUUID();
  db.prepare("INSERT INTO libraries (id, owner_id, name, created_at) VALUES (?, ?, 'My B-roll', ?)").run(library, owner, now);
  db.prepare("INSERT INTO library_clips (library_id, clip_id, added_by, added_at) SELECT ?, id, ?, created_at FROM clips").run(library, owner);
}

/**
 * Version 3 adds the Motion library: animations, caption presets and thumbnails saved from
 * references, sorted by what they do (operation, domain, technique) rather than how they look.
 * Sharing gains the "motion" type, which needs the shares table rebuilt for its CHECK.
 * Edit Modes are gone, so stored mode values are cleared and old mode-only memory applies everywhere.
 */
const MOTION = `
  CREATE TABLE motion_terms (
    id TEXT PRIMARY KEY, level TEXT NOT NULL CHECK (level IN ('operation', 'domain', 'technique')), label TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '', domain_id TEXT REFERENCES motion_terms(id),
    status TEXT NOT NULL DEFAULT 'approved' CHECK (status IN ('approved', 'proposed')), origin TEXT NOT NULL DEFAULT 'seed',
    proposed_by TEXT REFERENCES members(id), decided_by TEXT REFERENCES members(id), decided_at INTEGER, created_at INTEGER NOT NULL);
  CREATE TABLE motion_items (
    id TEXT PRIMARY KEY, owner_id TEXT NOT NULL REFERENCES members(id), style_id TEXT REFERENCES styles(id) ON DELETE SET NULL,
    kind TEXT NOT NULL CHECK (kind IN ('animation', 'caption', 'thumbnail')), name TEXT NOT NULL, summary TEXT NOT NULL DEFAULT '',
    operation_id TEXT REFERENCES motion_terms(id), technique_id TEXT REFERENCES motion_terms(id),
    source_hash TEXT, t0 REAL, t1 REAL, card TEXT NOT NULL, meaning TEXT NOT NULL DEFAULT '',
    loop_path TEXT, poster_path TEXT, strip_path TEXT, embedding BLOB, embed_model TEXT,
    uses INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
  CREATE INDEX motion_items_owner ON motion_items(owner_id, kind);
  CREATE INDEX motion_items_style ON motion_items(style_id);
  CREATE VIRTUAL TABLE motion_fts USING fts5(item_id UNINDEXED, meaning, tokenize='porter unicode61');
  CREATE TABLE motion_choices (
    id INTEGER PRIMARY KEY AUTOINCREMENT, member_id TEXT NOT NULL REFERENCES members(id), line TEXT NOT NULL,
    item_id TEXT NOT NULL, accepted INTEGER NOT NULL, chat_id TEXT, created_at INTEGER NOT NULL);
  CREATE TABLE shares_v3 (
    resource_type TEXT NOT NULL CHECK (resource_type IN ('library', 'style', 'motion')), resource_id TEXT NOT NULL,
    grantee TEXT NOT NULL, permission TEXT NOT NULL CHECK (permission IN ('use', 'add', 'edit')),
    granted_by TEXT REFERENCES members(id), created_at INTEGER NOT NULL, PRIMARY KEY (resource_type, resource_id, grantee));
  INSERT INTO shares_v3 SELECT resource_type, resource_id, grantee, permission, granted_by, created_at FROM shares;
  DROP TABLE shares;
  ALTER TABLE shares_v3 RENAME TO shares;
  UPDATE styles SET mode = NULL;
  UPDATE memory_rules SET mode = NULL;`;

const MIGRATIONS: Migration[] = [
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
  adoptExisting,
  MOTION,
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
        const step = MIGRATIONS[v];
        if (typeof step === "string") this.raw.exec(step);
        else step(this.raw);
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

import { createHash, randomUUID } from "node:crypto";
import { constants, createReadStream, createWriteStream, existsSync, mkdirSync, realpathSync, renameSync, rmSync } from "node:fs";
import { copyFile } from "node:fs/promises";
import { basename, extname, join } from "node:path";
import type { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { DIRS } from "./config.ts";
import type { Database } from "./db.ts";
import { json } from "./db.ts";
import { probe } from "./lib/media.ts";

export type FileKind = "video" | "audio" | "image" | "file";
export type StoredFile = { hash: string; path: string; name: string; size: number; kind: FileKind; meta: Record<string, unknown> };
type Row = { hash: string; path: string; name: string; size: number; kind: string; meta: string | null };

const VIDEO = /^\.(mp4|mov|m4v|webm|mkv|avi|mxf)$/i;
const AUDIO = /^\.(wav|mp3|m4a|aac|flac|ogg|opus|aiff?)$/i;
const IMAGE = /^\.(png|jpe?g|webp|heic|heif|gif|tiff?)$/i;
const kindOf = (name: string): FileKind => {
  const e = extname(name);
  return VIDEO.test(e) ? "video" : AUDIO.test(e) ? "audio" : IMAGE.test(e) ? "image" : "file";
};

/** Files are stored by content hash. The same footage is never stored or processed twice. */
export class Files {
  private db: Database;

  constructor(db: Database) {
    this.db = db;
  }

  private row(r: Row): StoredFile {
    return { hash: r.hash, path: r.path, name: r.name, size: r.size, kind: r.kind as FileKind, meta: json(r.meta, {}) };
  }

  get(hash: string) {
    const r = this.db.get<Row>("SELECT * FROM files WHERE hash = ?", hash);
    if (!r) throw new Error("That file is no longer available.");
    return this.row(r);
  }

  private async register(hash: string, path: string, name: string, size: number) {
    const existing = this.db.get<Row>("SELECT * FROM files WHERE hash = ?", hash);
    if (existing) return this.row(existing);
    const kind = kindOf(name);
    const meta = kind === "video" || kind === "audio" ? await probe(path).catch(() => ({})) : {};
    this.db.run("INSERT INTO files (hash, path, name, size, kind, meta, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)", hash, path, name, size, kind, JSON.stringify(meta), Date.now());
    return this.get(hash);
  }

  private target(hash: string, name: string) {
    const dir = join(DIRS.files, hash.slice(0, 2));
    mkdirSync(dir, { recursive: true });
    return join(dir, hash + extname(name).toLowerCase());
  }

  async fromStream(stream: Readable, name: string) {
    const temp = join(DIRS.tmp, randomUUID());
    const hasher = createHash("sha256");
    let size = 0;
    stream.on("data", (c: Buffer) => {
      hasher.update(c);
      size += c.length;
    });
    try {
      await pipeline(stream, createWriteStream(temp));
      const hash = hasher.digest("hex");
      const path = this.target(hash, name);
      if (existsSync(path)) rmSync(temp);
      else renameSync(temp, path);
      return await this.register(hash, path, name, size);
    } catch (e) {
      rmSync(temp, { force: true });
      throw e;
    }
  }

  /** Attachments are links into the store, so re-hashing a large video can be skipped. */
  async adopt(path: string, name = basename(path)) {
    const real = realpathSync(path);
    if (real.startsWith(DIRS.files)) {
      const r = this.db.get<Row>("SELECT * FROM files WHERE hash = ?", basename(real).replace(/\.[^.]+$/, ""));
      if (r) return this.row(r);
    }
    return this.fromPath(real, name);
  }

  /** Uses an APFS clone when possible, so large footage costs no extra disk space. */
  async fromPath(source: string, name: string) {
    const hasher = createHash("sha256");
    let size = 0;
    for await (const chunk of createReadStream(source)) {
      hasher.update(chunk as Buffer);
      size += (chunk as Buffer).length;
    }
    const hash = hasher.digest("hex");
    const path = this.target(hash, name);
    if (!existsSync(path)) await copyFile(source, path, constants.COPYFILE_FICLONE);
    return this.register(hash, path, name, size);
  }
}

/** Memoizes expensive tool output by input hash, parameters and tool version. */
export class ToolCache {
  private db: Database;

  constructor(db: Database) {
    this.db = db;
  }

  get<T>(key: string) {
    return json<T | null>(this.db.get<{ result: string }>("SELECT result FROM tool_cache WHERE key = ?", key)?.result, null);
  }

  set(key: string, value: unknown) {
    this.db.run("INSERT OR REPLACE INTO tool_cache (key, result, created_at) VALUES (?, ?, ?)", key, JSON.stringify(value), Date.now());
  }

  async remember<T>(key: string, work: () => Promise<T>) {
    const hit = this.get<T>(key);
    if (hit !== null) return hit;
    const value = await work();
    this.set(key, value);
    return value;
  }
}

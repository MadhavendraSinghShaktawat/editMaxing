import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { DIRS } from "./config.ts";
import type { Database } from "./db.ts";
import { parseDriveLink } from "./drive.ts";
import type { Files, StoredFile } from "./files.ts";
import type { JobContext, Jobs } from "./jobs.ts";
import { dropPart, readMeta, resumable, writeMeta } from "./lib/download.ts";
import { HttpError } from "./lib/http.ts";
import { probe } from "./lib/media.ts";
import { fetchSocialVideo, platformOf, safeMediaUrl } from "./social.ts";

/**
 * Pasted video links: a Google Drive file or a social post. Each becomes a background download
 * that keeps going when the window closes, carries on from where it stopped after a restart, and
 * is never fetched twice: a link that already became a file returns that file at once.
 */

export type LinkResult = { file: StoredFile; platform: string; credits: number };

/** One stable name per source, so the same video pasted twice, or from a draft, finds its file. */
export function linkKey(raw: string) {
  const drive = parseDriveLink(raw);
  if (drive?.kind === "file") return `drive:${drive.id}`;
  const { platform, url } = platformOf(raw);
  const u = new URL(url);
  // Tracking parameters don't change the video. Facebook and Reddit share links keep theirs, since the id can live there.
  const keep = ["v", "id", "story_fbid", "fbid"].filter((k) => u.searchParams.has(k)).map((k) => `${k}=${u.searchParams.get(k)}`).join("&");
  return `social:${platform.id}:${u.hostname.replace(/^(www|m|mobile)\./, "")}${u.pathname.replace(/\/+$/, "")}${keep ? `?${keep}` : ""}`;
}

/** Checks a link without downloading it, so a bad one fails at once with the reason. */
export function checkLink(raw: string) {
  const drive = parseDriveLink(raw);
  if (/drive\.google\.com|docs\.google\.com|drive\.usercontent\.google\.com/i.test(raw) && !drive) throw new HttpError(422, "That Drive link doesn't point to a video file. Open the file and copy its share link.");
  if (drive?.kind === "folder") throw new HttpError(422, "That's a folder. Paste the link to one video file.");
  if (drive) return { kind: "drive" as const, id: drive.id };
  platformOf(raw);
  return { kind: "social" as const };
}

type Payload = { url: string; key: string; name?: string };

export class Links {
  private db: Database;
  private files: Files;
  private jobs: Jobs;
  private scrapeKey: (memberId: string) => Promise<string | null>;
  private googleKey: () => Promise<string | null>;
  private fetcher: typeof fetch;

  constructor(db: Database, files: Files, jobs: Jobs, keys: { scrape: (memberId: string) => Promise<string | null>; google: () => Promise<string | null> }, fetcher: typeof fetch = fetch) {
    this.db = db;
    this.files = files;
    this.jobs = jobs;
    this.scrapeKey = keys.scrape;
    this.googleKey = keys.google;
    this.fetcher = fetcher;
    jobs.register<Payload>("link.fetch", (p, ctx) => this.run(p, ctx));
  }

  /** The file a link already became, if it's still in the store. */
  cached(key: string): LinkResult | null {
    const row = this.db.get<{ hash: string; platform: string }>("SELECT hash, platform FROM link_cache WHERE key = ?", key);
    if (!row) return null;
    try {
      return { file: this.files.get(row.hash), platform: row.platform, credits: 0 };
    } catch {
      this.db.run("DELETE FROM link_cache WHERE key = ?", key);
      return null;
    }
  }

  /**
   * A file at once when the link was fetched before; otherwise a download job. The same link
   * already downloading for this person returns that job instead of starting another.
   */
  async start(memberId: string, url: string, name?: string): Promise<{ file: LinkResult } | { job: string }> {
    const kind = checkLink(url);
    const key = linkKey(url);
    const hit = this.cached(key);
    if (hit) return { file: hit };
    if (kind.kind === "social" && !(await this.scrapeKey(memberId))) throw new HttpError(400, "Add your Scrape Creators key in Settings → Account to use social links.");
    const running = this.db.get<{ id: string }>("SELECT id FROM jobs WHERE kind = 'link.fetch' AND status IN ('queued', 'running') AND owner_id = ? AND json_extract(payload, '$.key') = ?", memberId, key);
    if (running) return { job: running.id };
    return { job: this.jobs.add("link.fetch", { url, key, name: name?.slice(0, 200) } satisfies Payload, { lane: "net", priority: 4, owner: memberId }) };
  }

  /** The whole download, for an editor tool that needs the file before it can carry on. */
  async fetchNow(memberId: string, url: string): Promise<LinkResult> {
    const kind = checkLink(url);
    const key = linkKey(url);
    const hit = this.cached(key);
    if (hit) return hit;
    if (kind.kind === "social" && !(await this.scrapeKey(memberId))) throw new HttpError(400, "Add your Scrape Creators key in Settings → Account to use social links.");
    return this.jobs.run<LinkResult>("link.fetch", { url, key } satisfies Payload, { lane: "net", priority: 3, owner: memberId });
  }

  private remember(key: string, r: LinkResult) {
    this.db.run("INSERT OR REPLACE INTO link_cache (key, hash, name, platform, created_at) VALUES (?, ?, ?, ?, ?)", key, r.file.hash, r.file.name, r.platform, Date.now());
    return r;
  }

  private async run(p: Payload, ctx: JobContext): Promise<LinkResult> {
    const hit = this.cached(p.key);
    if (hit) return hit;
    mkdirSync(DIRS.partial, { recursive: true });
    const part = join(DIRS.partial, createHash("sha256").update(p.key).digest("hex").slice(0, 32));
    const mb = (n: number) => `${Math.round(n / 1e6)} MB`;
    const progress = (done: number, total: number | null) => ctx.progress(total ? Math.min(0.99, done / total) : 0.1, total ? `${mb(done)} of ${mb(total)}` : `${mb(done)}`);
    const check = checkLink(p.url);

    if (check.kind === "drive") {
      const apiKey = await this.googleKey();
      const source = apiKey ? `https://www.googleapis.com/drive/v3/files/${check.id}?alt=media&key=${encodeURIComponent(apiKey)}&supportsAllDrives=true` : `https://drive.usercontent.google.com/download?id=${check.id}&export=download&confirm=t`;
      try {
        await resumable(source, part, {
          fetcher: this.fetcher, signal: ctx.signal, onProgress: progress, allow: safeMediaUrl,
          onResponse: (res) => {
            const name = res.headers.get("content-disposition")?.match(/filename\*?=(?:UTF-8'')?"?([^";]+)"?/i)?.[1];
            if (name) writeMeta(part, { ...readMeta(part)!, name: decodeURIComponent(name) });
          },
          accept: (res) => (/text\/html/i.test(res.headers.get("content-type") ?? "") ? "Google Drive won't share that file. Set it to “Anyone with the link”, or upload the file." : null),
        });
      } catch (e) {
        if (ctx.signal.aborted) throw e;
        // A refusal can't be continued; an interrupted download keeps its bytes for the next try.
        if (!/stopped early|ECONNRESET|socket|terminated|fetch failed/i.test((e as Error).message)) dropPart(part);
        throw e;
      }
      const info = await probe(part).catch(() => null);
      if (!info?.hasVideo) {
        dropPart(part);
        throw new Error(`${p.name ?? "That file"} isn't a video.`);
      }
      const name = readMeta(part)?.name ?? p.name ?? `${check.id}.mp4`;
      const file = await this.files.fromPath(part, /\.\w{2,4}$/.test(name) ? name : `${name}.mp4`);
      dropPart(part);
      return this.remember(p.key, { file, platform: "Google Drive", credits: 0 });
    }

    if (!ctx.owner) throw new Error("This download has no owner. Paste the link again.");
    const key = await this.scrapeKey(ctx.owner);
    if (!key) throw new Error("Add your Scrape Creators key in Settings → Account to use social links.");
    const r = await fetchSocialVideo(this.files, key, p.url, { fetcher: this.fetcher, signal: ctx.signal, part, onProgress: progress });
    return this.remember(p.key, r);
  }
}

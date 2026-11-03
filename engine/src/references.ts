import type { Bus } from "./bus.ts";
import type { ChatRow } from "./claude/chat.ts";
import { findBin } from "./config.ts";
import type { Database } from "./db.ts";
import { json } from "./db.ts";
import type { Files } from "./files.ts";
import { dHash, probe } from "./lib/media.ts";
import { runBinary } from "./lib/proc.ts";
import type { Styles } from "./styles.ts";
import { REFERENCE_TAGS } from "./styles.ts";

/**
 * Every reference shared in a chat ends up in the library. One the person already has (the same
 * file, or the same video downloaded again) is reused; a new one is learned once in the background,
 * as a style plus its animations, caption preset and thumbnail, ready for the next video.
 */

export type ReferenceState =
  | { hash: string; state: "known"; styleId: string; styleName: string; status: string; match: "exact" | "similar" }
  | { hash: string; state: "learning"; jobId: string; started: boolean }
  | { hash: string; state: "skipped"; reason: string };

export type Print = { duration: number; frames: string[] };

/** Below this, a reference is almost always a broken download rather than a video. */
export const MIN_REFERENCE_SECONDS = 3;
export const PRINT_FRAMES = 8;
export const autoLearnKey = (memberId: string) => `m:${memberId}:autolearn`;

const PRINT_W = 64;
const PRINT_H = 36;

/** One 64-bit difference hash at each of eight evenly spaced moments. Survives re-encoding and resizing. */
export async function videoPrint(path: string, duration: number, signal?: AbortSignal): Promise<Print> {
  const ffmpeg = findBin("ffmpeg");
  if (!ffmpeg) throw new Error("ffmpeg is missing");
  const frames: string[] = [];
  for (let i = 0; i < PRINT_FRAMES; i++) {
    const t = (duration * (i + 0.5)) / PRINT_FRAMES;
    const raw = await runBinary(ffmpeg, ["-loglevel", "error", "-ss", t.toFixed(3), "-i", path, "-frames:v", "1", "-an", "-vf", `scale=${PRINT_W}:${PRINT_H}:flags=area`, "-f", "rawvideo", "-pix_fmt", "rgb24", "pipe:1"], signal);
    if (raw.length >= PRINT_W * PRINT_H * 3) frames.push(dHash(raw.subarray(0, PRINT_W * PRINT_H * 3), PRINT_W, PRINT_H));
  }
  return { duration, frames };
}

const bits = (n: number) => {
  let c = 0;
  for (let v = n >>> 0; v; v &= v - 1) c++;
  return c;
};

export function hamming(a: string, b: string) {
  return bits(Number.parseInt(a.slice(0, 8), 16) ^ Number.parseInt(b.slice(0, 8), 16)) + bits(Number.parseInt(a.slice(8, 16), 16) ^ Number.parseInt(b.slice(8, 16), 16));
}

/** The same video: about the same length, and most of its moments look alike. */
export function samePrint(a: Print, b: Print) {
  if (Math.abs(a.duration - b.duration) > Math.max(0.5, 0.02 * Math.max(a.duration, b.duration))) return false;
  const n = Math.min(a.frames.length, b.frames.length);
  if (n < PRINT_FRAMES - 2) return false;
  let alike = 0;
  for (let i = 0; i < n; i++) if (hamming(a.frames[i], b.frames[i]) <= 10) alike++;
  return alike >= n - 2;
}

type Viewerish = { id: string; name: string; role: "editor"; via: "session" };
const asViewer = (id: string): Viewerish => ({ id, name: "", role: "editor", via: "session" });

export class References {
  private db: Database;
  private files: Files;
  private styles: Styles;
  private ownerOf: (chat: ChatRow) => string;
  /** Set at startup: posts a line into the chat that shared the reference. */
  notify: ((chatId: string, text: string) => void) | null = null;

  constructor(db: Database, bus: Bus, files: Files, styles: Styles, ownerOf: (chat: ChatRow) => string) {
    this.db = db;
    this.files = files;
    this.styles = styles;
    this.ownerOf = ownerOf;
    // When a learning job ends, its sources get prints (so re-downloads match) and its chat hears back.
    bus.on((e) => {
      if (e.type !== "job") return;
      const d = e.data as { id: string; kind?: string; status: string; result?: { styleId?: string; animations?: number }; error?: string | null };
      if (d.kind !== "style.analyze" || !["done", "failed"].includes(d.status)) return;
      void this.finished(d).catch(() => {});
    });
  }

  enabled(memberId: string) {
    return this.db.setting(autoLearnKey(memberId)) !== "off";
  }

  /** A video's print, measured once and kept. */
  async print(hash: string, signal?: AbortSignal): Promise<Print | null> {
    const row = this.db.get<{ duration: number; frames: string }>("SELECT duration, frames FROM video_prints WHERE hash = ?", hash);
    if (row) return { duration: row.duration, frames: json<string[]>(row.frames, []) };
    let file;
    try {
      file = this.files.get(hash);
    } catch {
      return null;
    }
    if (file.kind !== "video") return null;
    const duration = (file.meta as { duration?: number }).duration ?? (await probe(file.path)).duration;
    if (!(duration > 0)) return null;
    const p = await videoPrint(file.path, duration, signal);
    if (p.frames.length < PRINT_FRAMES - 2) return null;
    this.db.run("INSERT OR REPLACE INTO video_prints (hash, duration, frames, created_at) VALUES (?, ?, ?, ?)", hash, p.duration, JSON.stringify(p.frames), Date.now());
    return p;
  }

  /** The style this person can use that was learned from this video: the same file first, then the same video. Approved ones win. */
  async known(memberId: string, hash: string, signal?: AbortSignal) {
    const order = "ORDER BY t.status = 'approved' DESC, t.updated_at DESC";
    const exact = this.db.all<{ style_id: string }>(`SELECT s.style_id FROM style_sources s JOIN styles t ON t.id = s.style_id WHERE s.hash = ? ${order}`, hash).find((r) => this.styles.canUse(memberId, r.style_id));
    if (exact) return { styleId: exact.style_id, match: "exact" as const };
    const mine = await this.print(hash, signal).catch(() => null);
    if (!mine) return null;
    const near = this.db.all<{ style_id: string; duration: number; frames: string }>(
      `SELECT s.style_id, p.duration, p.frames FROM style_sources s JOIN video_prints p ON p.hash = s.hash JOIN styles t ON t.id = s.style_id WHERE s.hash != ? AND abs(p.duration - ?) <= max(0.5, ? * 0.02) ${order}`,
      hash, mine.duration, mine.duration,
    );
    const hit = near.find((r) => this.styles.canUse(memberId, r.style_id) && samePrint(mine, { duration: r.duration, frames: json<string[]>(r.frames, []) }));
    return hit ? { styleId: hit.style_id, match: "similar" as const } : null;
  }

  /** A learning job already queued or running for this person and this video. */
  running(memberId: string, hash: string) {
    return this.db.get<{ id: string }>(
      "SELECT id FROM jobs WHERE kind = 'style.analyze' AND status IN ('queued', 'running') AND owner_id = ? AND (json_extract(payload, '$.hash') = ? OR EXISTS (SELECT 1 FROM json_each(json_extract(payload, '$.hashes')) WHERE value = ?))",
      memberId, hash, hash,
    )?.id ?? null;
  }

  /**
   * Makes sure each reference is in the library. Safe to call any number of times: a known video is
   * reused, and one already being learned is never learned twice. Never throws for one bad reference.
   */
  async ensure(chat: ChatRow, refs: { hash: string; tags?: string[] }[], signal?: AbortSignal): Promise<ReferenceState[]> {
    const owner = this.ownerOf(chat);
    const locale = json<{ locale?: string }>(chat.mission, {}).locale ?? "en-US";
    const out: ReferenceState[] = [];
    const seen = new Set<string>();
    for (const r of refs) {
      if (seen.has(r.hash)) continue;
      seen.add(r.hash);
      try {
        out.push(await this.one(chat, owner, locale, r.hash, (r.tags ?? []).filter((t) => REFERENCE_TAGS.includes(t)), signal));
      } catch (e) {
        if (signal?.aborted) throw e;
        out.push({ hash: r.hash, state: "skipped", reason: `It couldn't be checked against your library (${(e as Error).message}).` });
      }
    }
    return out;
  }

  private async one(chat: ChatRow, owner: string, locale: string, hash: string, tags: string[], signal?: AbortSignal): Promise<ReferenceState> {
    const file = this.files.get(hash);
    if (file.kind !== "video") return { hash, state: "skipped", reason: "It isn't a video, so there's no style to learn." };
    const duration = (file.meta as { duration?: number }).duration ?? (await probe(file.path)).duration;
    if (duration < MIN_REFERENCE_SECONDS) return { hash, state: "skipped", reason: `It's only ${duration.toFixed(1)} s long, which usually means a broken download, so it wasn't saved as a style.` };
    const known = await this.known(owner, hash, signal);
    if (known) {
      const style = this.styles.get(known.styleId);
      // A copy of a known video points at the same style from now on, so the next match is exact.
      if (known.match === "similar" && style.ownerId === owner) this.db.run("INSERT OR IGNORE INTO style_sources (style_id, hash) VALUES (?, ?)", known.styleId, hash);
      return { hash, state: "known", styleId: style.id, styleName: style.name, status: style.status, match: known.match };
    }
    if (!this.enabled(owner)) return { hash, state: "skipped", reason: "Learning new references is turned off in Settings." };
    const already = this.running(owner, hash);
    if (already) return { hash, state: "learning", jobId: already, started: false };
    const jobId = this.styles.learn(asViewer(owner), [hash], chat.account_id, locale, [tags], { chatId: chat.id });
    return { hash, state: "learning", jobId, started: true };
  }

  /** Prints for every learned source that doesn't have one yet, so older styles match re-downloads too. */
  async backfill(signal?: AbortSignal) {
    const missing = this.db.all<{ hash: string }>("SELECT DISTINCT s.hash FROM style_sources s LEFT JOIN video_prints p ON p.hash = s.hash WHERE p.hash IS NULL");
    for (const m of missing) {
      if (signal?.aborted) return;
      await this.print(m.hash, signal).catch(() => null);
    }
  }

  private async finished(d: { id: string; status: string; result?: { styleId?: string; animations?: number }; error?: string | null }) {
    const job = this.db.get<{ payload: string }>("SELECT payload FROM jobs WHERE id = ?", d.id);
    const payload = json<{ hash?: string; hashes?: string[]; origin?: { chatId?: string } }>(job?.payload ?? null, {});
    for (const h of payload.hashes ?? (payload.hash ? [payload.hash] : [])) await this.print(h).catch(() => null);
    const chatId = payload.origin?.chatId;
    if (!chatId || !this.notify) return;
    if (d.status === "done" && d.result?.styleId) {
      let name = "the new style";
      try {
        name = `“${this.styles.get(d.result.styleId).name}”`;
      } catch {
        return;
      }
      const n = d.result.animations ?? 0;
      this.notify(chatId, `Saved your reference as ${name} in Styles${n ? `, with ${n} animation${n === 1 ? "" : "s"} in the Motion library` : ""}. Approve it there to use it as is.`);
    } else if (d.status === "failed") {
      this.notify(chatId, `Couldn't save your reference as a style: ${d.error ?? "the learning job stopped"}.`);
    }
  }
}

/** How the editor reads each reference's state, next to the attachment it describes. */
export function describeReference(s: ReferenceState) {
  if (s.state === "known") return `already in the library as the style "${s.styleName}"${s.status === "approved" ? "" : " (a draft, not reviewed yet)"}${s.match === "similar" ? ", learned from another copy of this video" : ""}. Its caption preset and saved animations are ready: start from get_caption_preset and suggest_animations, and still measure the reference for this edit.`;
  if (s.state === "learning") return "new to the library. It's being saved as a style in the background for future videos. Measure and study it yourself for this edit; don't wait for that.";
  return `not saved to the library: ${s.reason}`;
}

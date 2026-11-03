import { randomUUID } from "node:crypto";
import { createWriteStream, rmSync, statSync } from "node:fs";
import { isIP } from "node:net";
import { join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as WebStream } from "node:stream/web";
import { DIRS, findBin } from "./config.ts";
import type { Files } from "./files.ts";
import { HttpError } from "./lib/http.ts";
import { probe } from "./lib/media.ts";
import { run } from "./lib/proc.ts";

/**
 * Social video links, fetched through Scrape Creators with the person's own API key.
 * Scrape Creators returns the post's data; the video file itself comes from the platform's
 * CDN, or from a permanent copy Scrape Creators makes when the CDN refuses.
 */
export const SCRAPE_API = "https://api.scrapecreators.com";
export const SCRAPE_MCP = "https://api.scrapecreators.com/mcp";
export const scrapeKeyFor = (memberId: string) => `scrapecreators:${memberId}`;

type Platform = { id: string; name: string; hosts: RegExp; path: RegExp; endpoint: string; permanent?: boolean };

/** What each platform's link looks like and which endpoint reads it. Order matters only for display. */
export const PLATFORMS: Platform[] = [
  { id: "tiktok", name: "TikTok", hosts: /(^|\.)tiktok\.com$/, path: /\/(video|photo|t)\/|^\/[A-Za-z0-9]+\/?$/, endpoint: "/v2/tiktok/video", permanent: true },
  { id: "instagram", name: "Instagram", hosts: /(^|\.)instagram\.com$/, path: /^\/(?:[^/]+\/)?(reel|reels|p|tv)\//, endpoint: "/v1/instagram/post", permanent: true },
  { id: "facebook", name: "Facebook", hosts: /(^|\.)(facebook\.com|fb\.watch|fb\.com)$/, path: /./, endpoint: "/v1/facebook/post" },
  { id: "twitter", name: "X", hosts: /(^|\.)(twitter\.com|x\.com)$/, path: /\/status\/\d+/, endpoint: "/v1/twitter/tweet" },
  { id: "threads", name: "Threads", hosts: /(^|\.)threads\.(net|com)$/, path: /\/post\//, endpoint: "/v1/threads/post" },
  { id: "reddit", name: "Reddit", hosts: /(^|\.)(reddit\.com|redd\.it)$/, path: /./, endpoint: "/v1/reddit/post" },
  { id: "snapchat", name: "Snapchat Spotlight", hosts: /(^|\.)snapchat\.com$/, path: /spotlight/, endpoint: "/v1/snapchat/spotlight" },
  { id: "pinterest", name: "Pinterest", hosts: /(^|\.)(pinterest\.[a-z.]+|pin\.it)$/, path: /./, endpoint: "/v1/pinterest/pin" },
  { id: "bluesky", name: "Bluesky", hosts: /(^|\.)bsky\.app$/, path: /\/post\//, endpoint: "/v1/bluesky/post" },
  { id: "truthsocial", name: "Truth Social", hosts: /(^|\.)truthsocial\.com$/, path: /\/posts?\//, endpoint: "/v1/truthsocial/post", permanent: true },
  { id: "twitch", name: "Twitch clips", hosts: /(^|\.)twitch\.tv$/, path: /clip/, endpoint: "/v1/twitch/clip" },
  { id: "kick", name: "Kick clips", hosts: /(^|\.)kick\.com$/, path: /\/clips?\//, endpoint: "/v1/kick/clip" },
  { id: "rumble", name: "Rumble", hosts: /(^|\.)rumble\.com$/, path: /./, endpoint: "/v1/rumble/video" },
];

/** Scrape Creators reads these, but returns details only, never the video file. */
const NO_VIDEO: { name: string; hosts: RegExp }[] = [
  { name: "YouTube", hosts: /(^|\.)(youtube\.com|youtu\.be|youtube-nocookie\.com)$/ },
  { name: "LinkedIn", hosts: /(^|\.)linkedin\.com$/ },
];

export const SUPPORTED_NAMES = PLATFORMS.map((p) => p.name);
const supportedLine = () => `Links that work: ${SUPPORTED_NAMES.join(", ")}.`;

/** Works out which platform a link belongs to, or says plainly why it can't be used. No credits are spent here. */
export function platformOf(raw: string): { platform: Platform; url: string } {
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    throw new HttpError(400, "That isn't a link. Paste the full address, starting with https://.");
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") throw new HttpError(400, "That isn't a web link.");
  const host = u.hostname.toLowerCase().replace(/^(www|m|mobile|vm|vt)\./, "");
  const none = NO_VIDEO.find((n) => n.hosts.test(host));
  if (none) throw new HttpError(422, `This link isn't supported. Scrape Creators gives the details of ${none.name} videos but not the video file itself, so download it and upload the file instead. ${supportedLine()}`);
  const platform = PLATFORMS.find((p) => p.hosts.test(host));
  if (!platform) throw new HttpError(422, `This link isn't supported. ${supportedLine()}`);
  // Share links (vm.tiktok.com, pin.it, redd.it, fb.watch) redirect, so their paths can't be checked here.
  const short = /^(vm|vt)\./.test(u.hostname) || /^(pin\.it|redd\.it|fb\.watch)$/.test(host);
  if (!short && !platform.path.test(u.pathname)) throw new HttpError(422, `This ${platform.name} link doesn't point to a single post or video. Open the video itself and copy its link.`);
  return { platform, url: u.toString() };
}

// ── Finding the video in a response ────────────────────────────

type Candidate = { url: string; rank: number; audio: boolean };

const isVideoish = (s: string) => /^https:\/\//.test(s) && !/\.(jpe?g|png|webp|gif|heic|avif)(\?|$)/i.test(s);
const looksLikeFile = (s: string) => /\.(mp4|m3u8|mov|webm)(\?|$)/i.test(s) || /video|\/o1\/v\/|mime_type=video|\/aweme\/v1\/play/i.test(s);

/**
 * Every likely video file in a Scrape Creators response, best first. Platform-specific spots come
 * first (no-watermark TikTok, HD Facebook, the highest-bitrate MP4 on X); then a careful walk
 * picks up video URLs under the usual names, so a platform that adds video later still works.
 */
export function videoCandidates(data: unknown, platform: string): string[] {
  const out: Candidate[] = [];
  const add = (url: unknown, rank: number, audio = true) => {
    if (typeof url === "string" && isVideoish(url)) out.push({ url, rank, audio });
  };
  const at = (o: unknown, path: string) => path.split(".").reduce<unknown>((v, k) => (v && typeof v === "object" ? (v as Record<string, unknown>)[k] : undefined), o);

  if (platform === "tiktok") {
    const v = at(data, "aweme_detail.video") as Record<string, unknown> | undefined;
    if (v) {
      for (const u of (at(v, "download_no_watermark_addr.url_list") as unknown[] | undefined) ?? []) add(u, 100);
      if (v.has_watermark === false) for (const u of (at(v, "play_addr.url_list") as unknown[] | undefined) ?? []) add(u, 95);
      // Bitrate copies are the clean stream; a watermarked download is the last resort.
      for (const b of (v.bit_rate as { bit_rate?: number; play_addr?: { url_list?: unknown[] } }[] | undefined) ?? []) for (const u of b.play_addr?.url_list ?? []) add(u, 80 + Math.min(9, (b.bit_rate ?? 0) / 1e6));
      for (const u of (at(v, "play_addr.url_list") as unknown[] | undefined) ?? []) add(u, 70);
      for (const u of (at(v, "download_addr.url_list") as unknown[] | undefined) ?? []) add(u, 40);
    }
  }

  // A careful walk over everything else. Ranks prefer HD and streams that carry sound.
  const seen = new Set<unknown>();
  const walk = (v: unknown, key: string, depth: number) => {
    if (!v || depth > 12 || seen.has(v)) return;
    if (typeof v === "string") {
      const k = key.toLowerCase();
      if (/^(video_?url|videourl|video_hd_url|hd_?url|playable_url_quality_hd|browser_native_hd_url)$/.test(k)) add(v, 60);
      else if (/^(hls_?url|hls)$/.test(k)) add(v, 58);
      else if (/^(sd_?url|playable_url|browser_native_sd_url|playback_?url|content_?url|download_?url|source_?url|sourceurl|mp4_?url)$/.test(k) && looksLikeFile(v)) add(v, 50);
      else if (/^(fallback_?url)$/.test(k)) add(v, 20, false); // Reddit's fallback has no sound.
      else if (k === "url" && looksLikeFile(v)) add(v, 30);
      return;
    }
    if (typeof v !== "object") return;
    seen.add(v);
    if (Array.isArray(v)) {
      for (const x of v) walk(x, key, depth + 1);
      return;
    }
    const o = v as Record<string, unknown>;
    // X lists one MP4 per bitrate. Take the biggest.
    if (Array.isArray(o.variants)) {
      for (const x of o.variants as { content_type?: string; bitrate?: number; url?: string }[]) if (x?.content_type === "video/mp4") add(x.url, 62 + Math.min(9, (x.bitrate ?? 0) / 1e6));
    }
    if (typeof o.url === "string" && /video/i.test(String(o.content_type ?? o.mimeType ?? o.mime_type ?? o.type ?? ""))) add(o.url, 55);
    // Instagram and Threads list video versions largest first.
    if (key === "video_versions" || key === "videoQualities") return walk(v, "", depth + 1);
    for (const [k, x] of Object.entries(o)) walk(x, k, depth + 1);
  };
  walk(data, "", 0);

  const best = new Map<string, Candidate>();
  for (const c of out) if (!best.has(c.url) || best.get(c.url)!.rank < c.rank) best.set(c.url, c);
  return [...best.values()].sort((a, b) => Number(b.audio) - Number(a.audio) || b.rank - a.rank).map((c) => c.url);
}

/** Only public https files. Private and local addresses are never fetched, whatever a response says. */
export function safeMediaUrl(raw: string) {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return false;
  }
  if (u.protocol !== "https:") return false;
  const host = u.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (host === "localhost" || host.endsWith(".local") || host.endsWith(".internal") || !host.includes(".") && !isIP(host)) return false;
  if (isIP(host)) {
    if (/^(10\.|127\.|0\.|169\.254\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.)/.test(host)) return false;
    if (host === "::1" || /^(fc|fd|fe80)/.test(host)) return false;
  }
  return true;
}

// ── Talking to Scrape Creators ─────────────────────────────────

const MAX_BYTES = 4 * 1024 ** 3;
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 15_0) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15";

async function call(key: string, path: string, params: Record<string, string>, fetcher: typeof fetch, signal?: AbortSignal) {
  const res = await fetcher(`${SCRAPE_API}${path}?${new URLSearchParams(params)}`, { headers: { "x-api-key": key }, signal: signal ?? AbortSignal.timeout(90_000) });
  const body = (await res.json().catch(() => null)) as Record<string, unknown> | null;
  if (res.status === 401 || res.status === 403) throw new HttpError(400, "Scrape Creators didn't accept your API key. Check it in Settings → My account.");
  if (res.status === 402) throw new HttpError(402, "Your Scrape Creators account is out of credits.");
  if (res.status === 404) throw new HttpError(404, "Scrape Creators couldn't find that post. It may be private, deleted or blocked in its region.");
  if (res.status === 429) throw new HttpError(429, "Scrape Creators is rate limiting this key. Try again in a minute.");
  if (!res.ok || !body) throw new HttpError(502, `Scrape Creators couldn't read that link${body?.message ? `: ${String(body.message).slice(0, 200)}` : "."}`);
  return body;
}

/** Checks a key and returns its credit balance. Costs nothing. */
export async function creditBalance(key: string, fetcher: typeof fetch = fetch) {
  const r = await call(key, "/v1/account/credit_balance", {}, fetcher);
  return Number(r.creditCount ?? r.credits ?? 0);
}

async function download(url: string, out: string, fetcher: typeof fetch, signal?: AbortSignal) {
  if (!safeMediaUrl(url)) throw new Error("not a public https file");
  if (/\.m3u8(\?|$)/i.test(url)) {
    // A stream is stitched into one file by ffmpeg, which also joins its sound.
    await run(findBin("ffmpeg")!, ["-y", "-loglevel", "error", "-user_agent", UA, "-protocol_whitelist", "https,tls,tcp,crypto", "-i", url, "-c", "copy", "-bsf:a", "aac_adtstoasc", "-movflags", "+faststart", out], { signal });
    return;
  }
  // Redirects are followed by hand, so every hop is checked before it's fetched.
  let res: Response | null = null;
  let next = url;
  for (let hop = 0; hop < 6; hop++) {
    if (!safeMediaUrl(next)) throw new Error("the video host redirected somewhere private");
    res = await fetcher(next, { headers: { "User-Agent": UA, Accept: "video/*,*/*;q=0.8" }, redirect: "manual", signal: signal ?? AbortSignal.timeout(600_000) });
    const to = res.status >= 300 && res.status < 400 ? res.headers.get("location") : null;
    if (!to) break;
    next = new URL(to, next).toString();
    res = null;
  }
  if (!res) throw new Error("the video host redirected too many times");
  if (!res.ok || !res.body) throw new Error(`the video host answered ${res.status}`);
  const type = res.headers.get("content-type") ?? "";
  if (/text\/html|application\/json/i.test(type)) throw new Error("the video host sent a page instead of a video");
  if (Number(res.headers.get("content-length") ?? 0) > MAX_BYTES) throw new Error("the video is over 4 GB");
  let size = 0;
  const stream = Readable.fromWeb(res.body as unknown as WebStream<Uint8Array>);
  stream.on("data", (c: Buffer) => {
    size += c.length;
    if (size > MAX_BYTES) stream.destroy(new Error("the video is over 4 GB"));
  });
  await pipeline(stream, createWriteStream(out));
}

/**
 * Turns a social link into a video in the file store. The link is checked first, so an unsupported
 * one costs nothing. CDN copies are tried first (about 1 credit); if every one is refused and the
 * platform offers it, a permanent copy is requested once (about 10 credits).
 */
export async function fetchSocialVideo(files: Files, key: string, link: string, opts: { fetcher?: typeof fetch; signal?: AbortSignal } = {}) {
  const fetcher = opts.fetcher ?? fetch;
  const { platform, url } = platformOf(link);
  let credits = 0;
  const attempt = async (data: Record<string, unknown>) => {
    credits += Number(data.credits_charged ?? 0);
    const tried: string[] = [];
    for (const candidate of videoCandidates(data, platform.id).slice(0, 4)) {
      const out = join(DIRS.tmp, `${randomUUID()}.mp4`);
      try {
        await download(candidate, out, fetcher, opts.signal);
        const info = await probe(out);
        if (!info.hasVideo || statSync(out).size < 1024) throw new Error("the file has no video");
        return out;
      } catch (e) {
        rmSync(out, { force: true });
        if (opts.signal?.aborted) throw e;
        tried.push((e as Error).message);
      }
    }
    return tried.length ? new Error(tried[0]) : null;
  };

  let result = await attempt(await call(key, platform.endpoint, { url }, fetcher, opts.signal));
  if (result instanceof Error && platform.permanent) result = await attempt(await call(key, platform.endpoint, { url, download_media: "true" }, fetcher, opts.signal));
  if (result === null) throw new HttpError(422, `This ${platform.name} post has no video Scrape Creators can download. It may be a photo or text post.`);
  if (result instanceof Error) throw new HttpError(502, `Scrape Creators found the video, but it couldn't be downloaded (${result.message}). Try again, or download it yourself and upload the file.`);
  try {
    const name = `${platform.id}-${new URL(url).pathname.split("/").filter(Boolean).pop()?.slice(0, 40) ?? "video"}.mp4`.replace(/[^\w.-]+/g, "-");
    const stored = await files.fromPath(result, name);
    return { file: stored, platform: platform.name, credits };
  } finally {
    rmSync(result, { force: true });
  }
}

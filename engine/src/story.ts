import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { findBin } from "./config.ts";
import { probe } from "./lib/media.ts";
import { run } from "./lib/proc.ts";
import type { Transcript } from "./tools.ts";

/**
 * Many raw clips into one story. Every clip is transcribed with word timing, the editor picks the
 * takes (following the user's script when there is one), and the picks are joined into one video
 * that becomes the main footage. Nothing is cut from the clips themselves.
 */

export type Line = { from: number; to: number; text: string };

/** Turns timed words into short readable lines: a new line at a sentence end, a pause, or 16 words. */
export function linesFrom(words: Transcript["words"]): Line[] {
  const out: Line[] = [];
  let cur: Transcript["words"] = [];
  const flush = () => {
    if (!cur.length) return;
    out.push({ from: Number(cur[0].start.toFixed(2)), to: Number(cur[cur.length - 1].end.toFixed(2)), text: cur.map((w) => w.text).join(" ").replace(/\s+([,.!?;:])/g, "$1") });
    cur = [];
  };
  for (const w of words) {
    if (cur.length && w.start - cur[cur.length - 1].end > 0.8) flush();
    cur.push(w);
    if (/[.!?]$/.test(w.text) || cur.length >= 16) flush();
  }
  flush();
  return out;
}

export type Pick = { path: string; from: number; to: number };

/** Checks every pick against its clip before anything is rendered, so a guessed time fails with a clear reason. */
export function checkPicks(picks: Pick[], durations: Map<string, number>) {
  if (!picks.length) throw new Error("Give at least one take to join.");
  if (picks.length > 200) throw new Error("That's over 200 takes. Join fewer, or join in parts.");
  picks.forEach((p, i) => {
    const d = durations.get(p.path);
    if (d === undefined) throw new Error(`Take ${i + 1}: ${p.path} isn't one of the clips.`);
    if (!(p.to - p.from >= 0.2)) throw new Error(`Take ${i + 1} is shorter than 0.2 seconds. Check from and to.`);
    if (p.from < 0 || p.to > d + 0.05) throw new Error(`Take ${i + 1} runs outside its clip, which is ${d.toFixed(2)}s long.`);
  });
}

/** A bitrate that keeps camera footage clean: roughly 0.12 bits per pixel per frame. */
const bitrate = (w: number, h: number, fps: number) => `${Math.max(6, Math.round((w * h * fps * 0.12) / 1e6))}M`;

/**
 * Joins the picked takes in order. Each take is cut to the first clip's size and frame rate, with
 * sound at 48 kHz, so clips from different cameras join cleanly. Returns where each take landed.
 */
export async function assemble(picks: Pick[], out: string, dir: string, signal?: AbortSignal) {
  const ffmpeg = findBin("ffmpeg")!;
  const infos = new Map<string, Awaited<ReturnType<typeof probe>>>();
  for (const p of picks) if (!infos.has(p.path)) infos.set(p.path, await probe(p.path));
  checkPicks(picks, new Map([...infos].map(([k, v]) => [k, v.duration])));
  const first = infos.get(picks[0].path)!;
  const w = first.width % 2 ? first.width + 1 : first.width;
  const h = first.height % 2 ? first.height + 1 : first.height;
  const fps = Math.round(first.fps * 1000) / 1000 || 30;
  const work = join(dir, `story-${randomUUID().slice(0, 8)}`);
  mkdirSync(work, { recursive: true });
  try {
    const parts: string[] = [];
    for (const [i, p] of picks.entries()) {
      if (signal?.aborted) throw new Error("Cancelled");
      const part = join(work, `${String(i).padStart(3, "0")}.mp4`);
      const info = infos.get(p.path)!;
      const seconds = (p.to - p.from).toFixed(3);
      // A clip with no sound gets silence, so every part has the same streams and the join stays in sync.
      const silence = info.hasAudio ? [] : ["-f", "lavfi", "-t", seconds, "-i", "anullsrc=r=48000:cl=stereo"];
      await run(ffmpeg, [
        "-y", "-loglevel", "error", "-ss", p.from.toFixed(3), "-t", seconds, "-i", p.path, ...silence,
        "-map", "0:v:0", "-map", info.hasAudio ? "0:a:0" : "1:a:0",
        "-vf", `scale=${w}:${h}:force_original_aspect_ratio=decrease,pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2,fps=${fps},format=yuv420p,setsar=1`,
        "-c:v", "h264_videotoolbox", "-b:v", bitrate(w, h, fps), "-c:a", "aac", "-b:a", "192k", "-ar", "48000", "-ac", "2", "-shortest", part,
      ], { signal });
      parts.push(part);
    }
    const list = join(work, "list.txt");
    writeFileSync(list, parts.map((p) => `file '${p}'`).join("\n"));
    await run(ffmpeg, ["-y", "-loglevel", "error", "-f", "concat", "-safe", "0", "-i", list, "-c", "copy", "-movflags", "+faststart", out], { signal });
    let at = 0;
    const placed = picks.map((p) => {
      const start = at;
      at += p.to - p.from;
      return { ...p, start: Number(start.toFixed(2)) };
    });
    return { path: out, seconds: Number((await probe(out)).duration.toFixed(2)), takes: placed };
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

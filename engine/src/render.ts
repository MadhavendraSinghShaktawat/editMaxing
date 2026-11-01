import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { findBin, nativeBin } from "./config.ts";
import type { EditDoc, Segment } from "./editdoc.ts";
import { captionChunks, segments, totalDuration, toOutput, wordSpan } from "./editdoc.ts";
import { loudness, probe } from "./lib/media.ts";
import { run } from "./lib/proc.ts";

const num = (v: number) => v.toFixed(3);

export type RenderPlan = { args: string[]; duration: number };

/** Compiles an Edit Document into one ffmpeg graph. Pure, so it can be tested without rendering. */
export function compile(doc: EditDoc, options: { output: string; captionsFile?: string | null; preview?: boolean }): RenderPlan {
  const segs = segments(doc);
  const duration = totalDuration(segs);
  const scale = options.preview ? Math.min(1, 540 / doc.output.height) : 1;
  const W = Math.round((doc.output.width * scale) / 2) * 2;
  const H = Math.round((doc.output.height * scale) / 2) * 2;
  const fps = doc.output.fps;
  const inputs: string[] = ["-i", doc.source.path];
  const filters: string[] = [];
  let index = 1;
  const input = (path: string, loop = false) => {
    if (loop) inputs.push("-stream_loop", "-1");
    inputs.push("-i", path);
    return index++;
  };

  segs.forEach((s, i) => {
    filters.push(`[0:v]trim=${num(s.start)}:${num(s.end)},setpts=PTS-STARTPTS[v${i}]`);
    const d = s.end - s.start;
    const fade = Math.min(0.008, d / 3);
    filters.push(`[0:a]atrim=${num(s.start)}:${num(s.end)},asetpts=PTS-STARTPTS,afade=t=in:d=${num(fade)},afade=t=out:st=${num(d - fade)}:d=${num(fade)}[a${i}]`);
  });
  filters.push(`${segs.map((_, i) => `[v${i}]`).join("")}concat=n=${segs.length}:v=1:a=0,fps=${fps},scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},setsar=1,format=yuv420p[base]`);
  filters.push(`${segs.map((_, i) => `[a${i}]`).join("")}concat=n=${segs.length}:v=0:a=1[voice]`);

  let video = "base";
  let n = 0;
  for (const b of doc.broll) {
    const { start, end } = wordSpan(doc, segs, b.from, b.to);
    if (end - start < 0.05) continue;
    const i = input(b.path);
    const label = `b${n}`;
    filters.push(`[${i}:v]trim=${num(b.in)}:${num(b.in + (end - start))},setpts=PTS-STARTPTS+${num(start)}/TB,fps=${fps},scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},setsar=1[${label}]`);
    filters.push(`[${video}][${label}]overlay=enable='between(t,${num(start)},${num(end)})':eof_action=pass[o${n}]`);
    video = `o${n++}`;
  }
  for (const g of doc.graphics) {
    const { start, end } = wordSpan(doc, segs, g.from, g.to);
    if (end - start < 0.05) continue;
    const i = input(g.path);
    const label = `g${n}`;
    filters.push(`[${i}:v]setpts=PTS-STARTPTS+${num(start)}/TB,fps=${fps},scale=${W}:${H}:force_original_aspect_ratio=decrease,format=yuva420p[${label}]`);
    filters.push(`[${video}][${label}]overlay=(W-w)/2:(H-h)/2:enable='between(t,${num(start)},${num(end)})':eof_action=pass[o${n}]`);
    video = `o${n++}`;
  }
  if (options.captionsFile) {
    const i = input(options.captionsFile);
    filters.push(`[${i}:v]scale=${W}:${H},format=yuva420p[cap]`);
    filters.push(`[${video}][cap]overlay=eof_action=pass[o${n}]`);
    video = `o${n++}`;
  }
  filters.push(`[${video}]format=yuv420p[vout]`);

  const mix: string[] = [];
  const hasMusic = doc.music.length > 0;
  if (hasMusic) filters.push(`[voice]asplit=2[voiceMix][voiceKey]`);
  mix.push(hasMusic ? "[voiceMix]" : "[voice]");
  doc.sfx.forEach((s, k) => {
    const t = Math.max(0, toOutput(segs, doc.words[s.word].t0) + s.offset);
    const i = input(s.path);
    filters.push(`[${i}:a]aresample=48000,volume=${s.gainDb}dB,adelay=${Math.round(t * 1000)}:all=1[sfx${k}]`);
    mix.push(`[sfx${k}]`);
  });
  doc.music.forEach((m, k) => {
    const i = input(m.path, true);
    filters.push(`[${i}:a]atrim=0:${num(duration)},aresample=48000,volume=${m.gainDb}dB,afade=t=out:st=${num(Math.max(0, duration - 1.5))}:d=1.5[music${k}]`);
    if (m.duck && k === 0) {
      filters.push(`[music${k}][voiceKey]sidechaincompress=threshold=0.03:ratio=8:attack=20:release=420[duck${k}]`);
      mix.push(`[duck${k}]`);
    } else {
      mix.push(`[music${k}]`);
      if (k === 0) filters.push(`[voiceKey]anullsink`);
    }
  });
  filters.push(mix.length > 1 ? `${mix.join("")}amix=inputs=${mix.length}:normalize=0:duration=first,alimiter=limit=0.95[amixed]` : `${mix[0]}anull[amixed]`);
  filters.push(options.preview ? `[amixed]anull[aout]` : `[amixed]loudnorm=I=-14:TP=-1.5:LRA=11,aresample=48000[aout]`);

  const encoder = options.preview ? ["-c:v", "h264_videotoolbox", "-b:v", "2500k"] : ["-c:v", "h264_videotoolbox", "-b:v", `${Math.round((W * H * fps * 0.12) / 1000)}k`, "-profile:v", "high"];
  return {
    duration,
    args: ["-y", "-loglevel", "error", "-progress", "pipe:1", "-nostats", ...inputs, "-filter_complex", filters.join(";"), "-map", "[vout]", "-map", "[aout]", ...encoder, "-c:a", "aac", "-b:a", "256k", "-t", num(duration), "-movflags", "+faststart", options.output],
  };
}

export async function renderCaptions(doc: EditDoc, segs: Segment[], outDir: string, signal?: AbortSignal) {
  if (!doc.captions.enabled) return null;
  const bin = nativeBin();
  if (!bin) throw new Error("The native tools are not built.");
  const spec = join(outDir, "captions.json");
  const output = join(outDir, "captions.mov");
  const c = doc.captions;
  writeFileSync(spec, JSON.stringify({ width: doc.output.width, height: doc.output.height, fps: doc.output.fps, duration: totalDuration(segs), chunks: captionChunks(doc, segs), style: { font: c.font, size: c.size ?? undefined, color: c.color, highlight: c.highlight, uppercase: c.uppercase, position: c.position, strokeWidth: 8 } }));
  await run(bin, ["captions", "--spec", spec, "--output", output], { signal });
  return output;
}

export async function render(doc: EditDoc, output: string, workDir: string, options: { preview?: boolean; signal?: AbortSignal; onProgress?: (v: number) => void }) {
  const ffmpeg = findBin("ffmpeg");
  if (!ffmpeg) throw new Error("ffmpeg is not installed.");
  const segs = segments(doc);
  const captionsFile = await renderCaptions(doc, segs, workDir, options.signal);
  const plan = compile(doc, { output, captionsFile, preview: options.preview });
  await run(ffmpeg, plan.args, {
    signal: options.signal,
    onLine: (line) => {
      const m = line.match(/^out_time_us=(\d+)/);
      if (m && plan.duration > 0) options.onProgress?.(Math.min(0.99, Number(m[1]) / 1e6 / plan.duration));
    },
  });
  return { output, duration: plan.duration };
}

/** Checks a finished file against the Edit Document. Each failure says what's wrong. */
export async function qualityCheck(path: string, doc: EditDoc) {
  const p = await probe(path);
  const l = await loudness(path);
  const expected = totalDuration(segments(doc));
  const checks = [
    { name: "Resolution", ok: p.width === doc.output.width && p.height === doc.output.height, detail: `${p.width}x${p.height}, expected ${doc.output.width}x${doc.output.height}` },
    { name: "Frame rate", ok: Math.abs(p.fps - doc.output.fps) < 0.5, detail: `${p.fps.toFixed(2)} fps, expected ${doc.output.fps}` },
    { name: "Duration", ok: Math.abs(p.duration - expected) < 0.25, detail: `${p.duration.toFixed(2)} s, expected ${expected.toFixed(2)} s` },
    { name: "Loudness", ok: l.lufs !== null && l.lufs > -16.5 && l.lufs < -11.5, detail: `${l.lufs} LUFS, target -14` },
    { name: "True peak", ok: l.truePeak !== null && l.truePeak <= -0.5, detail: `${l.truePeak} dBFS, limit -1` },
    { name: "Audio", ok: p.hasAudio, detail: p.hasAudio ? "present" : "missing" },
  ];
  return { pass: checks.every((c) => c.ok), checks, loudness: l };
}

const srtTime = (t: number) => {
  const ms = Math.round(t * 1000);
  const p = (v: number, n = 2) => String(v).padStart(n, "0");
  return `${p(Math.floor(ms / 3600000))}:${p(Math.floor(ms / 60000) % 60)}:${p(Math.floor(ms / 1000) % 60)},${p(ms % 1000, 3)}`;
};

export function toSrt(doc: EditDoc) {
  const segs = segments(doc);
  return captionChunks(doc, segs).map((c, i) => `${i + 1}\n${srtTime(c.start)} --> ${srtTime(c.end)}\n${c.words.map((w) => w.text).join(" ")}\n`).join("\n");
}

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** FCPXML 1.10 with the cuts on the spine and B-roll connected above it, ready for Resolve. */
export function toFcpxml(doc: EditDoc, title: string) {
  const segs = segments(doc);
  const fps = doc.output.fps;
  const t = (v: number) => `${Math.round(v * fps)}/${fps}s`;
  const resources: string[] = [`<format id="r1" name="FFVideoFormat${doc.output.height}p${fps}" frameDuration="1/${fps}s" width="${doc.output.width}" height="${doc.output.height}"/>`];
  const asset = (id: string, path: string, name: string, duration: number) => `<asset id="${id}" name="${esc(name)}" start="0s" duration="${t(duration)}" hasVideo="1" hasAudio="1" format="r1"><media-rep kind="original-media" src="file://${encodeURI(path)}"/></asset>`;
  resources.push(asset("a0", doc.source.path, doc.source.name, doc.source.duration));
  const clips = segs.map((s) => {
    const connected = doc.broll
      .map((b, i) => ({ b, i, span: wordSpan(doc, segs, b.from, b.to) }))
      .filter(({ span }) => span.start >= s.outStart && span.start < s.outStart + (s.end - s.start))
      .map(({ b, i, span }) => {
        const id = `b${i}`;
        if (!resources.some((r) => r.includes(`id="${id}"`))) resources.push(asset(id, b.path, b.label ?? `B-roll ${i + 1}`, span.end - span.start + b.in));
        return `<asset-clip ref="${id}" lane="1" offset="${t(s.start + (span.start - s.outStart))}" start="${t(b.in)}" duration="${t(span.end - span.start)}" name="${esc(b.label ?? "B-roll")}"/>`;
      })
      .join("");
    return `<asset-clip ref="a0" offset="${t(s.outStart)}" start="${t(s.start)}" duration="${t(s.end - s.start)}" name="${esc(doc.source.name)}">${connected}</asset-clip>`;
  });
  return `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE fcpxml>\n<fcpxml version="1.10"><resources>${resources.join("")}</resources><library><event name="Shifu Dojo"><project name="${esc(title)}"><sequence format="r1" duration="${t(totalDuration(segs))}" tcStart="0s" tcFormat="NDF" audioLayout="stereo" audioRate="48k"><spine>${clips.join("")}</spine></sequence></project></event></library></fcpxml>\n`;
}

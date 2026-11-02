import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { findBin, nativeBin } from "./config.ts";
import type { CameraKind, Ease, EditDoc, Entrance, Overlay, Segment, Transition, TransitionKind } from "./editdoc.ts";
import { captionChunks, isRemoved, segments, totalDuration, toOutput, withLayers, wordSpan } from "./editdoc.ts";
import { loudness, probe } from "./lib/media.ts";
import { run } from "./lib/proc.ts";

const num = (v: number) => v.toFixed(3);

export type RenderPlan = { args: string[]; duration: number; dropped: number };

const XFADE: Record<TransitionKind, string> = {
  fade: "fade", dissolve: "dissolve", dip_black: "fadeblack", dip_white: "fadewhite", slide_left: "slideleft", slide_right: "slideright", slide_up: "slideup", slide_down: "slidedown",
  smooth_left: "smoothleft", smooth_right: "smoothright", zoom_in: "zoomin", blur: "hblur", circle: "circleopen", whip_left: "slideleft", whip_right: "slideright",
};

/** Eases 0 to 1 as an ffmpeg expression. Colons and commas are escaped so it can sit inside a filter. */
function eased(p: string, ease: Ease) {
  if (ease === "linear") return p;
  if (ease === "snap") return `(1-pow(1-(${p})\\,4))`;
  return `((${p})*(${p})*(3-2*(${p})))`;
}

const clamp = (e: string) => `max(0\\,min(1\\,${e}))`;

/**
 * A camera move as a warp of the picture. `perspective` samples between pixels, so a slow push glides
 * instead of stepping from pixel to pixel the way crop and zoompan do.
 */
function camera(kind: CameraKind, amount: number, ease: Ease, focus: { x: number; y: number }, start: number, end: number, fps: number, frameBase = "(in-1)") {
  const now = `(${frameBase}/${fps})`;
  const span = Math.max(0.01, end - start);
  const q = eased(clamp(`(${now}-${num(start)})/${num(span)}`), ease);
  const punch = eased(clamp(`(${now}-${num(start)})/${num(Math.min(0.14, span))}`), "snap");
  // A move that ends with no cut eases home, so the picture never jumps back.
  const release = `(1-${eased(clamp(`(${now}-${num(end)})/0.35`), "smooth")})`;
  let zoom = "1";
  let cx = String(focus.x);
  let cy = String(focus.y);
  const room = Math.max(0.04, amount);
  switch (kind) {
    case "push_in":
      zoom = `(1+${num(amount)}*${q}*${release})`;
      break;
    case "pull_out":
      zoom = `(1+${num(amount)}*(1-${q}))`;
      break;
    case "punch_in":
      zoom = `(1+${num(amount)}*${punch}*${release})`;
      break;
    case "pan_left":
    case "pan_right": {
      zoom = `(1+${num(room)})`;
      const d = (room / (1 + room)) * 0.5;
      cx = kind === "pan_right" ? `(0.5-${num(d)}+${num(d * 2)}*${q})` : `(0.5+${num(d)}-${num(d * 2)}*${q})`;
      cy = "0.5";
      break;
    }
    case "pan_up":
    case "pan_down": {
      zoom = `(1+${num(room)})`;
      const d = (room / (1 + room)) * 0.5;
      cy = kind === "pan_down" ? `(0.5-${num(d)}+${num(d * 2)}*${q})` : `(0.5+${num(d)}-${num(d * 2)}*${q})`;
      cx = "0.5";
      break;
    }
    case "shake": {
      zoom = `(1+${num(amount * 2.2)})`;
      const fade = `sin(PI*${clamp(`(${now}-${num(start)})/${num(span)}`)})`;
      cx = `(0.5+${num(amount)}*${fade}*sin(${now}*37)*cos(${now}*11))`;
      cy = `(0.5+${num(amount)}*${fade}*sin(${now}*29+1))`;
      break;
    }
  }
  const half = `(0.5/${zoom})`;
  const left = `(W*(min(max(${cx}\\,${half})\\,1-${half})-${half}))`;
  const right = `(W*(min(max(${cx}\\,${half})\\,1-${half})+${half}))`;
  const top = `(H*(min(max(${cy}\\,${half})\\,1-${half})-${half}))`;
  const bottom = `(H*(min(max(${cy}\\,${half})\\,1-${half})+${half}))`;
  return `perspective=x0='${left}':y0='${top}':x1='${right}':y1='${top}':x2='${left}':y2='${bottom}':x3='${right}':y3='${bottom}':interpolation=cubic:eval=frame`;
}

/** Where an overlay sits at time t, including its entrance and exit. */
function placement(start: number, end: number, enter: Entrance | undefined, exit: Entrance | undefined, x: string, y: string) {
  const shift = (e: Entrance | undefined, progress: string, axis: "x" | "y") => {
    if (!e) return "";
    const away = `(1-${eased(clamp(progress), "snap")})`;
    if (axis === "x" && e.kind === "slide_left") return `+W*${away}`;
    if (axis === "x" && e.kind === "slide_right") return `-W*${away}`;
    if (axis === "y" && e.kind === "slide_up") return `+H*${away}`;
    if (axis === "y" && e.kind === "slide_down") return `-H*${away}`;
    return "";
  };
  const inTime = enter ? `(t-${num(start)})/${num(Math.max(0.01, enter.seconds))}` : "1";
  const outTime = exit ? `(${num(end)}-t)/${num(Math.max(0.01, exit.seconds))}` : "1";
  // Leaving reverses the way a clip would go if it kept travelling: out through the far side.
  const reversed = exit ? { ...exit, kind: ({ slide_left: "slide_right", slide_right: "slide_left", slide_up: "slide_down", slide_down: "slide_up" } as Record<string, Entrance["kind"]>)[exit.kind] ?? exit.kind } : undefined;
  return { x: `${x}${shift(enter, inTime, "x")}${shift(reversed, outTime, "x")}`, y: `${y}${shift(enter, inTime, "y")}${shift(reversed, outTime, "y")}` };
}

function fades(start: number, end: number, enter?: Entrance, exit?: Entrance) {
  const parts: string[] = [];
  const wanted = (e?: Entrance) => e && e.kind !== "none";
  if (wanted(enter)) parts.push(`fade=t=in:st=${num(start)}:d=${num(enter!.seconds)}:alpha=1`);
  if (wanted(exit)) parts.push(`fade=t=out:st=${num(end - exit!.seconds)}:d=${num(exit!.seconds)}:alpha=1`);
  return parts.length ? `,format=yuva420p,${parts.join(",")}` : "";
}

/** Compiles an Edit Document into one ffmpeg graph. Pure, so it can be tested without rendering. */
export function compile(raw: EditDoc, options: { output: string; captionsFile?: string | null; preview?: boolean }): RenderPlan {
  const doc = withLayers(raw);
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
  const fit = `scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},setsar=1`;

  // A transition needs frames from both sides at once. They come from just past each end of the cut,
  // and half a transition on each side keeps the total length, so word anchors never move.
  const joins = new Map<number, Transition>();
  let dropped = 0;
  for (const t of doc.transitions) {
    if (isRemoved(doc, t.word)) { dropped++; continue; }
    const at = toOutput(segs, doc.words[t.word].t0);
    const seg = segs.findIndex((s, i) => i > 0 && Math.abs(s.outStart - at) < 0.15);
    if (seg < 0) { dropped++; continue; }
    const room = Math.min(segs[seg - 1].end - segs[seg - 1].start, segs[seg].end - segs[seg].start);
    joins.set(seg, { ...t, seconds: Math.min(t.seconds, room) });
  }

  segs.forEach((s, i) => {
    const lead = (joins.get(i)?.seconds ?? 0) / 2;
    const tail = (joins.get(i + 1)?.seconds ?? 0) / 2;
    const from = Math.max(0, s.start - lead);
    const to = Math.min(doc.source.duration, s.end + tail);
    filters.push(`[0:v]trim=${num(from)}:${num(to)},setpts=PTS-STARTPTS[v${i}]`);
    const d = s.end - s.start;
    const fade = Math.min(0.008, d / 3);
    filters.push(`[0:a]atrim=${num(s.start)}:${num(s.end)},asetpts=PTS-STARTPTS,afade=t=in:d=${num(fade)},afade=t=out:st=${num(d - fade)}:d=${num(fade)}[a${i}]`);
  });

  const groups: number[][] = [[]];
  segs.forEach((_, i) => {
    if (joins.has(i)) groups.push([]);
    groups[groups.length - 1].push(i);
  });
  const length = (g: number[]) => g.reduce((a, i) => {
    const s = segs[i];
    const lead = Math.min(s.start, (joins.get(i)?.seconds ?? 0) / 2);
    const tail = Math.min(doc.source.duration - s.end, (joins.get(i + 1)?.seconds ?? 0) / 2);
    return a + s.end - s.start + lead + tail;
  }, 0);
  groups.forEach((g, k) => filters.push(`${g.map((i) => `[v${i}]`).join("")}concat=n=${g.length}:v=1:a=0,fps=${fps},${fit},format=yuv420p,settb=AVTB[g${k}]`));
  let video = "g0";
  let made = length(groups[0]);
  const blurs: string[] = [];
  for (let k = 1; k < groups.length; k++) {
    const t = joins.get(groups[k][0])!;
    const offset = Math.max(0, made - t.seconds);
    filters.push(`[${video}][g${k}]xfade=transition=${XFADE[t.kind]}:duration=${num(t.seconds)}:offset=${num(offset)}[x${k}]`);
    video = `x${k}`;
    if (t.kind.startsWith("whip")) blurs.push(`between(t,${num(offset)},${num(offset + t.seconds)})`);
    made += length(groups[k]) - t.seconds;
  }
  filters.push(`${segs.map((_, i) => `[a${i}]`).join("")}concat=n=${segs.length}:v=0:a=1[voice]`);

  let n = 0;
  const step = (body: string) => {
    filters.push(`[${video}]${body}[o${n}]`);
    video = `o${n++}`;
  };
  // A whip's speed comes from smearing the picture along the slide. tmix can't do this: switched on
  // for part of a clip it outputs solid green.
  if (blurs.length) step(`avgblur=sizeX=${Math.round(W / 22)}:sizeY=1:enable='${blurs.join("+")}'`);
  step("null");

  for (const m of doc.moves) {
    const { start, end } = wordSpan(doc, segs, m.from, m.to);
    if (end - start < 0.05) continue;
    step(`${camera(m.kind, m.amount, m.ease, { x: m.x, y: m.y }, start, end, fps)}:enable='between(t,${num(start)},${num(end + 0.35)})'`);
  }

  const overlay = (label: string, o: Overlay, start: number, end: number) => {
    const box = o.box;
    const x = box ? `W*${num(box.x)}` : "0";
    const y = box ? `H*${num(box.y)}` : "0";
    const place = placement(start, end, o.enter, o.exit, x, y);
    step(`null[base${n}];[base${n}][${label}]overlay=x='${place.x}':y='${place.y}':eval=frame:enable='between(t,${num(start)},${num(end)})':eof_action=pass`);
  };

  for (const b of doc.broll) {
    const { start, end } = wordSpan(doc, segs, b.from, b.to);
    if (end - start < 0.05) continue;
    const i = input(b.path);
    const label = `b${n}`;
    const speed = b.speed ?? 1;
    const w = b.box ? Math.round((W * b.box.w) / 2) * 2 : W;
    const h = b.box ? Math.round((H * b.box.h) / 2) * 2 : H;
    const settle = b.enter?.kind === "pop" ? `,${camera("pull_out", 0.14, "snap", { x: 0.5, y: 0.5 }, 0, b.enter.seconds, fps)}` : "";
    const move = b.move ? `,${camera(b.move.kind, b.move.amount, "smooth", { x: 0.5, y: 0.5 }, 0, end - start, fps)}` : "";
    filters.push(`[${i}:v]trim=${num(b.in)}:${num(b.in + (end - start) * speed)},setpts=(PTS-STARTPTS)/${num(speed)},fps=${fps},scale=${w}:${h}:force_original_aspect_ratio=increase,crop=${w}:${h},setsar=1${settle}${move},setpts=PTS+${num(start)}/TB${fades(start, end, b.enter, b.exit)}[${label}]`);
    overlay(label, b, start, end);
  }
  for (const c of doc.cards) {
    const { start, end } = wordSpan(doc, segs, c.from, c.to);
    if (end - start < 0.03) continue;
    step(`drawbox=x=0:y=0:w=iw:h=ih:t=fill:color=${c.color}:enable='between(t,${num(start)},${num(end)})'`);
  }
  for (const g of doc.graphics) {
    const { start, end } = wordSpan(doc, segs, g.from, g.to);
    if (end - start < 0.05) continue;
    const i = input(g.path);
    const label = `g${n}`;
    const w = g.box ? Math.round((W * g.box.w) / 2) * 2 : W;
    const h = g.box ? Math.round((H * g.box.h) / 2) * 2 : H;
    filters.push(`[${i}:v]setpts=PTS-STARTPTS+${num(start)}/TB,fps=${fps},scale=${w}:${h}:force_original_aspect_ratio=decrease,format=yuva420p${fades(start, end, g.enter, g.exit)}[${label}]`);
    const place = placement(start, end, g.enter, g.exit, g.box ? `W*${num(g.box.x)}+(${w}-w)/2` : "(W-w)/2", g.box ? `H*${num(g.box.y)}+(${h}-h)/2` : "(H-h)/2");
    step(`null[base${n}];[base${n}][${label}]overlay=x='${place.x}':y='${place.y}':eval=frame:enable='between(t,${num(start)},${num(end)})':eof_action=pass`);
  }
  for (const e of doc.effects) {
    const { start, end } = wordSpan(doc, segs, e.from, e.to);
    const when = `enable='between(t,${num(start)},${num(end)})'`;
    if (e.kind === "blur") step(`gblur=sigma=${num(6 * e.amount)}:${when}`);
    if (e.kind === "rgb_split") step(`rgbashift=rh=${Math.round(-6 * e.amount)}:bh=${Math.round(6 * e.amount)}:${when}`);
    if (e.kind === "grain") step(`noise=alls=${Math.round(14 * e.amount)}:allf=t:${when}`);
    if (e.kind === "flash") {
      const span = Math.min(0.35, Math.max(0.08, end - start));
      filters.push(`color=c=white:s=${W}x${H}:r=${fps}:d=${num(span)},format=yuva420p,fade=t=out:st=0:d=${num(span)}:alpha=1,setpts=PTS+${num(start)}/TB[flash${n}]`);
      step(`null[base${n}];[base${n}][flash${n}]overlay=enable='between(t,${num(start)},${num(start + span)})':eof_action=pass`);
    }
  }
  if (options.captionsFile) {
    const i = input(options.captionsFile);
    filters.push(`[${i}:v]scale=${W}:${H},format=yuva420p[cap]`);
    step(`null[base${n}];[base${n}][cap]overlay=eof_action=pass`);
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
    dropped,
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
  writeFileSync(spec, JSON.stringify({ width: doc.output.width, height: doc.output.height, fps: doc.output.fps, duration: totalDuration(segs), chunks: captionChunks(doc, segs), style: { font: c.font, size: c.size ?? undefined, color: c.color, highlight: c.highlight, uppercase: c.uppercase, position: c.position, x: c.x, strokeColor: c.strokeColor, strokeWidth: c.strokeWidth ?? 8, glowColor: c.glowColor, glowRadius: c.glowRadius, boxColor: c.boxColor, boxOpacity: c.boxOpacity, animation: c.animation ?? "pop", animationSeconds: c.animationSeconds, reveal: c.reveal, lineHeight: c.lineHeight, maxWidth: c.maxWidth } }));
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

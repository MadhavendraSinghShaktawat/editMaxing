import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { DIRS, findBin, nativeBin } from "./config.ts";
import { json } from "./db.ts";
import type { Files, StoredFile, ToolCache } from "./files.ts";
import type { JobContext, Jobs } from "./jobs.ts";
import { extractAudio, frameAt, probe, silences } from "./lib/media.ts";
import { run } from "./lib/proc.ts";

const need = (bin: string | null, hint: string) => {
  if (!bin) throw new Error(hint);
  return bin;
};
const native = () => need(nativeBin(), "The native tools are not built. Run: swift build -c release --package-path mac");
const ffmpeg = () => need(findBin("ffmpeg"), "ffmpeg is not installed. Run: brew install ffmpeg");

type Done<T> = { event?: string; value?: number; message?: string; result?: T };

/** Runs a native tool, forwarding its progress lines. */
async function nativeTool<T>(args: string[], ctx?: JobContext) {
  let result: T | null = null;
  let failure: string | null = null;
  await run(native(), args, {
    signal: ctx?.signal,
    onLine: (line) => {
      const e = json<Done<T>>(line, {});
      if (e.event === "progress") ctx?.progress(e.value ?? 0, e.message);
      if (e.event === "done") result = e.result ?? null;
      if (e.event === "error") failure = e.message ?? "The tool failed.";
    },
  }).catch((e: Error) => {
    throw new Error(failure ?? e.message);
  });
  if (result === null) throw new Error(failure ?? "The tool returned nothing.");
  return result as T;
}

/**
 * Crop position over time as an ffmpeg expression. Intervals are half-open, because closed ones
 * overlap on the exact boundary frame and the position doubles for that one frame.
 */
export function cropPath(times: number[], px: number[]) {
  const last = px.length - 1;
  if (last < 1) return String(px[0] ?? 0);
  const parts = px.slice(0, -1).map((x, i) => {
    const a = times[i].toFixed(3);
    const slope = ((px[i + 1] - x) / (times[i + 1] - times[i])).toFixed(3);
    return `gte(t,${a})*lt(t,${times[i + 1].toFixed(3)})*(${x}+(t-${a})*${slope})`;
  });
  return [...parts, `gte(t,${times[last].toFixed(3)})*${px[last]}`].join("+");
}

export type Transcript = { locale: string; duration: number; words: { text: string; start: number; end: number; confidence?: number }[] };
export const DEPTH_MODEL = "DepthAnythingV2SmallF16.mlpackage";
const DEPTH_REPO = "apple/coreml-depth-anything-v2-small";
const MIN_TRACK_QUALITY = 0.7;

export class Tools {
  private files: Files;
  private cache: ToolCache;
  private jobs: Jobs;

  constructor(files: Files, cache: ToolCache, jobs: Jobs) {
    this.files = files;
    this.cache = cache;
    this.jobs = jobs;
    jobs.register<{ hash: string; subject: string; quality: string; codec: string }>("tool.removeBackground", (p, ctx) => this.cutout(p, ctx));
    jobs.register<{ hash: string; locale: string }>("tool.transcribe", (p, ctx) => this.runTranscribe(p, ctx));
    jobs.register<{ hash: string; keepPause: number }>("tool.cutSilences", (p, ctx) => this.cutSilences(p, ctx));
    jobs.register<{ hash: string; width: number; height: number }>("tool.reframe", (p, ctx) => this.reframe(p, ctx));
    jobs.register<{ hash: string; move: string; duration: number; amount: number }>("tool.parallax", (p, ctx) => this.parallax(p, ctx));
    jobs.register<{ hash: string }>("tool.track", (p, ctx) => this.track(p, ctx));
    jobs.register<Record<string, never>>("pack.depth", (_, ctx) => this.installDepth(ctx));
  }

  runJob<T>(kind: string, payload: unknown) {
    return this.jobs.run<T>(kind, payload, { lane: "heavy", priority: 4 });
  }

  /** Native background removal. Saved once by content, so a second request is instant. */
  removeBackground(hash: string, subject = "person", quality = "accurate", codec = "prores") {
    return this.jobs.run<{ file: StoredFile; mask: StoredFile; cached: boolean; seconds: number; coverage: number }>("tool.removeBackground", { hash, subject, quality, codec }, { lane: "heavy", priority: 4 });
  }

  private async cutout(p: { hash: string; subject: string; quality: string; codec: string }, ctx: JobContext) {
    const key = `cutout:v1:${p.hash}:${p.subject}:${p.quality}:${p.codec}`;
    const hit = this.cache.get<{ file: string; mask: string; coverage: number }>(key);
    if (hit) return { file: this.files.get(hit.file), mask: this.files.get(hit.mask), cached: true, seconds: 0, coverage: hit.coverage };
    const source = this.files.get(p.hash);
    const dir = join(DIRS.tmp, randomUUID());
    mkdirSync(dir, { recursive: true });
    const started = Date.now();
    try {
      const out = join(dir, "cutout.mov");
      const mask = join(dir, "mask.mov");
      const r = await nativeTool<{ coverage: number }>(["remove-bg", "--input", source.path, "--output", out, "--mask", mask, "--subject", p.subject, "--quality", p.quality, "--codec", p.codec], ctx);
      const stem = source.name.replace(/\.[^.]+$/, "");
      const file = await this.files.fromPath(out, `${stem} cutout.mov`);
      const maskFile = await this.files.fromPath(mask, `${stem} mask.mov`);
      this.cache.set(key, { file: file.hash, mask: maskFile.hash, coverage: r.coverage });
      return { file, mask: maskFile, cached: false, seconds: (Date.now() - started) / 1000, coverage: r.coverage };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  transcribe(hash: string, locale = "en-US") {
    const hit = this.cache.get<Transcript>(`transcribe:v1:${hash}:${locale}`);
    if (hit) return Promise.resolve(hit);
    return this.jobs.run<Transcript>("tool.transcribe", { hash, locale }, { lane: "light", priority: 3 });
  }

  private async runTranscribe(p: { hash: string; locale: string }, ctx: JobContext) {
    const key = `transcribe:v1:${p.hash}:${p.locale}`;
    return this.cache.remember(key, async () => {
      const source = this.files.get(p.hash);
      const wav = join(DIRS.tmp, `${randomUUID()}.wav`);
      try {
        await extractAudio(source.path, wav);
        return await nativeTool<Transcript>(["transcribe", "--input", wav, "--locale", p.locale], ctx);
      } finally {
        rmSync(wav, { force: true });
      }
    });
  }

  speechLocales() {
    return nativeTool<{ supported: string[]; installed: string[] }>(["speech-locales"]);
  }

  /** Removes dead air but keeps a short beat, so speech never sounds chopped. */
  private async cutSilences(p: { hash: string; keepPause: number }, ctx: JobContext) {
    const source = this.files.get(p.hash);
    const info = await probe(source.path);
    const gaps = (await silences(source.path, -32, Math.max(0.3, p.keepPause + 0.1))).filter((g) => g.end - g.start > p.keepPause);
    const half = p.keepPause / 2;
    const ranges: [number, number][] = [];
    let at = 0;
    for (const g of gaps) {
      ranges.push([at, Math.min(info.duration, g.start + half)]);
      at = Math.max(0, g.end - half);
    }
    ranges.push([at, info.duration]);
    const keep = ranges.filter(([a, b]) => b - a > 0.05);
    const expr = keep.map(([a, b]) => `between(t,${a.toFixed(3)},${b.toFixed(3)})`).join("+");
    const out = join(DIRS.tmp, `${randomUUID()}.mp4`);
    ctx.progress(0.3, "Removing silences");
    await run(ffmpeg(), ["-y", "-loglevel", "error", "-i", source.path, "-vf", `select='${expr}',setpts=N/FRAME_RATE/TB`, "-af", `aselect='${expr}',asetpts=N/SR/TB`, "-c:v", "h264_videotoolbox", "-b:v", "12M", "-c:a", "aac", out], { signal: ctx.signal });
    const file = await this.files.fromPath(out, `${source.name.replace(/\.[^.]+$/, "")} tightened.mp4`);
    rmSync(out, { force: true });
    return { file, removedSeconds: info.duration - (await probe(file.path)).duration, gaps: gaps.length };
  }

  /** Follows the largest face over time with a smoothed crop path. */
  private async reframe(p: { hash: string; width: number; height: number }, ctx: JobContext) {
    const source = this.files.get(p.hash);
    const info = await probe(source.path);
    const step = Math.max(1, info.duration / 120);
    const dir = join(DIRS.tmp, randomUUID());
    mkdirSync(dir, { recursive: true });
    try {
      const times: number[] = [];
      for (let t = 0; t < info.duration; t += step) times.push(t);
      const paths = times.map((_, i) => join(dir, `${i}.jpg`));
      for (let i = 0; i < times.length; i++) {
        await frameAt(source.path, times[i], paths[i], 480);
        ctx.progress((i / times.length) * 0.4, "Finding the speaker");
      }
      const { items } = await nativeTool<{ items: { faces?: { box: number[] }[]; saliency?: { box: number[] }[] }[] }>(["analyze", "--features", "faces,saliency", ...paths]);
      const cropW = Math.min(info.width, Math.round((info.height * p.width) / p.height)) & ~1;
      const raw = items.map((it) => {
        const face = [...(it.faces ?? [])].sort((a, b) => b.box[2] * b.box[3] - a.box[2] * a.box[3])[0]?.box ?? it.saliency?.[0]?.box;
        return face ? face[0] + face[2] / 2 : null;
      });
      let last = raw.find((v) => v !== null) ?? 0.5;
      const filled = raw.map((v) => (last = v ?? last));
      // A centred moving average keeps the frame calm instead of chasing every head turn.
      const smooth = filled.map((_, i) => {
        const w = filled.slice(Math.max(0, i - 2), i + 3);
        return w.reduce((a, b) => a + b, 0) / w.length;
      });
      const px = smooth.map((c) => Math.max(0, Math.min(info.width - cropW, Math.round(c * info.width - cropW / 2))));
      const expr = cropPath(times, px);
      const out = join(dir, "out.mp4");
      ctx.progress(0.5, "Reframing");
      await run(ffmpeg(), ["-y", "-loglevel", "error", "-i", source.path, "-vf", `crop=${cropW}:${info.height}:'${expr}':0,scale=${p.width}:${p.height}`, "-c:v", "h264_videotoolbox", "-b:v", "10M", "-c:a", "copy", out], { signal: ctx.signal });
      return { file: await this.files.fromPath(out, `${source.name.replace(/\.[^.]+$/, "")} ${p.width}x${p.height}.mp4`), detected: raw.filter((v) => v !== null).length, samples: raw.length };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  depthModel() {
    const p = join(DIRS.packs, "depth", DEPTH_MODEL);
    return existsSync(join(p, "Manifest.json")) ? p : null;
  }

  /** Downloads Apple's Apache-licensed Core ML build of Depth Anything V2 Small. */
  private async installDepth(ctx: JobContext) {
    if (this.depthModel()) return { installed: true };
    const listing = (await (await fetch(`https://huggingface.co/api/models/${DEPTH_REPO}/tree/main/${DEPTH_MODEL}?recursive=1`, { signal: ctx.signal })).json()) as { type: string; path: string; size: number }[];
    const files = listing.filter((f) => f.type === "file");
    if (!files.length) throw new Error("The depth model listing was empty.");
    const root = join(DIRS.packs, "depth");
    for (let i = 0; i < files.length; i++) {
      ctx.progress(i / files.length, "Downloading the depth model");
      const res = await fetch(`https://huggingface.co/${DEPTH_REPO}/resolve/main/${files[i].path}`, { signal: ctx.signal });
      if (!res.ok) throw new Error(`Download failed (${res.status}).`);
      const target = join(root, files[i].path);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, Buffer.from(await res.arrayBuffer()));
    }
    return { installed: true };
  }

  private async parallax(p: { hash: string; move: string; duration: number; amount: number }, ctx: JobContext) {
    const model = this.depthModel();
    if (!model) throw new Error("Install the depth pack first.");
    const source = this.files.get(p.hash);
    const dir = join(DIRS.tmp, randomUUID());
    mkdirSync(dir, { recursive: true });
    try {
      let still = source.path;
      if (source.kind === "video") {
        still = join(dir, "still.png");
        await run(ffmpeg(), ["-y", "-loglevel", "error", "-i", source.path, "-frames:v", "1", "-update", "1", still]);
      }
      const out = join(dir, "parallax.mp4");
      await nativeTool(["parallax", "--model", model, "--input", still, "--output", out, "--move", p.move, "--duration", String(p.duration), "--amount", String(p.amount)], ctx);
      return { file: await this.files.fromPath(out, `${source.name.replace(/\.[^.]+$/, "")} parallax.mp4`) };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  /** Solves the real camera path with COLMAP. Needs camera movement to find depth. */
  private async track(p: { hash: string }, ctx: JobContext) {
    const colmap = need(findBin("colmap"), "COLMAP is not installed. Run: brew install colmap");
    const source = this.files.get(p.hash);
    const info = await probe(source.path);
    const dir = join(DIRS.tmp, randomUUID());
    const images = join(dir, "images");
    const sparse = join(dir, "sparse");
    const text = join(dir, "text");
    for (const d of [images, sparse, text]) mkdirSync(d, { recursive: true });
    try {
      const rate = Math.min(6, Math.max(1, 180 / Math.max(1, info.duration)));
      ctx.progress(0.05, "Extracting frames");
      await run(ffmpeg(), ["-y", "-loglevel", "error", "-i", source.path, "-vf", `fps=${rate.toFixed(2)},scale=1280:-2`, "-q:v", "2", join(images, "%05d.jpg")], { signal: ctx.signal });
      const db = join(dir, "db.db");
      ctx.progress(0.15, "Finding features");
      await run(colmap, ["feature_extractor", "--database_path", db, "--image_path", images, "--ImageReader.single_camera", "1", "--ImageReader.camera_model", "SIMPLE_RADIAL"], { signal: ctx.signal });
      ctx.progress(0.4, "Matching frames");
      await run(colmap, ["sequential_matcher", "--database_path", db, "--SequentialMatching.overlap", "12"], { signal: ctx.signal });
      ctx.progress(0.6, "Solving the camera");
      await run(colmap, ["mapper", "--database_path", db, "--image_path", images, "--output_path", sparse], { signal: ctx.signal });
      const model = readdirSync(sparse).sort()[0];
      if (!model) throw new Error("The camera couldn't be solved. Tracking needs real camera movement and a textured scene.");
      await run(colmap, ["model_converter", "--input_path", join(sparse, model), "--output_path", text, "--output_type", "TXT"], { signal: ctx.signal });
      const lines = readFileSync(join(text, "images.txt"), "utf8").split("\n").filter((l) => l && !l.startsWith("#"));
      const poses: { frame: number; t: number; rotation: number[]; position: number[] }[] = [];
      for (let i = 0; i < lines.length; i += 2) {
        const f = lines[i].split(" ");
        const [qw, qx, qy, qz, tx, ty, tz] = f.slice(1, 8).map(Number);
        // COLMAP stores world-to-camera. The camera centre is -R^T * t.
        const R = [1 - 2 * (qy * qy + qz * qz), 2 * (qx * qy - qz * qw), 2 * (qx * qz + qy * qw), 2 * (qx * qy + qz * qw), 1 - 2 * (qx * qx + qz * qz), 2 * (qy * qz - qx * qw), 2 * (qx * qz - qy * qw), 2 * (qy * qz + qx * qw), 1 - 2 * (qx * qx + qy * qy)];
        const position = [-(R[0] * tx + R[3] * ty + R[6] * tz), -(R[1] * tx + R[4] * ty + R[7] * tz), -(R[2] * tx + R[5] * ty + R[8] * tz)];
        const frame = Number(f[9].replace(/\D/g, ""));
        poses.push({ frame, t: (frame - 1) / rate, rotation: [qw, qx, qy, qz], position });
      }
      poses.sort((a, b) => a.t - b.t);
      const total = readdirSync(images).length;
      const out = join(dir, "camera.json");
      writeFileSync(out, JSON.stringify({ fps: rate, width: 1280, solved: poses.length, frames: total, poses }));
      const quality = poses.length / total;
      // A path with holes looks finished but can't drive a 3D scene, so it is never reported as good.
      if (quality < MIN_TRACK_QUALITY) throw new Error(`The camera couldn't be tracked: only ${poses.length} of ${total} frames solved. This usually means the shot is mostly a moving person, or the camera barely moves.`);
      const file = await this.files.fromPath(out, `${source.name.replace(/\.[^.]+$/, "")} camera.json`);
      return { file, solved: poses.length, frames: total, quality: Number(quality.toFixed(2)) };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
}

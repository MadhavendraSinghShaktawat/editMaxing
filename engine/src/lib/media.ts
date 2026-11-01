import { spawn } from "node:child_process";
import { TOOL_PATH, findBin } from "../config.ts";
import { SlidingMedian, kmeans } from "./dsa.ts";
import { run } from "./proc.ts";

const ffmpeg = () => {
  const p = findBin("ffmpeg");
  if (!p) throw new Error("ffmpeg is not installed. Run: brew install ffmpeg");
  return p;
};
const ffprobe = () => findBin("ffprobe") ?? "ffprobe";

export type Probe = { duration: number; width: number; height: number; fps: number; hasAudio: boolean; hasVideo: boolean; codec: string | null; pixFmt: string | null };

export async function probe(path: string): Promise<Probe> {
  const { stdout } = await run(ffprobe(), ["-v", "error", "-show_entries", "format=duration:stream=codec_type,codec_name,width,height,avg_frame_rate,r_frame_rate,pix_fmt:stream_side_data=rotation", "-of", "json", path]);
  const d = JSON.parse(stdout) as { format?: { duration?: string }; streams?: { codec_type: string; codec_name?: string; width?: number; height?: number; avg_frame_rate?: string; r_frame_rate?: string; pix_fmt?: string; side_data_list?: { rotation?: number }[] }[] };
  const v = d.streams?.find((s) => s.codec_type === "video");
  const rate = (v?.avg_frame_rate && v.avg_frame_rate !== "0/0" ? v.avg_frame_rate : v?.r_frame_rate) ?? "0/1";
  const [n, m] = rate.split("/").map(Number);
  const rotated = Math.abs(v?.side_data_list?.[0]?.rotation ?? 0) === 90;
  return {
    duration: Number(d.format?.duration ?? 0),
    width: (rotated ? v?.height : v?.width) ?? 0,
    height: (rotated ? v?.width : v?.height) ?? 0,
    fps: m ? n / m : 0,
    hasAudio: !!d.streams?.some((s) => s.codec_type === "audio"),
    hasVideo: !!v,
    codec: v?.codec_name ?? null,
    pixFmt: v?.pix_fmt ?? null,
  };
}

export const extractAudio = (path: string, out: string) => run(ffmpeg(), ["-y", "-loglevel", "error", "-i", path, "-vn", "-ac", "1", "-ar", "16000", out]);

export async function frameAt(path: string, t: number, out: string, width = 640) {
  await run(ffmpeg(), ["-y", "-loglevel", "error", "-ss", String(Math.max(0, t)), "-i", path, "-frames:v", "1", "-vf", `scale=${width}:-2`, "-q:v", "3", "-update", "1", out]);
}

export async function filmstrip(path: string, t0: number, t1: number, out: string, cols = 4, rows = 2, width = 320) {
  const count = cols * rows;
  const span = Math.max(0.1, t1 - t0);
  const rate = (count / span).toFixed(4);
  await run(ffmpeg(), ["-y", "-loglevel", "error", "-ss", String(t0), "-t", String(span), "-i", path, "-vf", `fps=${rate},scale=${width}:-2,tile=${cols}x${rows}:padding=4:color=white`, "-frames:v", "1", "-q:v", "3", "-update", "1", out]);
}

export async function loudness(path: string) {
  const { stderr } = await run(ffmpeg(), ["-hide_banner", "-nostats", "-i", path, "-af", "ebur128=peak=true", "-f", "null", "-"]);
  const pick = (re: RegExp) => {
    const all = [...stderr.matchAll(re)];
    return all.length ? Number(all[all.length - 1][1]) : null;
  };
  return { lufs: pick(/I:\s+(-?[\d.]+) LUFS/g), lra: pick(/LRA:\s+(-?[\d.]+) LU/g), truePeak: pick(/Peak:\s+(-?[\d.]+) dBFS/g) };
}

export async function silences(path: string, noiseDb = -32, minSeconds = 0.3) {
  const { stderr } = await run(ffmpeg(), ["-hide_banner", "-nostats", "-i", path, "-af", `silencedetect=noise=${noiseDb}dB:d=${minSeconds}`, "-f", "null", "-"]);
  const out: { start: number; end: number }[] = [];
  let start = 0;
  for (const line of stderr.split("\n")) {
    const s = line.match(/silence_start: (-?[\d.]+)/);
    const e = line.match(/silence_end: (-?[\d.]+)/);
    if (s) start = Math.max(0, Number(s[1]));
    if (e) out.push({ start, end: Number(e[1]) });
  }
  return out;
}

/** sRGB to OKLab, so colour clustering matches how people see colour. */
function oklab(r: number, g: number, b: number) {
  const f = (c: number) => ((c /= 255) <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  const [lr, lg, lb] = [f(r), f(g), f(b)];
  const l = Math.cbrt(0.4122214708 * lr + 0.5363325363 * lg + 0.0514459929 * lb);
  const m = Math.cbrt(0.2119034982 * lr + 0.6806995451 * lg + 0.1073969566 * lb);
  const s = Math.cbrt(0.0883024619 * lr + 0.2817188376 * lg + 0.6299787005 * lb);
  return [0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s, 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s, 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s];
}

function oklabToHex([L, a, b]: number[]) {
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  const rgb = [4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s, -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s, -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s];
  const g = (c: number) => Math.round(255 * Math.max(0, Math.min(1, c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055)));
  return "#" + rgb.map((c) => g(c).toString(16).padStart(2, "0")).join("");
}

export function palette(frame: Uint8Array, stride = 7, colors = 4) {
  const pts: number[][] = [];
  for (let i = 0; i + 2 < frame.length; i += 3 * stride) pts.push(oklab(frame[i], frame[i + 1], frame[i + 2]));
  return kmeans(pts, colors, 8).map((c) => ({ color: oklabToHex(c.center), weight: Number(c.weight.toFixed(3)) }));
}

const gray = (f: Uint8Array) => {
  const g = new Float32Array(f.length / 3);
  for (let i = 0; i < g.length; i++) g[i] = 0.2126 * f[i * 3] + 0.7152 * f[i * 3 + 1] + 0.0722 * f[i * 3 + 2];
  return g;
};

/** Variance of the Laplacian: a standard measure of focus. Higher is sharper. */
export function sharpness(frame: Uint8Array, w: number, h: number) {
  const g = gray(frame);
  let sum = 0;
  let sq = 0;
  let n = 0;
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      const v = g[i - 1] + g[i + 1] + g[i - w] + g[i + w] - 4 * g[i];
      sum += v;
      sq += v * v;
      n++;
    }
  }
  return n ? sq / n - (sum / n) ** 2 : 0;
}

/** 64-bit difference hash. Near-identical frames land within a few bits of each other. */
export function dHash(frame: Uint8Array, w: number, h: number) {
  const g = gray(frame);
  const cell = new Float32Array(72);
  for (let cy = 0; cy < 8; cy++) {
    for (let cx = 0; cx < 9; cx++) {
      const x0 = Math.floor((cx * w) / 9);
      const x1 = Math.floor(((cx + 1) * w) / 9);
      const y0 = Math.floor((cy * h) / 8);
      const y1 = Math.floor(((cy + 1) * h) / 8);
      let s = 0;
      for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) s += g[y * w + x];
      cell[cy * 9 + cx] = s / Math.max(1, (x1 - x0) * (y1 - y0));
    }
  }
  const parts = [0, 0];
  for (let i = 0; i < 64; i++) {
    const row = i >> 3;
    const col = i & 7;
    if (cell[row * 9 + col] < cell[row * 9 + col + 1]) parts[i >> 5] = (parts[i >> 5] | (1 << (i & 31))) >>> 0;
  }
  return parts.map((p) => p.toString(16).padStart(8, "0")).join("");
}

export type DetectedShot = { t0: number; t1: number; motion: number; brightness: number; sharpness: number; palette: { color: string; weight: number }[]; phash: string; motionCurve?: number[] };

const W = 160;
const H = 90;
const RATE = 10;
const MAX_SHOT = 8;

/** One decode pass finds cuts and measures every shot, so nothing is decoded twice. */
export function detectShots(path: string, duration: number, onProgress?: (v: number) => void, signal?: AbortSignal, maxShot = MAX_SHOT) {
  return new Promise<DetectedShot[]>((resolve, reject) => {
    const child = spawn(ffmpeg(), ["-loglevel", "error", "-i", path, "-an", "-vf", `fps=${RATE},scale=${W}:${H}:flags=bilinear`, "-f", "rawvideo", "-pix_fmt", "rgb24", "pipe:1"], { env: { ...process.env, PATH: TOOL_PATH }, stdio: ["ignore", "pipe", "pipe"] });
    const abort = () => child.kill("SIGTERM");
    signal?.addEventListener("abort", abort, { once: true });
    const size = W * H * 3;
    let carry: Buffer = Buffer.alloc(0);
    let index = 0;
    let previous: Buffer | null = null;
    let previousHist: Float32Array | null = null;
    const window = new SlidingMedian(30);
    const shots: DetectedShot[] = [];
    let start = 0;
    let lastCut = -1;
    let frames: Uint8Array[] = [];
    let motions: number[] = [];

    const close = (t: number) => {
      if (t - start < 0.05) return;
      const mid = frames[frames.length >> 1];
      if (mid) {
        const motion = motions.length ? motions.reduce((a, b) => a + b, 0) / motions.length : 0;
        let brightness = 0;
        for (let i = 0; i < mid.length; i += 3) brightness += mid[i] + mid[i + 1] + mid[i + 2];
        shots.push({ t0: start, t1: t, motion, brightness: brightness / (mid.length * 255), sharpness: sharpness(mid, W, H), palette: palette(mid), phash: dHash(mid, W, H) });
      }
      start = t;
      frames = [];
      motions = [];
    };

    child.stdout.on("data", (chunk: Buffer) => {
      carry = carry.length ? Buffer.concat([carry, chunk]) : chunk;
      let offset = 0;
      while (carry.length - offset >= size) {
        const frame = carry.subarray(offset, offset + size);
        offset += size;
        const t = index / RATE;
        const hist = new Float32Array(48);
        let diff = 0;
        for (let i = 0; i < size; i += 3) {
          hist[frame[i] >> 4]++;
          hist[16 + (frame[i + 1] >> 4)]++;
          hist[32 + (frame[i + 2] >> 4)]++;
          if (previous) diff += Math.abs(frame[i] - previous[i]) + Math.abs(frame[i + 1] - previous[i + 1]) + Math.abs(frame[i + 2] - previous[i + 2]);
        }
        const motion = previous ? diff / (size * 255) : 0;
        let score = 0;
        if (previousHist) {
          for (let b = 0; b < 48; b++) score += Math.abs(hist[b] - previousHist[b]);
          score /= 2 * 3 * W * H;
        }
        // A cut stands far above the recent median, so busy shots don't fire false cuts.
        const threshold = Math.max(0.22, window.median * 5 + 0.12);
        if (previousHist && score > threshold && t - lastCut > 0.3 && t - start > 0.25) {
          close(t);
          lastCut = t;
        } else if (t - start >= maxShot) {
          close(t);
        }
        window.push(score);
        motions.push(motion);
        if (index % RATE === Math.floor(RATE / 2) || !frames.length) frames.push(Uint8Array.from(frame));
        previous = Buffer.from(frame);
        previousHist = hist;
        index++;
        if (index % 40 === 0 && duration > 0) onProgress?.(Math.min(0.99, t / duration));
      }
      carry = offset < carry.length ? Buffer.from(carry.subarray(offset)) : Buffer.alloc(0);
    });
    const err: string[] = [];
    child.stderr.setEncoding("utf8").on("data", (d: string) => err.push(d));
    child.on("error", reject);
    child.on("close", (code) => {
      signal?.removeEventListener("abort", abort);
      if (signal?.aborted) return reject(new Error("Cancelled"));
      if (code !== 0) return reject(new Error(err.join("").trim().split("\n").pop() || "Could not read this video."));
      close(index / RATE);
      resolve(shots);
    });
  });
}

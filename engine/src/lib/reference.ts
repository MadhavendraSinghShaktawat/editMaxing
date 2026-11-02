import { spawn } from "node:child_process";
import { TOOL_PATH, findBin } from "../config.ts";
import { SlidingMedian } from "./dsa.ts";
import { palette } from "./media.ts";

/** Everything here measures. Claude decides what the measurements mean. */

const W = 160;
const H = 90;
const CELLS = 16 * 9;

export type Curve = {
  fps: number;
  /** Mean change between frames, 0 to 1. */
  diff: number[];
  /** Colour histogram change between frames, 0 to 1. */
  change: number[];
  /** Share of the picture that changed between frames. A cut moves all of it, a word only a corner. */
  spread: number[];
  bright: number[];
  sharp: number[];
  hist: Float32Array[];
  palette: { color: string; weight: number }[];
};

export function readCurve(path: string, duration: number, options: { fps?: number; onProgress?: (v: number) => void; signal?: AbortSignal } = {}) {
  const fps = options.fps ?? 30;
  const ffmpeg = findBin("ffmpeg");
  if (!ffmpeg) throw new Error("ffmpeg is not installed. Run: brew install ffmpeg");
  return new Promise<Curve>((resolve, reject) => {
    const child = spawn(ffmpeg, ["-loglevel", "error", "-i", path, "-an", "-vf", `fps=${fps},scale=${W}:${H}:flags=bilinear`, "-f", "rawvideo", "-pix_fmt", "rgb24", "pipe:1"], { env: { ...process.env, PATH: TOOL_PATH }, stdio: ["ignore", "pipe", "pipe"] });
    const abort = () => child.kill("SIGTERM");
    options.signal?.addEventListener("abort", abort, { once: true });
    const size = W * H * 3;
    const curve: Curve = { fps, diff: [], change: [], spread: [], bright: [], sharp: [], hist: [], palette: [] };
    const samples: Uint8Array[] = [];
    let carry: Buffer = Buffer.alloc(0);
    let previous: Buffer | null = null;
    let previousHist: Float32Array | null = null;

    child.stdout.on("data", (chunk: Buffer) => {
      carry = carry.length ? Buffer.concat([carry, chunk]) : chunk;
      let offset = 0;
      while (carry.length - offset >= size) {
        const frame = carry.subarray(offset, offset + size);
        offset += size;
        const hist = new Float32Array(48);
        const cells = new Float32Array(CELLS);
        let diff = 0;
        let bright = 0;
        let edge = 0;
        for (let y = 0; y < H; y++) {
          for (let x = 0; x < W; x++) {
            const i = (y * W + x) * 3;
            const r = frame[i];
            const g = frame[i + 1];
            const b = frame[i + 2];
            hist[r >> 4]++;
            hist[16 + (g >> 4)]++;
            hist[32 + (b >> 4)]++;
            bright += r + g + b;
            if (x + 1 < W) edge += Math.abs(g - frame[i + 4]);
            if (previous) {
              const d = Math.abs(r - previous[i]) + Math.abs(g - previous[i + 1]) + Math.abs(b - previous[i + 2]);
              diff += d;
              cells[((y * 9) / H | 0) * 16 + ((x * 16) / W | 0)] += d;
            }
          }
        }
        let change = 0;
        if (previousHist) {
          for (let k = 0; k < 48; k++) change += Math.abs(hist[k] - previousHist[k]);
          change /= 2 * 3 * W * H;
        }
        const perCell = (W * H * 3 * 255) / CELLS;
        let moved = 0;
        for (let k = 0; k < CELLS; k++) if (cells[k] / perCell > 0.035) moved++;
        curve.diff.push(previous ? diff / (size * 255) : 0);
        curve.change.push(change);
        curve.spread.push(moved / CELLS);
        curve.bright.push(bright / (size * 255));
        curve.sharp.push(edge / (W * H * 255));
        curve.hist.push(hist);
        if (curve.diff.length % Math.round(fps * 2) === 1) samples.push(Uint8Array.from(frame));
        previous = Buffer.from(frame);
        previousHist = hist;
        if (curve.diff.length % 90 === 0 && duration > 0) options.onProgress?.(Math.min(0.99, curve.diff.length / fps / duration));
      }
      carry = offset < carry.length ? Buffer.from(carry.subarray(offset)) : Buffer.alloc(0);
    });
    const err: string[] = [];
    child.stderr.setEncoding("utf8").on("data", (d: string) => err.push(d));
    child.on("error", reject);
    child.on("close", (code) => {
      options.signal?.removeEventListener("abort", abort);
      if (options.signal?.aborted) return reject(new Error("Cancelled"));
      if (code !== 0) return reject(new Error(err.join("").trim().split("\n").pop() || "Could not read this video."));
      if (samples.length) {
        const all = new Uint8Array(samples.length * size);
        samples.forEach((s, i) => all.set(s, i * size));
        curve.palette = palette(all, 11, 5);
      }
      resolve(curve);
    });
  });
}

export type BoundaryKind = "cut" | "jump_cut" | "dissolve" | "dip_black" | "dip_white" | "flash" | "whip";
export type Boundary = { t: number; kind: BoundaryKind; seconds: number; strength: number };

const distance = (a: Float32Array, b: Float32Array) => {
  let d = 0;
  for (let i = 0; i < a.length; i++) d += Math.abs(a[i] - b[i]);
  return d / (2 * 3 * W * H);
};

const mean = (a: number[], from: number, to: number) => {
  const lo = Math.max(0, from);
  const hi = Math.min(a.length, to);
  let s = 0;
  for (let i = lo; i < hi; i++) s += a[i];
  return hi > lo ? s / (hi - lo) : 0;
};

/**
 * Finds every join in a video. A disturbance is a run of frames that change far more than their
 * neighbours; its length and what happens to brightness and sharpness say what kind of join it was.
 */
export function findBoundaries(c: Curve): Boundary[] {
  const n = c.change.length;
  const out: Boundary[] = [];
  const baseline = new SlidingMedian(45);
  const hot = new Array<boolean>(n).fill(false);
  for (let i = 1; i < n; i++) {
    hot[i] = c.change[i] > Math.max(0.035, baseline.median * 3 + 0.02);
    baseline.push(c.change[i]);
  }

  const seen = new Array<boolean>(n).fill(false);
  for (let i = 1; i < n; i++) {
    if (!hot[i]) continue;
    let end = i;
    while (end + 1 < n && (hot[end + 1] || (end + 2 < n && hot[end + 2]))) end++;
    // A fade to black sits on black for a moment, and black frames don't change, so carry on until the picture
    // returns. A hard cut to a black card is a different thing: it lands in one frame and is reported as a cut.
    if (end - i >= 2 && c.bright[end] < 0.06) {
      while (end + 1 < n && c.bright[end + 1] < 0.1) end++;
      while (end + 1 < n && (hot[end + 1] || (end + 2 < n && hot[end + 2]))) end++;
    }
    const before = Math.max(0, i - 2);
    const after = Math.min(n - 1, end + 2);
    const net = distance(c.hist[before], c.hist[after]);
    const frames = end - i + 1;
    const t = (end - i < 2 ? i : (i + end + 1) / 2) / c.fps;
    const seconds = Number((frames / c.fps).toFixed(3));
    const outsideBright = Math.min(mean(c.bright, before - 8, before), mean(c.bright, after + 1, after + 9));
    const outsideBrightMax = Math.max(mean(c.bright, before - 8, before), mean(c.bright, after + 1, after + 9));
    const outsideSharp = Math.min(mean(c.sharp, before - 8, before), mean(c.sharp, after + 1, after + 9));
    let darkest = 1;
    let lightest = 0;
    let softest = Infinity;
    for (let k = i; k <= end; k++) {
      darkest = Math.min(darkest, c.bright[k]);
      lightest = Math.max(lightest, c.bright[k]);
      softest = Math.min(softest, c.sharp[k]);
    }
    let kind: BoundaryKind | null = null;
    if (frames >= 2 && lightest > 0.86 && lightest > outsideBrightMax + 0.2) kind = frames / c.fps <= 0.25 ? "flash" : "dip_white";
    else if (frames >= 2 && darkest < 0.05 && outsideBright > 0.1) kind = "dip_black";
    else if (frames <= 2 && net > Math.min(0.2, c.change[i] * 0.6)) kind = "cut";
    else if (frames > 2 && frames / c.fps <= 0.7 && softest < outsideSharp * 0.5 && net > 0.08) kind = "whip";
    else if (frames > 2 && net > 0.15) kind = "dissolve";
    if (kind) {
      out.push({ t: Number(t.toFixed(3)), kind, seconds, strength: Number(net.toFixed(3)) });
      for (let k = Math.max(0, i - 3); k <= Math.min(n - 1, end + 3); k++) seen[k] = true;
    }
    i = end;
  }

  // Any window that reaches across a join looks like a slow dissolve, so those windows are skipped.
  const reach = Math.round(c.fps * 0.3);
  const crossing = [...seen];
  seen.forEach((v, k) => {
    if (!v) return;
    for (let j = Math.max(0, k - reach - 1); j <= Math.min(n - 1, k + reach + 1); j++) crossing[j] = true;
  });

  // A slow dissolve changes little per frame, so compare frames further apart too.
  for (let i = reach; i + reach < n; i++) {
    if (crossing[i]) continue;
    const here = distance(c.hist[i - reach], c.hist[i + reach]);
    if (here < 0.14) continue;
    let peak = i;
    let best = here;
    for (let k = i + 1; k + reach < n && k < i + reach * 2; k++) {
      const d = distance(c.hist[k - reach], c.hist[k + reach]);
      if (d > best) {
        best = d;
        peak = k;
      }
    }
    // A dissolve moves steadily from one picture to the other, so its midpoint sits between them.
    const a = c.hist[Math.max(0, peak - reach)];
    const b = c.hist[Math.min(n - 1, peak + reach)];
    const toMid = distance(a, c.hist[peak]);
    const fromMid = distance(c.hist[peak], b);
    const covered = mean(c.spread, peak - reach, peak + reach);
    if (c.diff[peak] < 0.2 && toMid > best * 0.25 && fromMid > best * 0.25 && covered > 0.5) {
      out.push({ t: Number((peak / c.fps).toFixed(3)), kind: "dissolve", seconds: Number(((reach * 2) / c.fps).toFixed(3)), strength: Number(best.toFixed(3)) });
      for (let k = Math.max(0, peak - reach * 2); k < Math.min(n, peak + reach * 2); k++) seen[k] = true;
    }
    i = peak + reach;
  }

  // A jump cut keeps the same room, so colours barely move, but every part of the picture
  // shifts in one frame. A word appearing touches only part of it.
  for (let i = 2; i + 2 < n; i++) {
    if (seen[i]) continue;
    const near = Math.max(c.diff[i - 2], c.diff[i - 1], c.diff[i + 1], c.diff[i + 2]);
    if (c.diff[i] > 0.012 && c.diff[i] > near * 3 && c.spread[i] > 0.35) {
      out.push({ t: Number((i / c.fps).toFixed(3)), kind: "jump_cut", seconds: 0, strength: Number(c.diff[i].toFixed(3)) });
      seen[i] = true;
    }
  }
  return mergeNeighbours(out.sort((a, b) => a.t - b.t));
}

/** Full-screen black or white cards, which many styles use to land a word. */
export function solidCards(c: Curve) {
  const out: { t0: number; t1: number; color: "black" | "white" }[] = [];
  const pixels = W * H;
  let start = -1;
  let color: "black" | "white" = "black";
  const flush = (i: number) => {
    if (start >= 0 && (i - start) / c.fps >= 0.15) out.push({ t0: Number((start / c.fps).toFixed(2)), t1: Number((i / c.fps).toFixed(2)), color });
    start = -1;
  };
  c.hist.forEach((h, i) => {
    const dark = (h[0] + h[1]) / pixels;
    const light = (h[14] + h[15]) / pixels;
    const kind = dark > 0.85 ? "black" : light > 0.85 ? "white" : null;
    if (!kind) return flush(i);
    if (start >= 0 && kind !== color) flush(i);
    if (start < 0) {
      start = i;
      color = kind;
    }
  });
  flush(c.hist.length);
  return out;
}

const HARD = new Set<BoundaryKind>(["cut", "jump_cut"]);

/** One animated transition can register as several joins. Treat a tight cluster as one. */
function mergeNeighbours(list: Boundary[]) {
  const out: Boundary[] = [];
  for (const b of list) {
    const last = out[out.length - 1];
    if (last && b.t - last.t < 0.4 && (!HARD.has(last.kind) || !HARD.has(b.kind))) {
      const start = last.t - last.seconds / 2;
      const end = b.t + b.seconds / 2;
      const keep = !HARD.has(last.kind) && last.kind !== "dissolve" ? last.kind : !HARD.has(b.kind) && b.kind !== "dissolve" ? b.kind : "whip";
      out[out.length - 1] = { t: Number(((start + end) / 2).toFixed(3)), kind: keep, seconds: Number((end - start).toFixed(3)), strength: Math.max(last.strength, b.strength) };
    } else out.push(b);
  }
  return out;
}

/** Shot lengths come from the joins, so jump cuts count as the pacing they are. */
export function shotsFrom(boundaries: Boundary[], duration: number) {
  const shots: { t0: number; t1: number }[] = [];
  let start = 0;
  for (const b of boundaries) {
    if (b.t - start < 0.04) continue;
    shots.push({ t0: start, t1: b.t });
    start = b.t;
  }
  if (duration - start > 0.04) shots.push({ t0: start, t1: duration });
  return shots;
}

export type Sample = { t: number; dt: number; scale: number; dx: number; dy: number; turn: number; before: number; after: number };
export type CutFit = { t: number; scale: number; dx: number; dy: number; before: number; after: number };
export type Move = { t0: number; t1: number; kind: string; rate: number };

const MIN_ZOOM = 0.006;
const MIN_PAN = 0.012;

/** Turns frame-to-frame registration into the moves an editor would name. */
export function summarizeCamera(samples: Sample[], shots: { t0: number; t1: number }[], cuts: CutFit[], duration: number) {
  const time: Record<string, number> = { static: 0, push_in: 0, pull_out: 0, pan: 0, shake: 0 };
  const moves: Move[] = [];
  for (const shot of shots) {
    const inside = samples.filter((s) => s.t > shot.t0 && s.t <= shot.t1 && s.dt > 0);
    const span = inside.reduce((a, s) => a + s.dt, 0);
    if (span < 0.15) continue;
    let zoom = 0;
    let dx = 0;
    let dy = 0;
    let path = 0;
    let moved = 0;
    let settled = 0;
    for (const s of inside) {
      zoom += Math.log(Math.max(s.scale, 0.01));
      dx += s.dx;
      dy += s.dy;
      path += Math.hypot(s.dx, s.dy);
      moved += s.before;
      settled += s.after;
    }
    const net = Math.hypot(dx, dy);
    // A speaker's own movement wanders; a camera move keeps going the same way. So a transform counts
    // when it explains the change, or when the frames agree on the direction.
    const growing = inside.filter((s) => s.scale > 1 === zoom > 0).length / inside.length;
    const heading = inside.filter((s) => s.dx * dx + s.dy * dy > 0).length / inside.length;
    const real = moved > 0 && (settled / moved < 0.75 || growing >= 0.75 || heading >= 0.75);
    const zoomRate = zoom / span;
    const panRate = net / span;
    const pathRate = path / span;
    let kind = "static";
    if (real) {
      if (pathRate > 0.06 && net / Math.max(path, 1e-6) < 0.35) kind = "shake";
      else if (panRate >= MIN_PAN && panRate > Math.abs(zoomRate) && (settled / moved < 0.75 || heading >= 0.75)) kind = "pan";
      else if (Math.abs(zoomRate) >= MIN_ZOOM && (settled / moved < 0.75 || growing >= 0.75)) kind = zoomRate > 0 ? "push_in" : "pull_out";
    }
    time[kind] += span;
    if (kind !== "static") {
      const rate = kind === "push_in" || kind === "pull_out" ? Math.abs(zoomRate) * 100 : kind === "pan" ? panRate * 100 : pathRate * 100;
      moves.push({ t0: shot.t0, t1: shot.t1, kind: kind === "pan" ? (Math.abs(dx) >= Math.abs(dy) ? (dx > 0 ? "pan_right" : "pan_left") : dy > 0 ? "pan_up" : "pan_down") : kind, rate: Number(rate.toFixed(2)) });
    }
  }
  const measured = Object.values(time).reduce((a, b) => a + b, 0) || 1;
  const punches = cuts.filter((c) => c.before > 0 && c.after / c.before < 0.7).filter((c) => c.scale >= 1.05 || c.scale <= 0.95).map((c) => ({ t: c.t, scale: Number(c.scale.toFixed(3)), kind: c.scale > 1 ? "punch_in" : "punch_out" }));
  const pushRates = moves.filter((m) => m.kind === "push_in" || m.kind === "pull_out").map((m) => m.rate).sort((a, b) => a - b);
  return {
    share: Object.fromEntries(Object.entries(time).map(([k, v]) => [k, Number((v / measured).toFixed(3))])),
    moves: [...moves].sort((a, b) => b.t1 - b.t0 - (a.t1 - a.t0)).slice(0, 14),
    moveCount: moves.length,
    typicalZoomPercentPerSecond: pushRates[pushRates.length >> 1] ?? 0,
    punches,
    punchesPerMinute: duration ? Number(((punches.length / duration) * 60).toFixed(1)) : 0,
    typicalPunchScale: punches.length ? [...punches].map((p) => Math.max(p.scale, 1 / p.scale)).sort((a, b) => a - b)[punches.length >> 1] : null,
  };
}

/**
 * What happens on screen and when, as a list of moments. A moment is a join, a camera move starting,
 * or part of the picture changing suddenly, such as a word or panel landing.
 */
export function visualEvents(c: Curve, boundaries: Boundary[], moves: { t0: number }[] = []) {
  const times = [...boundaries.map((b) => b.t), ...moves.map((m) => m.t0)];
  const baseline = new SlidingMedian(30);
  for (let i = 2; i + 2 < c.diff.length; i++) {
    const local = c.diff[i] > Math.max(0.006, baseline.median * 2.5) && c.diff[i] >= c.diff[i - 1] && c.diff[i] >= c.diff[i + 1] && c.spread[i] > 0.02;
    if (local) times.push(i / c.fps);
    baseline.push(c.diff[i]);
  }
  times.sort((a, b) => a - b);
  const merged: number[] = [];
  for (const t of times) if (!merged.length || t - merged[merged.length - 1] > 0.2) merged.push(Number(t.toFixed(2)));
  return merged;
}

/** Plain numbers about how busy a video stays, used to compare any video with its reference. */
export function liveliness(c: Curve, events: number[], duration: number) {
  const marks = [0, ...events, duration];
  const gaps: { at: number; seconds: number }[] = [];
  for (let i = 1; i < marks.length; i++) gaps.push({ at: marks[i - 1], seconds: Number((marks[i] - marks[i - 1]).toFixed(2)) });
  const sorted = gaps.map((g) => g.seconds).sort((a, b) => a - b);
  const longest = gaps.reduce((best, g) => (g.seconds > best.seconds ? g : best), { at: 0, seconds: 0 });

  // A frozen stretch: nothing in the picture changes at all for half a second or more.
  let frozen = 0;
  let run = 0;
  const frozenAt: { at: number; seconds: number }[] = [];
  const flush = (i: number) => {
    if (run >= c.fps * 0.5) {
      frozen += run;
      frozenAt.push({ at: Number(((i - run) / c.fps).toFixed(2)), seconds: Number((run / c.fps).toFixed(2)) });
    }
    run = 0;
  };
  c.diff.forEach((d, i) => {
    if (i > 0 && d < 0.0006) run++;
    else flush(i);
  });
  flush(c.diff.length);
  return {
    events: events.length,
    eventsPerMinute: duration ? Number(((events.length / duration) * 60).toFixed(1)) : 0,
    typicalGapSeconds: sorted[sorted.length >> 1] ?? 0,
    longestGapSeconds: longest.seconds,
    longestGapAt: longest.at,
    frozenShare: c.diff.length ? Number((frozen / c.diff.length).toFixed(3)) : 0,
    frozenStretches: frozenAt.sort((a, b) => b.seconds - a.seconds).slice(0, 6),
  };
}

export type TextBox = { text: string; box: number[] };
export type FrameRead = { t: number; faces?: { box: number[] }[]; text?: TextBox[] };

const clean = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}']/gu, "");
const pick = (sorted: number[], q: number) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))] : null);
const round = (v: number | null, digits = 3) => (v === null ? null : Number(v.toFixed(digits)));

/** Vision boxes are x, y, width, height from the bottom left, as fractions of the frame. */
export function summarizeText(frames: FrameRead[], transcript: string[]) {
  const spoken = new Set(transcript.map(clean).filter(Boolean));
  const isCaption = (t: TextBox) => {
    const tokens = t.text.split(/\s+/).map(clean).filter(Boolean);
    return tokens.length > 0 && tokens.filter((w) => spoken.has(w)).length / tokens.length >= 0.6;
  };
  const heights: number[] = [];
  const ys: number[] = [];
  const xs: number[] = [];
  const wordCounts: number[] = [];
  const lineCounts: number[] = [];
  const zones = { top: 0, middle: 0, bottom: 0 };
  const across = { left: 0, center: 0, right: 0 };
  let upper = 0;
  let letters = 0;
  let withCaptions = 0;
  let onFace = 0;
  let boxes = 0;
  let grew = 0;
  let replaced = 0;
  let previous: string[] = [];
  const other = new Map<string, { at: number; y: number; x: number; h: number }>();
  for (const f of frames) {
    const caps = (f.text ?? []).filter(isCaption);
    for (const t of f.text ?? []) {
      if (isCaption(t)) continue;
      const key = t.text.trim();
      if (key.length > 1 && !other.has(key)) other.set(key, { at: f.t, y: round(t.box[1] + t.box[3] / 2)!, x: round(t.box[0] + t.box[2] / 2)!, h: round(t.box[3])! });
    }
    if (!caps.length) {
      previous = [];
      continue;
    }
    withCaptions++;
    const words = caps.flatMap((t) => t.text.split(/\s+/).map(clean).filter(Boolean));
    wordCounts.push(words.length);
    lineCounts.push(caps.length);
    if (previous.length) {
      const kept = previous.filter((w) => words.includes(w)).length;
      if (kept === previous.length && words.length > previous.length) grew++;
      else if (kept === 0) replaced++;
    }
    previous = words;
    for (const t of caps) {
      const [x, y, w, h] = t.box;
      heights.push(h);
      const cy = y + h / 2;
      const cx = x + w / 2;
      ys.push(cy);
      xs.push(cx);
      zones[cy > 0.66 ? "top" : cy > 0.34 ? "middle" : "bottom"]++;
      across[cx < 0.38 ? "left" : cx > 0.62 ? "right" : "center"]++;
      for (const ch of t.text) {
        if (ch.toLowerCase() === ch.toUpperCase()) continue;
        letters++;
        if (ch === ch.toUpperCase()) upper++;
      }
      boxes++;
      if ((f.faces ?? []).some((face) => x < face.box[0] + face.box[2] && face.box[0] < x + w && y < face.box[1] + face.box[3] && face.box[1] < y + h)) onFace++;
    }
  }
  heights.sort((a, b) => a - b);
  ys.sort((a, b) => a - b);
  xs.sort((a, b) => a - b);
  wordCounts.sort((a, b) => a - b);
  lineCounts.sort((a, b) => a - b);
  const total = boxes || 1;
  return {
    shareOfFramesWithCaptions: frames.length ? round(withCaptions / frames.length) : 0,
    wordsOnScreen: { typical: pick(wordCounts, 0.5), most: wordCounts[wordCounts.length - 1] ?? null },
    linesOnScreen: { typical: pick(lineCounts, 0.5), most: lineCounts[lineCounts.length - 1] ?? null },
    uppercaseShare: letters ? round(upper / letters) : null,
    lineHeightShareOfFrame: { small: round(pick(heights, 0.1)), typical: round(pick(heights, 0.5)), large: round(pick(heights, 0.9)) },
    sizeContrast: heights.length && pick(heights, 0.1)! > 0 ? round(pick(heights, 0.9)! / pick(heights, 0.1)!, 2) : null,
    heightFromBottom: { low: round(pick(ys, 0.1)), typical: round(pick(ys, 0.5)), high: round(pick(ys, 0.9)) },
    acrossFrame: { low: round(pick(xs, 0.1)), typical: round(pick(xs, 0.5)), high: round(pick(xs, 0.9)) },
    zones: { top: round(zones.top / total), middle: round(zones.middle / total), bottom: round(zones.bottom / total) },
    alignment: { left: round(across.left / total), center: round(across.center / total), right: round(across.right / total) },
    overlapsFace: round(onFace / total),
    wordsBuildUpShare: withCaptions > 1 ? round(grew / (withCaptions - 1)) : 0,
    wordsReplacedShare: withCaptions > 1 ? round(replaced / (withCaptions - 1)) : 0,
    otherText: [...other].slice(0, 16).map(([text, v]) => ({ text, ...v })),
  };
}

export function summarizeFaces(frames: FrameRead[]) {
  const seen = frames.filter((f) => f.faces?.length);
  const main = seen.map((f) => [...f.faces!].sort((a, b) => b.box[2] * b.box[3] - a.box[2] * a.box[3])[0].box);
  const xs = main.map((b) => b[0] + b[2] / 2).sort((a, b) => a - b);
  const ys = main.map((b) => b[1] + b[3] / 2).sort((a, b) => a - b);
  const sizes = main.map((b) => b[3]).sort((a, b) => a - b);
  const head = main.map((b) => 1 - (b[1] + b[3])).sort((a, b) => a - b);
  return {
    shareOfFramesWithFace: frames.length ? round(seen.length / frames.length) : 0,
    acrossFrame: { low: round(pick(xs, 0.1)), typical: round(pick(xs, 0.5)), high: round(pick(xs, 0.9)) },
    heightFromBottom: round(pick(ys, 0.5)),
    faceHeightShareOfFrame: { small: round(pick(sizes, 0.1)), typical: round(pick(sizes, 0.5)), large: round(pick(sizes, 0.9)) },
    headroom: round(pick(head, 0.5)),
  };
}

type EarshotTag = { tag: string };
export type Earshot = {
  text?: string;
  summary?: string;
  music?: { tempo?: number; beats?: number[]; downbeats?: number[]; pulse_clarity?: number; confidence?: string };
  sections?: { start: number; end: number; music_genre?: EarshotTag[]; music_mood?: EarshotTag[]; instruments?: EarshotTag[]; ambience?: EarshotTag[]; voice?: EarshotTag[]; lufs?: number; ast?: Record<string, number> }[];
  events?: { t: number; kind?: string; label?: string; shape?: string; prominence_db?: number; length_ms?: number }[];
  sync?: { cuts?: { items?: { t: number; offset_ms: number; status: string; event?: string; event_prominence_db?: number }[] } };
  loudness?: { integrated_lufs?: number; true_peak_dbtp?: number; lra_lu?: number };
};

/** Keeps what describes a sound style: the music, the mix, the effects, and how sound follows the cuts. */
export function summarizeAudio(e: Earshot, joins: number[], duration: number) {
  const tags = (list?: EarshotTag[]) => (list ?? []).slice(0, 2).map((t) => t.tag);
  const effects = (e.events ?? []).filter((v) => v.kind && !["VOICE", "SPEECH"].includes(v.kind) && (v.prominence_db ?? 0) >= 3);
  const kinds: Record<string, number> = {};
  for (const v of effects) kinds[v.kind!] = (kinds[v.kind!] ?? 0) + 1;
  const items = e.sync?.cuts?.items ?? [];
  const beats = e.music?.beats ?? [];
  const steady = !!e.music?.confidence && e.music.confidence !== "none" && beats.length > 3;
  const onBeat = steady ? joins.filter((t) => beats.some((b) => Math.abs(b - t) <= 0.08)).length : null;
  return {
    summary: e.summary ?? null,
    tempo: e.music?.tempo ?? null,
    beatConfidence: e.music?.confidence ?? null,
    joinsOnBeatShare: onBeat === null || !joins.length ? null : round(onBeat / joins.length),
    sections: (e.sections ?? []).slice(0, 8).map((s) => ({ start: s.start, end: s.end, genre: tags(s.music_genre), mood: tags(s.music_mood), instruments: tags(s.instruments), ambience: tags(s.ambience), voice: tags(s.voice), lufs: s.lufs, musicLevel: s.ast?.Music ?? null, speechLevel: s.ast?.Speech ?? null })),
    soundEffects: { count: effects.length, perMinute: duration ? Number(((effects.length / duration) * 60).toFixed(1)) : 0, kinds, examples: effects.slice(0, 40).map((v) => ({ t: v.t, what: v.label, kind: v.kind, prominenceDb: v.prominence_db, ms: v.length_ms })) },
    soundOnCuts: items.length ? {
      cuts: items.length,
      withinHundredMs: round(items.filter((i) => Math.abs(i.offset_ms) <= 100).length / items.length),
      onStrongAccent: round(items.filter((i) => Math.abs(i.offset_ms) <= 34 && (i.event_prominence_db ?? 0) >= 6).length / items.length),
    } : null,
  };
}

export type Moment = { t0: number; t1: number; reason: string };

/**
 * Chooses the moments worth showing Claude as frame sequences. Stills can't show movement,
 * so each moment becomes a short run of consecutive frames.
 */
export function chooseMoments(boundaries: Boundary[], moves: Move[], punches: { t: number; kind: string }[], events: number[], duration: number, limit = 30) {
  const out: Moment[] = [];
  const add = (t0: number, t1: number, reason: string) => {
    const a = Math.max(0, t0);
    const b = Math.min(duration, t1);
    if (b - a > 0.05 && !out.some((m) => a < m.t1 && m.t0 < b && m.reason === reason)) out.push({ t0: Number(a.toFixed(3)), t1: Number(b.toFixed(3)), reason });
  };
  const evenly = <T>(list: T[], k: number) => (list.length <= k ? list : Array.from({ length: k }, (_, i) => list[Math.floor((i * list.length) / k)]));
  for (const b of evenly(boundaries.filter((v) => v.kind !== "cut" && v.kind !== "jump_cut"), 8)) add(b.t - Math.max(0.2, b.seconds), b.t + Math.max(0.2, b.seconds), b.kind);
  for (const p of evenly(punches, 3)) add(p.t - 0.13, p.t + 0.2, p.kind);
  for (const m of evenly(moves, 5)) add(m.t0, Math.min(m.t1, m.t0 + 2), m.kind);
  for (const b of evenly(boundaries.filter((v) => v.kind === "cut" || v.kind === "jump_cut"), 5)) add(b.t - 0.13, b.t + 0.17, b.kind);
  const quietJoins = new Set(boundaries.map((b) => Math.round(b.t * 4)));
  const landings = events.filter((t) => !quietJoins.has(Math.round(t * 4)));
  for (const t of evenly(landings, Math.max(6, limit - out.length))) add(t - 0.05, t + 0.4, "something lands on screen");
  return out.slice(0, limit).sort((a, b) => a.t0 - b.t0);
}

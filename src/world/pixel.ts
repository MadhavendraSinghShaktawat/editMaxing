export type Ctx = CanvasRenderingContext2D;

export function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hash2(x: number, y: number) {
  let h = Math.imul(x, 374761393) + Math.imul(y, 668265263);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

const smooth = (t: number) => t * t * (3 - 2 * t);

export function noise(x: number, y: number) {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const u = smooth(x - xi);
  const v = smooth(y - yi);
  const a = hash2(xi, yi);
  const b = hash2(xi + 1, yi);
  const c = hash2(xi, yi + 1);
  const d = hash2(xi + 1, yi + 1);
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
}

export function fbm(x: number, y: number, octaves = 4) {
  let sum = 0;
  let amp = 0.5;
  let total = 0;
  let f = 1;
  for (let i = 0; i < octaves; i++) {
    sum += noise(x * f + i * 17, y * f - i * 11) * amp;
    total += amp;
    amp *= 0.5;
    f *= 2;
  }
  return sum / total;
}

const BAYER = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5];
export const bayer = (x: number, y: number) => (BAYER[(x & 3) + ((y & 3) << 2)] + 0.5) / 16 - 0.5;

export function rgb(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

export const rgba32 = (hex: string, a = 255) => {
  const [r, g, b] = rgb(hex);
  return ((a << 24) | (b << 16) | (g << 8) | r) >>> 0;
};

export function makeCanvas(w: number, h: number) {
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  const ctx = c.getContext("2d", { willReadFrequently: false })!;
  ctx.imageSmoothingEnabled = false;
  return { c, ctx };
}

export function R(ctx: Ctx, x: number, y: number, w: number, h: number, color: string) {
  ctx.fillStyle = color;
  ctx.fillRect(Math.round(x), Math.round(y), Math.round(w), Math.round(h));
}

export const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
export const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

/** Shaded wooden boards, in the warm style of the lagoon dock reference. */
export function planks(
  ctx: Ctx,
  x: number,
  y: number,
  w: number,
  h: number,
  seed: number,
  opts: { board?: number; vertical?: boolean; tones?: string[]; seam?: string; shine?: string } = {},
) {
  const r = rng(seed);
  const board = opts.board ?? 11;
  const vertical = opts.vertical ?? true;
  const tones = opts.tones ?? ["#e0955a", "#d98a4e", "#e6a069", "#cf8047", "#dd9358"];
  const seam = opts.seam ?? "#8f4e2c";
  const shine = opts.shine ?? "#f2b985";
  const span = vertical ? w : h;
  const long = vertical ? h : w;
  const put = (a: number, b: number, aw: number, bw: number, color: string) =>
    vertical ? R(ctx, x + a, y + b, aw, bw, color) : R(ctx, x + b, y + a, bw, aw, color);

  for (let a = 0; a < span; a += board) {
    const aw = Math.min(board, span - a);
    let b = -Math.floor(r() * 26);
    while (b < long) {
      const len = 26 + Math.floor(r() * 40);
      const b0 = Math.max(0, b);
      const b1 = Math.min(long, b + len);
      if (b1 > b0) {
        const tone = tones[Math.floor(r() * tones.length)];
        put(a, b0, aw, b1 - b0, tone);
        put(a, b0, 1, b1 - b0, shine);
        put(a + aw - 1, b0, 1, b1 - b0, seam);
        put(a, b1 - 1, aw, 1, seam);
        if (r() > 0.72) put(a + 3 + Math.floor(r() * Math.max(1, aw - 6)), b0 + 4 + Math.floor(r() * Math.max(1, b1 - b0 - 8)), 2, 1, seam);
        if (r() > 0.5) put(a + 2, b0 + 2 + Math.floor(r() * 5), Math.max(1, aw - 5), 1, tones[(Math.floor(r() * tones.length) + 1) % tones.length]);
      }
      b += len;
    }
  }
}

/** Golden thatch, one scanline at a time so roofs can taper to a ridge. */
export function thatchRow(ctx: Ctx, x: number, y: number, w: number, seed: number, shade: number) {
  const pal = ["#b9771f", "#d2932a", "#eab23d", "#f6c958", "#ffdf85"];
  for (let i = 0; i < w; i++) {
    const px = x + i;
    const stroke = fbm(px * 0.55, y * 0.13 + seed, 2);
    const clump = noise(px * 0.09 + seed, y * 0.42);
    const band = clamp(Math.floor((stroke * 0.65 + clump * 0.35 + shade + bayer(px, y) * 0.08) * 7 - 1.1), 0, 4);
    ctx.fillStyle = pal[band];
    ctx.fillRect(px, y, 1, 1);
  }
}

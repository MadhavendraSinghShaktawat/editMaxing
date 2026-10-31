import * as THREE from "three";
import { DECK, DOCK, HOUSE, landSdf, pathDistance } from "../world/layout";
import { clamp, fbm, noise } from "../world/pixel";

export const S = 0.1;
export const wx = (x: number) => (x - 390) * S;
export const wz = (y: number) => (y - 250) * S;
export const FLOOR_Y = 1.1;
export const DECK_Y = 0.72;

const smooth = (a: number, b: number, v: number) => {
  const t = clamp((v - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
};
const mix = (a: number, b: number, t: number) => a + (b - a) * t;

const RANGE = { x0: -90, y0: -130, x1: 880, y1: 620 };

const inTerrace = (x: number, y: number) => Math.hypot((x - 92) / 118, (y - 88) / 86) + (fbm(x / 24, y / 24, 2) - 0.5) * -0.45;

function terraceRow(x: number, y: number) {
  return (y + (fbm(x / 34, y / 22, 2) - 0.5) * 22) / 13;
}

export function terrainHeight(x: number, y: number) {
  const d = landSdf(x, y);
  if (d < 0) return Math.max(-2.6, d * 0.035);
  let h = Math.min(d * 0.03, 0.9) + (fbm(x / 62, y / 62, 3) - 0.42) * 2.1 * smooth(18, 80, d);
  const north = smooth(72, 0, y) * 2.6;
  h += north;

  const t = inTerrace(x, y);
  if (t < 1.08) {
    const stepped = 0.7 + (10 - Math.floor(terraceRow(x, y))) * 0.2;
    h = mix(stepped, h, smooth(0.86, 1.08, t));
  }

  const dx = Math.max(HOUSE.x - x, 0, x - (HOUSE.x + HOUSE.w));
  const dy = Math.max(HOUSE.y - y, 0, y - (HOUSE.y + HOUSE.h));
  const pad = (px: number, py: number, r: number) => smooth(r, r * 0.45, Math.hypot(x - px, y - py));
  const flat = Math.max(smooth(34, 6, Math.hypot(dx, dy)), pad(629, 200, 66), pad(138, 222, 62), pad(122, 316, 46));
  return mix(h, Math.min(0.55, Math.max(h, 0.35)), flat);
}

/** Where an editor's feet are. Decks and the villa sit above the terrain. */
export function groundY(x: number, y: number) {
  const on = (r: { x: number; y: number; w: number; h: number }) => x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h;
  if (on({ x: HOUSE.x - 3, y: HOUSE.y, w: HOUSE.w + 6, h: HOUSE.h + 2 })) return FLOOR_Y;
  if (on(DECK) || on(DOCK)) return DECK_Y;
  if (x > 368 && x < 398 && y >= 303 && y < 313) return mix(FLOOR_Y, DECK_Y, (y - 303) / 10);
  return Math.max(terrainHeight(x, y), 0);
}

type C = [number, number, number];
const hex = (s: string): C => {
  const n = parseInt(s.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
};
const lerpC = (a: C, b: C, t: number): C => [mix(a[0], b[0], t), mix(a[1], b[1], t), mix(a[2], b[2], t)];

const GRASS_DARK = hex("#a7a764");
const GRASS_MID = hex("#c9b870");
const GRASS_LIGHT = hex("#ecd088");
const GOLD = hex("#f2cf7e");
const SAND_WET = hex("#bd9460");
const SAND = hex("#f0d9a8");
const PATH_EDGE = hex("#c49a68");
const PATH = hex("#e8c996");
const RICE_A = hex("#3aa873");
const RICE_B = hex("#a9e07a");
const RICE_WATER = hex("#62cfc0");
const BANK = hex("#8a7a47");

export function terrainMesh() {
  const W = 1500;
  const H = Math.round((W * (RANGE.y1 - RANGE.y0)) / (RANGE.x1 - RANGE.x0));
  const canvas = document.createElement("canvas");
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext("2d")!;
  const img = ctx.createImageData(W, H);
  const px = img.data;

  for (let j = 0; j < H; j++) {
    const y = RANGE.y0 + ((j + 0.5) / H) * (RANGE.y1 - RANGE.y0);
    for (let i = 0; i < W; i++) {
      const x = RANGE.x0 + ((i + 0.5) / W) * (RANGE.x1 - RANGE.x0);
      const d = landSdf(x, y);
      const k = (j * W + i) * 4;
      if (d < -3) {
        px[k] = 190;
        px[k + 1] = 170;
        px[k + 2] = 120;
        px[k + 3] = 255;
        continue;
      }
      const fine = noise(x / 3.1, y / 3.1);
      const mid = fbm(x / 26, y / 26, 3);
      let c = lerpC(GRASS_DARK, GRASS_MID, smooth(0.3, 0.55, mid + fine * 0.14));
      c = lerpC(c, GRASS_LIGHT, smooth(0.5, 0.72, mid + fine * 0.2));
      c = lerpC(c, GOLD, smooth(0.6, 0.72, fbm(x / 44 + 9, y / 44, 2)) * 0.8);

      const t = inTerrace(x, y);
      if (t < 1) {
        const row = terraceRow(x, y);
        const f = row - Math.floor(row);
        let rice = lerpC(RICE_A, RICE_B, noise(x / 16, y / 7) * 0.8 + ((x + Math.floor(row) * 3) % 5 < 1.4 ? 0.2 : 0));
        if (Math.floor(row) % 3 === 0 && noise(x / 11, y / 4) > 0.5) rice = RICE_WATER;
        if (f > 0.84) rice = BANK;
        c = lerpC(c, rice, smooth(1, 0.94, t));
      }

      const path = pathDistance(x, y) + (noise(x / 8, y / 8) - 0.5) * 7;
      c = lerpC(c, lerpC(PATH_EDGE, PATH, smooth(9, 3, path) * (0.8 + fine * 0.2)), smooth(10, 7, path));

      const sand = 1 - smooth(9, 17, d + (fine - 0.5) * 3);
      if (sand > 0) c = lerpC(c, lerpC(SAND_WET, SAND, smooth(0, 7, d) * (0.85 + fine * 0.15)), sand);

      const grain = (fine - 0.5) * 5;
      px[k] = c[0] + grain;
      px[k + 1] = c[1] + grain;
      px[k + 2] = c[2] + grain;
      px[k + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);

  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;

  const wide = (RANGE.x1 - RANGE.x0) * S;
  const deep = (RANGE.y1 - RANGE.y0) * S;
  const geo = new THREE.PlaneGeometry(wide, deep, 300, 232);
  geo.rotateX(-Math.PI / 2);
  const pos = geo.attributes.position as THREE.BufferAttribute;
  const cx = (RANGE.x0 + RANGE.x1) / 2;
  const cy = (RANGE.y0 + RANGE.y1) / 2;
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i) / S + cx;
    const y = pos.getZ(i) / S + cy;
    pos.setY(i, terrainHeight(x, y));
  }
  geo.computeVertexNormals();
  const mesh = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ map: tex, roughness: 0.95 }));
  mesh.position.set(wx(cx), 0, wz(cy));
  mesh.receiveShadow = true;
  return mesh;
}

export function waterMesh() {
  const W = 512;
  const H = 386;
  const data = new Uint8Array(W * H);
  for (let j = 0; j < H; j++) {
    const y = RANGE.y0 + ((j + 0.5) / H) * (RANGE.y1 - RANGE.y0);
    for (let i = 0; i < W; i++) {
      const x = RANGE.x0 + ((i + 0.5) / W) * (RANGE.x1 - RANGE.x0);
      const d = -landSdf(x, y);
      const pool = (fbm(x / 62 + 3, y / 44 + 8, 3) - 0.5) * 0.5;
      data[j * W + i] = clamp((1 - d / 62 + pool) * 255, 0, 255);
    }
  }
  const depth = new THREE.DataTexture(data, W, H, THREE.RedFormat);
  depth.magFilter = THREE.LinearFilter;
  depth.minFilter = THREE.LinearFilter;
  depth.needsUpdate = true;

  const material = new THREE.ShaderMaterial({
    uniforms: {
      uTime: { value: 0 },
      uDepth: { value: depth },
      uLight: { value: new THREE.Color(1, 1, 1) },
      uBounds: { value: new THREE.Vector4(wx(RANGE.x0), wz(RANGE.y0), (RANGE.x1 - RANGE.x0) * S, (RANGE.y1 - RANGE.y0) * S) },
    },
    vertexShader: `
      varying vec3 vPos;
      void main() {
        vec4 w = modelMatrix * vec4(position, 1.0);
        vPos = w.xyz;
        gl_Position = projectionMatrix * viewMatrix * w;
      }`,
    fragmentShader: `
      uniform float uTime;
      uniform sampler2D uDepth;
      uniform vec3 uLight;
      uniform vec4 uBounds;
      varying vec3 vPos;

      float wave(vec2 p, float t) {
        return sin(p.x * 0.9 + t * 0.7 + sin(p.y * 0.7 - t * 0.4) * 1.6) * sin(p.y * 1.3 - t * 0.8 + sin(p.x * 0.5 + t * 0.3) * 1.8);
      }

      void main() {
        vec2 uv = vec2((vPos.x - uBounds.x) / uBounds.z, (vPos.z - uBounds.y) / uBounds.w);
        float s = texture2D(uDepth, uv).r;
        if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) s = 0.0;
        vec2 p = vPos.xz;
        float w1 = wave(p * 0.42, uTime * 0.6);
        float w2 = wave(p * 1.15 + 7.0, uTime * 0.8);
        float caustic = pow(1.0 - abs(w1 * 0.65 + w2 * 0.35), 7.0);

        vec3 deep = vec3(0.03, 0.2, 0.24);
        vec3 mid = vec3(0.07, 0.36, 0.36);
        vec3 shallow = vec3(0.32, 0.68, 0.56);
        vec3 col = mix(deep, mid, smoothstep(0.02, 0.5, s));
        col = mix(col, shallow, smoothstep(0.5, 0.98, s + w1 * 0.02));
        col += caustic * s * s * vec3(0.16, 0.22, 0.18);

        float ring = 0.95 + sin(uTime * 0.45 + p.x * 0.3 + p.y * 0.2) * 0.022;
        float foam = smoothstep(0.03, 0.0, abs(s - ring));
        col = mix(col, vec3(0.92, 0.95, 0.86), foam * 0.42);

        float glint = smoothstep(0.992, 1.0, sin(p.x * 9.0 + uTime * 1.1) * sin(p.y * 12.0 - uTime * 0.9));
        col += glint * 0.32 * vec3(1.0, 0.86, 0.6);

        gl_FragColor = vec4(col * uLight, 1.0);
      }`,
  });

  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(300, 240), material);
  mesh.rotation.x = -Math.PI / 2;
  mesh.position.set(0, -0.02, 0);
  return { mesh, material };
}

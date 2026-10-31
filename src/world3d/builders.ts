import * as THREE from "three";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import { RoundedBoxGeometry } from "three/addons/geometries/RoundedBoxGeometry.js";
import { DECK, DOCK, DOOR_H, DOOR_LEFT, DOOR_RIGHT, DOOR_V_BACK, DOOR_V_FRONT, HOUSE, STAIRS, WALL_X, WALL_Y, WORLD_H, WORLD_W, landSdf, pathDistance } from "../world/layout";
import { fbm, noise, rng } from "../world/pixel";
import { DECK_Y, FLOOR_Y, S, groundY, terrainHeight, wx, wz } from "./terrain";

export const swayTime = { value: 0 };

const tone = new THREE.Color();

/** Everything solid is merged into a few meshes, keeping draw calls low and the look unified. */
class Batch {
  private parts: THREE.BufferGeometry[] = [];
  private r: () => number;

  constructor(seed: number) {
    this.r = rng(seed);
  }

  add(g: THREE.BufferGeometry, color: string, jitter = 0.03, matrix?: THREE.Matrix4) {
    const geo = g.index ? g.toNonIndexed() : g;
    if (matrix) geo.applyMatrix4(matrix);
    const n = geo.attributes.position.count;
    const col = new Float32Array(n * 3);
    tone.set(color);
    const v = 1 + (this.r() - 0.5) * jitter * 2;
    for (let i = 0; i < n; i++) {
      col[i * 3] = tone.r * v;
      col[i * 3 + 1] = tone.g * v;
      col[i * 3 + 2] = tone.b * v;
    }
    geo.setAttribute("color", new THREE.BufferAttribute(col, 3));
    geo.deleteAttribute("uv");
    this.parts.push(geo);
  }

  /** Rounded box positioned in map pixels, the core building block of the villa. */
  box(x: number, y: number, w: number, d: number, y0: number, h: number, color: string, r = 0.07, jitter = 0.03) {
    const ww = w * S;
    const dd = d * S;
    const g = new RoundedBoxGeometry(ww, h, dd, 2, Math.min(r, Math.min(ww, h, dd) * 0.46));
    g.translate(wx(x + w / 2), y0 + h / 2, wz(y + d / 2));
    this.add(g, color, jitter);
  }

  cyl(x: number, y: number, r0: number, r1: number, y0: number, h: number, color: string, seg = 16) {
    const g = new THREE.CylinderGeometry(r0, r1, h, seg);
    g.translate(wx(x), y0 + h / 2, wz(y));
    this.add(g, color);
  }

  ball(x: number, y0: number, z: number, sx: number, sy: number, sz: number, color: string, jitter = 0.03) {
    const g = new THREE.SphereGeometry(1, 16, 12);
    g.scale(sx, sy, sz);
    g.translate(x, y0, z);
    this.add(g, color, jitter);
  }

  mesh(material?: THREE.Material) {
    const m = new THREE.Mesh(mergeGeometries(this.parts)!, material ?? new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.78 }));
    m.castShadow = true;
    m.receiveShadow = true;
    return m;
  }
}

function boards(b: Batch, x: number, y: number, w: number, d: number, y0: number, pal: string[], seed: number, boardPx = 10, alongX = false) {
  const r = rng(seed);
  const across = alongX ? d : w;
  const along = alongX ? w : d;
  const thick = 0.14;
  for (let a = 0; a < across; a += boardPx) {
    const bw = Math.min(boardPx, across - a) - 0.5;
    let p = -r() * 40;
    while (p < along) {
      const len = 48 + r() * 56;
      const s = Math.max(0, p);
      const e = Math.min(along, p + len);
      if (e - s > 4) {
        const c = pal[Math.floor(r() * pal.length)];
        if (alongX) b.box(x + s, y + a, e - s - 0.5, bw, y0, thick, c, 0.05, 0.05);
        else b.box(x + a, y + s, bw, e - s - 0.5, y0, thick, c, 0.05, 0.05);
      }
      p += len;
    }
  }
}

function tiles(b: Batch, x: number, y: number, w: number, d: number, y0: number, pal: string[], seed: number, size = 14) {
  const r = rng(seed);
  for (let j = 0; j < d; j += size) {
    for (let i = 0; i < w; i += size) {
      b.box(x + i, y + j, Math.min(size, w - i) - 0.7, Math.min(size, d - j) - 0.7, y0, 0.13, pal[Math.floor(r() * pal.length)], 0.06, 0.05);
    }
  }
}

/** Stacked rounded logs. The shadow lines between them are real geometry, not paint. */
function logs(b: Batch, x: number, y: number, w: number, d: number, y0: number, h: number, pal: string[]) {
  const courses = Math.max(2, Math.round(h / 0.34));
  const ch = h / courses;
  for (let i = 0; i < courses; i++) {
    b.box(x, y, w, d, y0 + i * ch, ch * 1.02, pal[i % pal.length], ch * 0.46, 0.04);
  }
}

const FLOOR_WALNUT = ["#a86a3c", "#9c6036", "#b37442", "#a46638"];
const FLOOR_HONEY = ["#d39350", "#c98848", "#dc9e5c", "#c58246"];
const FLOOR_BAMBOO = ["#e3bb78", "#dab06c", "#eac585", "#d3a862"];
const FLOOR_OAK = ["#c8975a", "#bd8c50", "#d2a266", "#b6864c"];
const TERRACOTTA = ["#d4845a", "#c97a52", "#dd9064", "#c4754d"];
const SLATE = ["#7f7a86", "#75707e", "#88838e", "#6f6a78"];
const DECK_WOOD = ["#d99558", "#cf8a4e", "#e2a064", "#c98348"];
const LOG = ["#8f5b38", "#855233", "#99643e"];
const LOG_DARK = ["#744628", "#6a3f24", "#7d4c2c"];

/** One soft, shaggy thatch face built on a grid, with layered rows and hand-laid streaks. */
function thatchFace(A: THREE.Vector3, B: THREE.Vector3, C: THREE.Vector3, D: THREE.Vector3, seed: number, rows = 7) {
  const nu = 48;
  const nv = 28;
  const pos: number[] = [];
  const col: number[] = [];
  const idx: number[] = [];
  const nrm = new THREE.Vector3().crossVectors(new THREE.Vector3().subVectors(B, A), new THREE.Vector3().subVectors(D, A)).normalize();
  if (nrm.y < 0) nrm.negate();
  const dark = new THREE.Color("#b98a44");
  const mid = new THREE.Color("#e6bc6a");
  const light = new THREE.Color("#ffe6a8");
  const c = new THREE.Color();
  const P = new THREE.Vector3();
  const Q = new THREE.Vector3();
  for (let j = 0; j <= nv; j++) {
    const v = j / nv;
    for (let i = 0; i <= nu; i++) {
      const u = i / nu;
      P.lerpVectors(A, B, u);
      Q.lerpVectors(D, C, u);
      P.lerp(Q, v);
      const row = (v * rows) % 1;
      const lip = Math.pow(row, 2.2);
      const shag = fbm(u * 26 + seed, v * 7, 2) - 0.5;
      P.addScaledVector(nrm, lip * 0.3 + shag * 0.16);
      const streak = fbm(u * 70 + seed * 3, v * 4, 2);
      c.copy(dark).lerp(mid, THREE.MathUtils.smoothstep(lip + (streak - 0.5) * 1.1, 0.02, 0.45));
      c.lerp(light, THREE.MathUtils.smoothstep(lip + (streak - 0.5) * 1.2, 0.55, 1));
      pos.push(P.x, P.y, P.z);
      col.push(c.r, c.g, c.b);
      if (i < nu && j < nv) {
        const k = j * (nu + 1) + i;
        idx.push(k, k + 1, k + nu + 1, k + 1, k + nu + 2, k + nu + 1);
      }
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute("color", new THREE.Float32BufferAttribute(col, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g.toNonIndexed();
}

function thatchMesh(faces: THREE.BufferGeometry[]) {
  faces.forEach((f) => f.computeVertexNormals());
  const m = new THREE.Mesh(mergeGeometries(faces)!, new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.92, side: THREE.DoubleSide }));
  m.castShadow = true;
  m.receiveShadow = true;
  return m;
}

function mainRoof() {
  const h = HOUSE;
  const x0 = wx(h.x - 13);
  const x1 = wx(h.x + h.w + 13);
  const eaveY = FLOOR_Y + 3.1;
  const eaveZ = wz(h.y - 4) + 1.1;
  const ridgeY = eaveY + 4.6;
  const ridgeZ = eaveZ - 8.4;
  const inset = 8;
  const backZ = ridgeZ - 8.4;
  const v = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);
  return thatchMesh([
    thatchFace(v(x0, eaveY, eaveZ), v(x1, eaveY, eaveZ), v(x1 - inset, ridgeY, ridgeZ), v(x0 + inset, ridgeY, ridgeZ), 1, 8),
    thatchFace(v(x1, eaveY, eaveZ), v(x1, eaveY, backZ), v(x1 - inset, ridgeY, ridgeZ), v(x1 - inset, ridgeY, ridgeZ), 2, 8),
    thatchFace(v(x0, eaveY, backZ), v(x0, eaveY, eaveZ), v(x0 + inset, ridgeY, ridgeZ), v(x0 + inset, ridgeY, ridgeZ), 3, 8),
  ]);
}

function hutRoof(x: number, y: number, w: number, d: number, y0: number) {
  const x0 = wx(x - 12);
  const x1 = wx(x + w + 12);
  const z0 = wz(y - 12);
  const z1 = wz(y + d + 12);
  const top = y0 + 3.5;
  const cx = (x0 + x1) / 2;
  const cz = (z0 + z1) / 2;
  const hw = (x1 - x0) * 0.1;
  const v = (a: number, b: number, c: number) => new THREE.Vector3(a, b, c);
  const L = v(cx - hw, top, cz);
  const R = v(cx + hw, top, cz);
  const s = x * 0.13;
  return thatchMesh([
    thatchFace(v(x0, y0, z1), v(x1, y0, z1), R, L, s, 5),
    thatchFace(v(x1, y0, z0), v(x0, y0, z0), L, R, s + 1, 5),
    thatchFace(v(x1, y0, z1), v(x1, y0, z0), R, R, s + 2, 5),
    thatchFace(v(x0, y0, z0), v(x0, y0, z1), L, L, s + 3, 5),
  ]);
}

function softRug(a: string, b: string) {
  const c = document.createElement("canvas");
  c.width = c.height = 512;
  const g = c.getContext("2d")!;
  g.fillStyle = a;
  g.fillRect(0, 0, 512, 512);
  g.strokeStyle = b;
  g.lineWidth = 16;
  g.strokeRect(36, 36, 440, 440);
  g.lineWidth = 5;
  g.strokeRect(64, 64, 384, 384);
  const r = rng(a.length * 13);
  for (let i = 0; i < 26000; i++) {
    g.fillStyle = r() > 0.5 ? "rgba(255,255,255,.035)" : "rgba(0,0,0,.035)";
    g.fillRect(r() * 512, r() * 512, 3, 1);
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}

function plant(b: Batch, x: number, y: number, base: number) {
  b.cyl(x, y, 0.34, 0.24, base, 0.46, "#c9764a");
  b.cyl(x, y, 0.3, 0.3, base + 0.44, 0.04, "#4a2f22");
  const r = rng(x * 7 + y);
  for (let i = 0; i < 11; i++) {
    const a = (i / 11) * 6.28 + r();
    const g = new THREE.SphereGeometry(0.2, 10, 8);
    g.scale(0.5, 2, 0.22);
    const m = new THREE.Matrix4().compose(
      new THREE.Vector3(wx(x) + Math.cos(a) * 0.3, base + 0.84 + r() * 0.3, wz(y) + Math.sin(a) * 0.3),
      new THREE.Quaternion().setFromEuler(new THREE.Euler(Math.sin(a) * 0.65, -a, -Math.cos(a) * 0.65)),
      new THREE.Vector3(1, 1, 1),
    );
    b.add(g, i % 2 ? "#3f9a6e" : "#2f8a62", 0.06, m);
  }
}

export type Screen = { ctx: CanvasRenderingContext2D; tex: THREE.CanvasTexture; station: string; w: number; h: number };

function wallScreen(parent: THREE.Object3D, b: Batch, screens: Screen[], station: string, x: number, y0: number, z: number, w: number, h: number) {
  const c = document.createElement("canvas");
  c.width = 384;
  c.height = Math.round((384 * h) / w);
  const ctx = c.getContext("2d")!;
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  const frame = new RoundedBoxGeometry(w + 0.22, h + 0.22, 0.14, 2, 0.06);
  frame.translate(wx(x), y0 + h / 2, z);
  b.add(frame, "#262030", 0);
  const panel = new THREE.Mesh(new THREE.PlaneGeometry(w, h), new THREE.MeshBasicMaterial({ map: tex }));
  panel.position.set(wx(x), y0 + h / 2, z + 0.08);
  parent.add(panel);
  screens.push({ ctx, tex, station, w: c.width, h: c.height });
}

function desk(b: Batch, parent: THREE.Object3D, x: number, y: number, w: number, d: number, laptop = true) {
  b.box(x, y, w, d, FLOOR_Y + 0.84, 0.16, "#b77a46", 0.05);
  for (const [lx, ly] of [
    [x + 1.5, y + 1.5],
    [x + w - 3.5, y + 1.5],
    [x + 1.5, y + d - 3.5],
    [x + w - 3.5, y + d - 3.5],
  ])
    b.box(lx, ly, 2, 2, FLOOR_Y, 0.86, "#7a4c2e", 0.04);
  if (laptop) {
    const cx = x + w / 2;
    b.box(cx - 7, y + 2, 14, 7, FLOOR_Y + 1, 0.05, "#c8ccd4", 0.02, 0);
    const lid = new RoundedBoxGeometry(1.4, 0.86, 0.05, 2, 0.02);
    const m = new THREE.Matrix4().compose(new THREE.Vector3(wx(cx), FLOOR_Y + 1.42, wz(y + 8.1)), new THREE.Quaternion().setFromEuler(new THREE.Euler(0.18, 0, 0)), new THREE.Vector3(1, 1, 1));
    b.add(lid, "#d4d7de", 0, m);
    const logo = new THREE.Mesh(new THREE.CircleGeometry(0.09, 16), new THREE.MeshBasicMaterial({ color: "#ffe9c4" }));
    logo.position.set(wx(cx), FLOOR_Y + 1.44, wz(y + 8.5));
    parent.add(logo);
    b.cyl(x + 5, y + 5, 0.13, 0.11, FLOOR_Y + 1, 0.24, "#f6f0e4");
  }
}

function bookcase(b: Batch, x: number, y: number, w: number, base: number) {
  b.box(x, y, w, 8, base, 3, "#6d4228", 0.06);
  const r = rng(x * 3);
  const tones = ["#c9673a", "#e0a53f", "#2f8d7f", "#e8dfc9", "#b4473a", "#7fae72", "#46709f", "#d98aa0"];
  for (let row = 0; row < 3; row++) {
    const by = base + 0.16 + row * 0.95;
    b.box(x + 0.6, y + 7.2, w - 1.2, 1.3, by - 0.08, 0.76, "#3b2418", 0.02, 0);
    let bx = x + 1.2;
    while (bx < x + w - 2.4) {
      const bw = 1.5 + r() * 2.2;
      const h = 0.46 + r() * 0.26;
      if (r() > 0.1) b.box(bx, y + 7.7, bw, 1.6, by, h, tones[Math.floor(r() * tones.length)], 0.03, 0.06);
      bx += bw + 0.3;
    }
  }
}

export type Lantern = { x: number; y: number; h: number; light?: THREE.PointLight; glow: THREE.MeshBasicMaterial };

function lantern(b: Batch, parent: THREE.Object3D, list: Lantern[], x: number, y: number, base: number, light: boolean) {
  b.box(x - 0.6, y - 0.6, 1.2, 1.2, base, 1.45, "#5d3622", 0.04);
  const glow = new THREE.MeshBasicMaterial({ color: "#ffd98a" });
  const orb = new THREE.Mesh(new THREE.SphereGeometry(0.22, 16, 12), glow);
  orb.position.set(wx(x), base + 1.66, wz(y));
  parent.add(orb);
  const entry: Lantern = { x, y, h: base + 1.66, glow };
  if (light) {
    const p = new THREE.PointLight("#ffb163", 0, 15, 1.8);
    p.position.copy(orb.position);
    parent.add(p);
    entry.light = p;
  }
  list.push(entry);
}

export function buildVilla(screens: Screen[], lanterns: Lantern[]) {
  const root = new THREE.Group();
  const b = new Batch(7);
  const h = HOUSE;

  b.box(h.x - 4, h.y - 2, h.w + 8, h.h + 6, 0, FLOOR_Y - 0.12, "#5b3a26", 0.1, 0);
  boards(b, h.x, h.y, 110, 87, FLOOR_Y - 0.14, FLOOR_WALNUT, 21);
  boards(b, h.x + 110, h.y, 110, 87, FLOOR_Y - 0.14, FLOOR_HONEY, 22);
  boards(b, h.x + 220, h.y, 110, 87, FLOOR_Y - 0.14, FLOOR_BAMBOO, 23, 7);
  boards(b, h.x, h.y + 87, 110, 89, FLOOR_Y - 0.14, FLOOR_OAK, 24, 10, true);
  tiles(b, h.x + 110, h.y + 87, 110, 89, FLOOR_Y - 0.14, TERRACOTTA, 25);
  tiles(b, h.x + 220, h.y + 87, 110, 89, FLOOR_Y - 0.14, SLATE, 26);

  for (let x = h.x + 8; x < h.x + h.w; x += 54) b.box(x, h.y + h.h + 3, 7, 4, -0.5, FLOOR_Y + 0.3, "#4d2f20", 0.08);

  // Walls
  const WALL = 3;
  const LOW = 1;
  const backZ = wz(h.y) - 0.36;
  logs(b, h.x - 3, h.y - 6, h.w + 6, 6, FLOOR_Y, WALL, LOG);
  for (const px of [h.x - 3, h.x + h.w - 1, 325, 435]) b.box(px - 1, h.y - 7, 6, 8, FLOOR_Y, WALL + 0.1, "#5f3a24", 0.1);
  for (const wxPx of [h.x + 165, h.x + 275]) {
    for (const dx of [-22, 8]) {
      const sky = new THREE.Mesh(new THREE.PlaneGeometry(1.2, 1), new THREE.MeshBasicMaterial({ color: "#ffe2a8" }));
      sky.position.set(wx(wxPx + dx + 6), FLOOR_Y + 2.34, backZ + 0.32);
      root.add(sky);
      b.box(wxPx + dx - 1, h.y - 0.5, 14, 0.9, FLOOR_Y + 1.74, 0.12, "#4a2a1b", 0.03);
      b.box(wxPx + dx - 1, h.y - 0.5, 14, 0.9, FLOOR_Y + 2.84, 0.12, "#4a2a1b", 0.03);
      b.box(wxPx + dx + 5.4, h.y - 0.5, 1.2, 0.9, FLOOR_Y + 1.8, 1.08, "#4a2a1b", 0.03);
    }
  }
  const seg = (x: number, a: number, e: number) => logs(b, x, a, 4, e - a, FLOOR_Y, LOW, LOG_DARK);
  seg(h.x - 4, h.y - 1, DOOR_LEFT.y0);
  seg(h.x - 4, DOOR_LEFT.y1, h.y + h.h);
  seg(h.x + h.w, h.y - 1, DOOR_RIGHT.y0);
  seg(h.x + h.w, DOOR_RIGHT.y1, h.y + h.h);
  for (const x of WALL_X) {
    seg(x - 2, h.y, DOOR_V_BACK.y0);
    seg(x - 2, DOOR_V_BACK.y1, WALL_Y);
    seg(x - 2, WALL_Y, DOOR_V_FRONT.y0);
    seg(x - 2, DOOR_V_FRONT.y1, h.y + h.h);
  }
  let from = h.x;
  for (const d of [...DOOR_H, { x0: h.x + h.w, x1: h.x + h.w }]) {
    if (d.x0 > from) logs(b, from, WALL_Y - 2, d.x0 - from, 4, FLOOR_Y, LOW, LOG_DARK);
    from = d.x1;
  }

  root.add(mainRoof());

  const rug = (x: number, y: number, w: number, d: number, a: string, c: string) => {
    const g = new RoundedBoxGeometry(w * S, 0.05, d * S, 2, 0.024);
    const m = new THREE.Mesh(g, new THREE.MeshStandardMaterial({ map: softRug(a, c), roughness: 1 }));
    m.position.set(wx(x + w / 2), FLOOR_Y + 0.03, wz(y + d / 2));
    m.receiveShadow = true;
    root.add(m);
  };
  rug(240, 164, 70, 34, "#2c7f78", "#e9cf98");
  rug(350, 174, 62, 28, "#c7683a", "#f0cd7c");
  rug(458, 174, 62, 28, "#6f5a9e", "#e9cf98");
  rug(238, 258, 70, 36, "#b95c49", "#f0d7aa");
  rug(350, 268, 66, 30, "#1f7a78", "#f0c264");
  rug(458, 258, 66, 36, "#3e5578", "#d9c7a0");

  // Library
  bookcase(b, 224, 122, 46, FLOOR_Y);
  bookcase(b, 272, 122, 46, FLOOR_Y);
  b.box(256, 170, 42, 16, FLOOR_Y + 0.78, 0.16, "#b77a46", 0.06);
  for (const [lx, ly] of [
    [258, 172],
    [293, 172],
    [258, 181],
    [293, 181],
  ])
    b.box(lx, ly, 3, 3, FLOOR_Y, 0.8, "#7a4c2e", 0.05);
  b.box(264, 174, 11, 8, FLOOR_Y + 0.93, 0.05, "#f6ebd2", 0.02);
  b.cyl(284, 178, 0.5, 0.5, FLOOR_Y + 0.94, 0.12, "#7f949c", 24);
  for (let i = 0; i < 3; i++) b.cyl(311, 194, 0.72, 0.72, FLOOR_Y + i * 0.27, 0.25, "#8ba0a8", 28);

  // Work rooms
  desk(b, root, 336, 160, 40, 10);
  desk(b, root, 386, 160, 40, 10);
  desk(b, root, 446, 160, 40, 10);
  desk(b, root, 496, 160, 40, 10);
  wallScreen(root, b, screens, "cutting", 381, FLOOR_Y + 0.42, backZ + 0.34, 5.8, 1.32);
  wallScreen(root, b, screens, "animation", 491, FLOOR_Y + 0.42, backZ + 0.34, 5.8, 1.32);

  b.box(528, 188, 2, 2, FLOOR_Y, 2.1, "#7a4c2e", 0.05);
  b.box(514, 186, 24, 1.4, FLOOR_Y + 0.9, 1.3, "#f6ebd2", 0.04);
  b.box(517, 185.5, 9, 0.6, FLOOR_Y + 1.08, 0.94, "#d9743a", 0.03);
  b.box(526, 185.5, 9, 0.6, FLOOR_Y + 1.08, 0.74, "#2f8d7f", 0.03);

  desk(b, root, 226, 241, 40, 10);
  desk(b, root, 280, 241, 40, 10);
  desk(b, root, 444, 241, 36, 10, false);
  desk(b, root, 506, 241, 36, 10, false);
  wallScreen(root, b, screens, "captions", 273, FLOOR_Y + 0.1, wz(WALL_Y) + 0.28, 3.6, 0.72);
  wallScreen(root, b, screens, "sound", 493, FLOOR_Y + 0.1, wz(WALL_Y) + 0.28, 3.6, 0.72);
  for (const sx of [450, 534]) {
    b.box(sx - 4, 218, 8, 7, FLOOR_Y, 1.5, "#2a2332", 0.1);
    b.cyl(sx, 225.3, 0.24, 0.24, FLOOR_Y + 0.75, 0.06, "#5a5270");
  }
  b.box(450, 243, 22, 6, FLOOR_Y + 1, 0.09, "#2f2a3b", 0.03);
  b.box(512, 243, 22, 6, FLOOR_Y + 1, 0.09, "#2f2a3b", 0.03);

  // Lounge
  b.box(332, 218, 28, 12, FLOOR_Y, 1, "#8a5230", 0.08);
  b.box(331, 217, 30, 14, FLOOR_Y + 1, 0.12, "#e6bb8a", 0.05);
  b.box(339, 220, 13, 8, FLOOR_Y + 1.12, 0.92, "#d6d2c6", 0.1);
  b.box(354, 262, 58, 8, FLOOR_Y, 0.56, "#c96f46", 0.18);
  b.box(354, 257, 58, 6, FLOOR_Y, 1.2, "#d67e58", 0.22);
  b.box(351, 257, 5, 13, FLOOR_Y, 0.86, "#c96f46", 0.2);
  b.box(410, 257, 5, 13, FLOOR_Y, 0.86, "#c96f46", 0.2);
  b.ball(wx(367), FLOOR_Y + 0.92, wz(265), 0.72, 0.42, 0.34, "#f0cb6a", 0);
  b.ball(wx(399), FLOOR_Y + 0.92, wz(265), 0.72, 0.42, 0.34, "#7fd0b4", 0);
  b.cyl(384, 283, 1.15, 1.15, FLOOR_Y + 0.32, 0.1, "#a86f42", 32);
  b.cyl(384, 283, 0.2, 0.3, FLOOR_Y, 0.32, "#6a4029");
  b.cyl(381, 282, 0.13, 0.11, FLOOR_Y + 0.42, 0.22, "#f6f0e4");

  plant(b, 424, 232, FLOOR_Y);
  plant(b, 228, 292, FLOOR_Y);
  plant(b, 534, 292, FLOOR_Y);
  plant(b, 322, 140, FLOOR_Y);

  // Deck, dock and stairs
  boards(b, DECK.x, DECK.y, DECK.w, DECK.h, DECK_Y - 0.14, DECK_WOOD, 37, 13);
  b.box(DECK.x + 2, DECK.y + 2, DECK.w - 4, DECK.h - 4, DECK_Y - 0.5, 0.36, "#4d2f20", 0.05, 0);
  for (let x = DECK.x + 5; x < DECK.x + DECK.w; x += 48) b.box(x, DECK.y + DECK.h - 6, 5, 5, -0.8, DECK_Y - 0.3, "#4d2f20", 0.08);
  boards(b, DOCK.x, DOCK.y, DOCK.w, DOCK.h, DECK_Y - 0.14, DECK_WOOD, 41, 9, true);
  b.box(DOCK.x + 3, DOCK.y, DOCK.w - 6, DOCK.h, DECK_Y - 0.42, 0.3, "#4d2f20", 0.05, 0);
  for (const py of [DOCK.y + 24, DOCK.y + 58, DOCK.y + DOCK.h - 3]) {
    b.cyl(DOCK.x - 1, py, 0.22, 0.26, -0.8, DECK_Y + 1.1, "#5d3a26");
    b.cyl(DOCK.x + DOCK.w + 1, py, 0.22, 0.26, -0.8, DECK_Y + 1.1, "#5d3a26");
  }
  for (let i = 0; i < 4; i++) b.box(STAIRS.x0 - 1, h.y + h.h + i * 2.4, STAIRS.x1 - STAIRS.x0 + 2, 3, 0.1, FLOOR_Y - 0.1 - i * 0.13, "#c98348", 0.05, 0.02);

  b.cyl(324, 327, 0.5, 0.42, DECK_Y, 0.72, "#b6cdd3", 20);
  b.cyl(345, 325, 0.72, 0.56, DECK_Y, 0.66, "#b98a4e", 20);
  b.box(442, 322, 20, 8, DECK_Y + 0.42, 0.14, "#b4773f", 0.05);
  b.box(444, 324, 3, 4, DECK_Y, 0.42, "#5d3622", 0.05);
  b.box(457, 324, 3, 4, DECK_Y, 0.42, "#5d3622", 0.05);

  lantern(b, root, lanterns, 306, 318, DECK_Y, true);
  lantern(b, root, lanterns, 470, 318, DECK_Y, true);
  lantern(b, root, lanterns, DOCK.x + 1, DOCK.y + 72, DECK_Y, false);

  for (const [x, y] of [
    [272, 172],
    [381, 190],
    [491, 190],
    [272, 280],
    [384, 240],
    [491, 280],
  ]) {
    const glow = new THREE.MeshBasicMaterial({ color: "#ffd98a" });
    const orb = new THREE.Mesh(new THREE.SphereGeometry(0.18, 16, 12), glow);
    orb.position.set(wx(x), FLOOR_Y + 2.9, wz(y));
    root.add(orb);
    const p = new THREE.PointLight("#ffb163", 0, 19, 1.7);
    p.position.copy(orb.position);
    root.add(p);
    lanterns.push({ x, y, h: FLOOR_Y + 2.9, glow, light: p });
  }
  root.add(b.mesh());
  return root;
}

export function buildHuts(screens: Screen[], lanterns: Lantern[]) {
  const root = new THREE.Group();
  const b = new Batch(11);
  const y = 0.5;

  // Render Shed
  logs(b, 592, 166, 74, 46, y, 2.6, LOG);
  b.box(600, 212, 24, 4, y, 2.1, "#262030", 0.06);
  for (let row = 0; row < 4; row++) b.box(602, 215.6, 20, 0.6, y + 0.3 + row * 0.44, 0.2, "#3f3a4c", 0.03);
  wallScreen(root, b, screens, "render", 646, y + 0.5, wz(212) + 0.14, 3, 1.5);
  root.add(hutRoof(590, 164, 78, 50, y + 2.5));
  b.box(656, 160, 9, 9, y + 2.4, 3.6, "#8c8376", 0.12);

  // Review Bale
  b.box(104, 196, 68, 44, 0, y + 0.1, "#5b3a26", 0.1);
  boards(b, 104, 196, 68, 44, y + 0.1, DECK_WOOD, 52, 11);
  for (const [px, py] of [
    [106, 198],
    [166, 198],
    [106, 234],
    [166, 234],
  ])
    b.box(px, py, 4, 4, y + 0.2, 3.1, "#6b3f27", 0.08);
  wallScreen(root, b, screens, "review", 138, y + 0.9, wz(200), 4, 2);
  root.add(hutRoof(104, 196, 68, 44, y + 3.3));

  lantern(b, root, lanterns, 182, 246, 0.5, false);
  lantern(b, root, lanterns, 576, 226, 0.5, true);

  const fabric = new THREE.Group();
  const cloth = new THREE.MeshStandardMaterial({ color: "#d9743a", roughness: 0.9 });
  const stripe = new THREE.MeshStandardMaterial({ color: "#f0cb6a", roughness: 0.9 });
  for (let i = 0; i < 18; i++) {
    const u = i / 17;
    const seg = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.08, 1.15), i % 3 ? cloth : stripe);
    seg.position.set(wx(100 + u * 46), 1.45 - Math.sin(u * Math.PI) * 0.72, wz(316));
    seg.castShadow = true;
    fabric.add(seg);
  }
  root.add(fabric);
  b.box(94, 314, 3, 3, 0.3, 1.6, "#6b3f27", 0.05);
  b.box(150, 314, 3, 3, 0.3, 1.6, "#6b3f27", 0.05);
  root.add(b.mesh());
  return { root, hammock: fabric };
}

function swayMaterial(base: THREE.MeshStandardMaterial, strength: number) {
  base.onBeforeCompile = (shader) => {
    shader.uniforms.uSway = swayTime;
    shader.vertexShader = shader.vertexShader.replace("#include <common>", "#include <common>\nuniform float uSway;").replace(
      "#include <begin_vertex>",
      `#include <begin_vertex>
       #ifdef USE_INSTANCING
         float sway = instanceMatrix[3][0] * 0.6 + instanceMatrix[3][2] * 0.45;
         float reach = max(position.y, 0.0);
         float gust = sin(uSway * 0.7 + sway * 0.3) * 0.6 + 0.6;
         transformed.x += (sin(uSway * 1.5 + sway) * 0.6 + gust) * ${strength.toFixed(4)} * reach * reach;
         transformed.z += cos(uSway * 1.1 + sway) * ${(strength * 0.6).toFixed(4)} * reach * reach;
       #endif`,
    );
  };
  return base;
}

/** Soft rounded foliage with painterly blotches, instead of hard facets. */
function foliage(cx: number, cy: number, cz: number, rad: number, dark: THREE.Color, mid: THREE.Color, light: THREE.Color, seed: number) {
  const g = new THREE.IcosahedronGeometry(1, 4);
  const p = g.attributes.position as THREE.BufferAttribute;
  const n = g.attributes.normal as THREE.BufferAttribute;
  const col = new Float32Array(p.count * 3);
  const c = new THREE.Color();
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i);
    const y = p.getY(i);
    const z = p.getZ(i);
    const bump = 1 + (fbm(x * 2 + seed, y * 2 + z * 2, 2) - 0.5) * 0.3;
    p.setXYZ(i, cx + x * rad * bump, cy + y * rad * bump * 0.92, cz + z * rad * bump);
    n.setXYZ(i, x, y, z);
    const blot = fbm(x * 3.4 + seed * 2, y * 3.4 - z * 3.4, 2);
    const lit = y * 0.42 + 0.5;
    c.copy(dark).lerp(mid, THREE.MathUtils.smoothstep(lit + (blot - 0.5) * 0.9, 0.22, 0.5));
    c.lerp(light, THREE.MathUtils.smoothstep(lit + (blot - 0.5) * 1.1, 0.58, 0.82));
    col[i * 3] = c.r;
    col[i * 3 + 1] = c.g;
    col[i * 3 + 2] = c.b;
  }
  g.setAttribute("color", new THREE.BufferAttribute(col, 3));
  g.deleteAttribute("uv");
  return g;
}

function solid(g: THREE.BufferGeometry, color: string) {
  const geo = g.index ? g.toNonIndexed() : g;
  const n = geo.attributes.position.count;
  const c = new Float32Array(n * 3);
  tone.set(color);
  for (let i = 0; i < n; i++) {
    c[i * 3] = tone.r;
    c[i * 3 + 1] = tone.g;
    c[i * 3 + 2] = tone.b;
  }
  geo.setAttribute("color", new THREE.BufferAttribute(c, 3));
  geo.deleteAttribute("uv");
  return geo;
}

function roundTree(pal: [string, string, string], seed: number, small = false) {
  const [d, m, l] = pal.map((v) => new THREE.Color(v));
  const parts: THREE.BufferGeometry[] = [];
  const trunk = new THREE.CylinderGeometry(0.18, 0.34, 2.4, 10);
  trunk.translate(0, 1.2, 0);
  parts.push(solid(trunk, "#6d4a30"));
  const s = small ? 0.76 : 1;
  const blobs: [number, number, number, number][] = [
    [0, 3.4, 0, 1.95],
    [-1.25, 2.85, 0.35, 1.3],
    [1.22, 2.95, -0.25, 1.35],
    [0.25, 2.8, 1.1, 1.22],
    [-0.15, 4.6, -0.15, 1.2],
  ];
  blobs.forEach(([x, y, z, r], i) => {
    const f = foliage(x * s, y * s + (small ? 0.4 : 0), z * s, r * s, d, m, l, seed + i);
    parts.push(f.index ? f.toNonIndexed() : f);
  });
  return mergeGeometries(parts)!;
}

function palmTree(seed: number, lean: number) {
  const r = rng(seed);
  const parts: THREE.BufferGeometry[] = [];
  const pts: THREE.Vector3[] = [];
  for (let i = 0; i <= 8; i++) {
    const t = i / 8;
    pts.push(new THREE.Vector3(lean * t * t, t * 6.2, 0));
  }
  parts.push(solid(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts), 12, 0.2, 10), "#a07a54"));
  const top = pts[pts.length - 1];
  for (let f = 0; f < 11; f++) {
    const a = (f / 11) * Math.PI * 2 + r() * 0.3;
    const len = 3 + r() * 0.9;
    const seg = 9;
    const v: number[] = [];
    const nrm: number[] = [];
    const idx: number[] = [];
    const cx = Math.cos(a);
    const cz = Math.sin(a);
    for (let i = 0; i <= seg; i++) {
      const u = i / seg;
      const out = u * len;
      const drop = 0.3 + u * 0.5 - u * u * 2.3;
      const width = Math.sin(Math.min(1, u * 1.1) * Math.PI) * 0.56 + 0.02;
      v.push(top.x + cx * out - cz * width, top.y + drop - 0.16, top.z + cz * out + cx * width);
      v.push(top.x + cx * out, top.y + drop + 0.08, top.z + cz * out);
      v.push(top.x + cx * out + cz * width, top.y + drop - 0.16, top.z + cz * out - cx * width);
      nrm.push(-cz * 0.5, 0.85, cx * 0.5, 0, 1, 0, cz * 0.5, 0.85, -cx * 0.5);
      if (i < seg) {
        const k = i * 3;
        idx.push(k, k + 3, k + 1, k + 1, k + 3, k + 4, k + 1, k + 4, k + 2, k + 2, k + 4, k + 5);
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.Float32BufferAttribute(v, 3));
    g.setAttribute("normal", new THREE.Float32BufferAttribute(nrm, 3));
    g.setIndex(idx);
    parts.push(solid(g, f % 2 ? "#6db07c" : "#559e72"));
  }
  return mergeGeometries(parts)!;
}

export type TreeSpot = { x: number; y: number; r: number };

const nearBuilding = (x: number, y: number) => {
  if (x > HOUSE.x - 34 && x < HOUSE.x + HOUSE.w + 34 && y > 30 && y < HOUSE.y + HOUSE.h + 28) return true;
  if (x > 574 && x < 696 && y > 150 && y < 244) return true;
  if (x > 92 && x < 186 && y > 184 && y < 256) return true;
  if (x > 86 && x < 160 && y > 296 && y < 332) return true;
  return false;
};

export function buildForest() {
  const r = rng(2026);
  const kinds: { geo: THREE.BufferGeometry; spots: { x: number; y: number; s: number }[] }[] = [
    { geo: roundTree(["#a65328", "#e8893c", "#ffc978"], 3), spots: [] },
    { geo: roundTree(["#a8702a", "#e8ad44", "#ffe28c"], 7), spots: [] },
    { geo: roundTree(["#3f7350", "#6fa862", "#c9de92"], 4), spots: [] },
    { geo: roundTree(["#8a4f6a", "#e49ab0", "#ffdcdc"], 5, true), spots: [] },
    { geo: palmTree(1, 0.9), spots: [] },
    { geo: palmTree(2, -0.8), spots: [] },
  ];

  const blocked = (x: number, y: number) => nearBuilding(x, y) || (x > HOUSE.x - 46 && x < HOUSE.x + HOUSE.w + 46 && y > -30 && y < HOUSE.y) || Math.hypot((x - 92) / 110, (y - 88) / 78) < 1;

  const placed: [number, number][] = [];
  for (let i = 0; i < 2600 && placed.length < 110; i++) {
    const x = -70 + r() * (WORLD_W + 150);
    const y = -110 + r() * (WORLD_H + 120);
    const d = landSdf(x, y);
    if (d < 10 || blocked(x, y) || pathDistance(x, y) < 13) continue;
    const dense = y < 50 || x < 26 || x > WORLD_W - 26;
    const gap = dense ? 30 : 56;
    if (placed.some(([px, py]) => Math.hypot(px - x, (py - y) * 1.2) < gap)) continue;
    placed.push([x, y]);
    const s = 0.86 + r() * 0.44;
    const pick = r();
    if (d < 34 && pick < 0.7) kinds[4 + Math.floor(r() * 2)].spots.push({ x, y, s });
    else kinds[pick < 0.32 ? 0 : pick < 0.6 ? 1 : pick < 0.78 ? 3 : 2].spots.push({ x, y, s });
  }
  const hand: [number, number, number][] = [
    [186, 312, 0],
    [62, 318, 4],
    [172, 340, 5],
    [566, 322, 4],
    [596, 326, 3],
    [194, 122, 1],
    [572, 112, 0],
    [702, 448, 4],
    [668, 442, 5],
    [60, 452, 5],
    [28, 438, 3],
    [692, 322, 1],
  ];
  for (const [x, y, k] of hand) kinds[k].spots.push({ x, y, s: 1.05 });

  const root = new THREE.Group();
  const spots: TreeSpot[] = [];
  const material = swayMaterial(new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.86, side: THREE.DoubleSide }), 0.0011);
  const m4 = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const up = new THREE.Vector3(0, 1, 0);
  for (const k of kinds) {
    if (!k.spots.length) continue;
    const inst = new THREE.InstancedMesh(k.geo, material, k.spots.length);
    k.spots.forEach((s, i) => {
      q.setFromAxisAngle(up, r() * 6.28);
      m4.compose(new THREE.Vector3(wx(s.x), Math.max(terrainHeight(s.x, s.y), 0) - 0.08, wz(s.y)), q, new THREE.Vector3(s.s, s.s, s.s));
      inst.setMatrixAt(i, m4);
      spots.push({ x: s.x, y: s.y, r: 24 * s.s });
    });
    inst.castShadow = true;
    inst.receiveShadow = true;
    root.add(inst);
  }
  return { root, spots };
}

function bladeTuft() {
  const v: number[] = [];
  const n: number[] = [];
  const c: number[] = [];
  const idx: number[] = [];
  const r = rng(9);
  const low = new THREE.Color("#c9b98f");
  const high = new THREE.Color("#ffffff");
  for (let b = 0; b < 5; b++) {
    const a = r() * 6.28;
    const ox = (r() - 0.5) * 0.34;
    const oz = (r() - 0.5) * 0.34;
    const dx = Math.cos(a);
    const dz = Math.sin(a);
    const h = 0.62 + r() * 0.4;
    const bend = 0.14 + r() * 0.16;
    const start = v.length / 3;
    for (let i = 0; i <= 3; i++) {
      const t = i / 3;
      const w = 0.085 * (1 - t * t);
      const px = ox + dx * bend * t * t;
      const pz = oz + dz * bend * t * t;
      v.push(px - dz * w, h * t, pz + dx * w, px + dz * w, h * t, pz - dx * w);
      n.push(0.05, 1, 0.05, 0.05, 1, 0.05);
      const col = low.clone().lerp(high, Math.sqrt(t));
      c.push(col.r, col.g, col.b, col.r, col.g, col.b);
      if (i < 3) {
        const k = start + i * 2;
        idx.push(k, k + 1, k + 2, k + 1, k + 3, k + 2);
      }
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(v, 3));
  g.setAttribute("normal", new THREE.Float32BufferAttribute(n, 3));
  g.setAttribute("color", new THREE.Float32BufferAttribute(c, 3));
  g.setIndex(idx);
  return g;
}

/** Dense golden grass, wildflowers and mossy boulders, the heart of the reference look. */
export function buildMeadow() {
  const root = new THREE.Group();
  const r = rng(404);
  const spots: { x: number; y: number; h: number; s: number; rot: number; c: THREE.Color }[] = [];
  const amber = new THREE.Color("#ffdc8a");
  const honey = new THREE.Color("#f5c470");
  const olive = new THREE.Color("#d6d184");
  const fresh = new THREE.Color("#b8cf80");

  for (let i = 0; i < 90000 && spots.length < 24000; i++) {
    const x = -70 + r() * (WORLD_W + 150);
    const y = -100 + r() * (WORLD_H + 110);
    const d = landSdf(x, y);
    if (d < 13 || nearBuilding(x, y)) continue;
    if (Math.hypot((x - 92) / 118, (y - 88) / 86) < 1.04) continue;
    const path = pathDistance(x, y);
    if (path < 7 + noise(x / 9, y / 9) * 5) continue;
    const patch = fbm(x / 34, y / 34, 2);
    if (patch < 0.38 && r() > 0.25) continue;
    const warm = fbm(x / 70 + 4, y / 70, 2);
    const c = (warm > 0.5 ? honey : olive).clone().lerp(warm > 0.5 ? amber : fresh, r());
    spots.push({ x, y, h: Math.max(terrainHeight(x, y), 0.02), s: 0.8 + patch * 1.1 + r() * 0.4, rot: r() * 6.28, c });
  }
  const mat = swayMaterial(new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.9, side: THREE.DoubleSide }), 0.16);
  const grass = new THREE.InstancedMesh(bladeTuft(), mat, spots.length);
  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const up = new THREE.Vector3(0, 1, 0);
  spots.forEach((s, i) => {
    q.setFromAxisAngle(up, s.rot);
    m.compose(new THREE.Vector3(wx(s.x), s.h - 0.02, wz(s.y)), q, new THREE.Vector3(s.s, s.s * (0.9 + (i % 5) * 0.08), s.s));
    grass.setMatrixAt(i, m);
    grass.setColorAt(i, s.c);
  });
  grass.receiveShadow = true;
  root.add(grass);

  // Lavender spikes and pale daisies grow in soft drifts.
  const spike: THREE.BufferGeometry[] = [];
  for (let i = 0; i < 9; i++) {
    const s = new THREE.SphereGeometry(0.09 - i * 0.006, 6, 5);
    s.translate(Math.sin(i * 2.4) * 0.05, 0.42 + i * 0.1, Math.cos(i * 2.4) * 0.05);
    spike.push(solid(s, i % 2 ? "#c79ae0" : "#dcb8ee"));
  }
  const stem = new THREE.CylinderGeometry(0.015, 0.02, 0.5, 5);
  stem.translate(0, 0.25, 0);
  spike.push(solid(stem.clone(), "#6f9a52"));
  const lavender = mergeGeometries(spike)!;
  const petals = new THREE.SphereGeometry(0.17, 12, 8);
  petals.scale(1, 0.22, 1);
  petals.translate(0, 0.52, 0);
  const heart = new THREE.SphereGeometry(0.06, 8, 6);
  heart.translate(0, 0.56, 0);
  const daisy = mergeGeometries([solid(stem.clone(), "#7fa35a"), solid(petals, "#f6e2ee"), solid(heart, "#f0b63c")])!;

  const flowerMat = swayMaterial(new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.75 }), 0.1);
  for (const [geo, want, scale] of [
    [lavender, 900, 1.5],
    [daisy, 700, 1.15],
  ] as const) {
    const list: THREE.Matrix4[] = [];
    for (let i = 0; i < 12000 && list.length < want; i++) {
      const x = -60 + r() * (WORLD_W + 120);
      const y = -80 + r() * (WORLD_H + 80);
      if (landSdf(x, y) < 15 || nearBuilding(x, y) || pathDistance(x, y) < 11) continue;
      if (noise(x / 40 + scale * 9, y / 40) < 0.6) continue;
      const k = scale * (0.8 + r() * 0.6);
      q.setFromAxisAngle(up, r() * 6.28);
      list.push(new THREE.Matrix4().compose(new THREE.Vector3(wx(x), Math.max(terrainHeight(x, y), 0), wz(y)), q, new THREE.Vector3(k, k, k)));
    }
    const inst = new THREE.InstancedMesh(geo, flowerMat, list.length);
    list.forEach((v, i) => inst.setMatrixAt(i, v));
    root.add(inst);
  }

  // Mossy boulders.
  const stone = new THREE.Color("#a7a196");
  const moss = new THREE.Color("#7f9a56");
  const boulder = (x: number, y: number, rad: number, seed: number) => {
    const g = new THREE.IcosahedronGeometry(1, 3);
    const p = g.attributes.position as THREE.BufferAttribute;
    const col = new Float32Array(p.count * 3);
    const c = new THREE.Color();
    for (let i = 0; i < p.count; i++) {
      const vx = p.getX(i);
      const vy = p.getY(i);
      const vz = p.getZ(i);
      const b = 1 + (fbm(vx * 1.6 + seed, vy * 1.6 + vz, 2) - 0.5) * 0.4;
      p.setXYZ(i, wx(x) + vx * rad * b, Math.max(terrainHeight(x, y), 0) + vy * rad * 0.74 * b + rad * 0.34, wz(y) + vz * rad * b);
      c.copy(stone).lerp(moss, THREE.MathUtils.smoothstep(vy + (fbm(vx * 3 + seed, vz * 3, 2) - 0.5) * 1.2, 0.05, 0.42));
      col[i * 3] = c.r;
      col[i * 3 + 1] = c.g;
      col[i * 3 + 2] = c.b;
    }
    g.computeVertexNormals();
    g.setAttribute("color", new THREE.BufferAttribute(col, 3));
    g.deleteAttribute("uv");
    return g;
  };
  const parts: THREE.BufferGeometry[] = [];
  for (let i = 0; i < 600 && parts.length < 26; i++) {
    const x = -40 + r() * (WORLD_W + 80);
    const y = -60 + r() * (WORLD_H + 40);
    if (landSdf(x, y) < 16 || nearBuilding(x, y) || pathDistance(x, y) < 14) continue;
    parts.push(boulder(x, y, 0.7 + r() * 1.1, i));
  }
  const boulders = new THREE.Mesh(mergeGeometries(parts)!, new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.95 }));
  boulders.castShadow = true;
  boulders.receiveShadow = true;
  root.add(boulders);
  return root;
}

export function buildLilies() {
  const r = rng(77);
  const root = new THREE.Group();
  const leaves: THREE.BufferGeometry[] = [];
  for (let i = 0; i < 40; i++) {
    const x = 180 + r() * 440;
    const y = 364 + r() * 124;
    if (landSdf(x, y) > -9 || (x > 366 && x < 418 && y < 456)) continue;
    const rad = 0.55 + r() * 0.7;
    const g = new THREE.CylinderGeometry(rad, rad, 0.04, 28, 1, false, 0.3, Math.PI * 2 - 0.5);
    g.rotateY(r() * 6.28);
    g.translate(wx(x), 0.05, wz(y));
    leaves.push(solid(g, r() > 0.5 ? "#7fbf66" : "#5fa860"));
    if (r() > 0.6) {
      const b = new THREE.SphereGeometry(0.2, 10, 8);
      b.scale(1, 0.7, 1);
      b.translate(wx(x), 0.18, wz(y));
      leaves.push(solid(b, "#ffc4d6"));
    }
  }
  const mesh = new THREE.Mesh(mergeGeometries(leaves)!, new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.5 }));
  mesh.receiveShadow = true;
  mesh.castShadow = true;
  root.add(mesh);
  return root;
}

export function buildBoat() {
  const g = new THREE.Group();
  g.scale.setScalar(1.4);
  const std = (color: string, roughness = 0.6) => new THREE.MeshStandardMaterial({ color, roughness });
  const hull = new THREE.Mesh(new THREE.CapsuleGeometry(0.9, 4.2, 8, 20), std("#a4582f"));
  hull.rotation.z = Math.PI / 2;
  hull.scale.set(0.62, 1, 1);
  hull.position.y = 0.34;
  hull.castShadow = true;
  g.add(hull);
  const trim = new THREE.Mesh(new THREE.TorusGeometry(1, 0.06, 10, 40), std("#f0b63c", 0.4));
  trim.rotation.x = Math.PI / 2;
  trim.scale.set(3.05, 0.9, 1);
  trim.position.y = 0.76;
  g.add(trim);
  const deck = new THREE.Mesh(new RoundedBoxGeometry(4.6, 0.1, 1.5, 2, 0.04), std("#d9985f", 0.65));
  deck.position.y = 0.76;
  g.add(deck);
  for (const [x, c] of [
    [1.6, "#b98a4e"],
    [2.2, "#e9e0c9"],
  ] as const) {
    const crate = new THREE.Mesh(new RoundedBoxGeometry(0.6, 0.6, 0.6, 2, 0.05), std(c));
    crate.position.set(x, 1.1, 0);
    crate.castShadow = true;
    g.add(crate);
  }
  const roof = new THREE.Mesh(new RoundedBoxGeometry(2.9, 0.16, 1.7, 2, 0.07), std("#e2ae48", 0.8));
  roof.position.set(-1.2, 2.5, 0);
  roof.castShadow = true;
  g.add(roof);
  for (const x of [-2.5, 0.1]) {
    for (const z of [-0.7, 0.7]) {
      const post = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, 1.8), std("#6a4029"));
      post.position.set(x, 1.6, z);
      g.add(post);
    }
  }
  return g;
}

export function buildCat() {
  const g = new THREE.Group();
  const fur = new THREE.MeshStandardMaterial({ color: "#1c1820", roughness: 0.42 });
  const eye = new THREE.MeshBasicMaterial({ color: "#ffb04c" });
  const add = (geo: THREE.BufferGeometry, m: THREE.Material, x: number, y: number, z: number, sx = 1, sy = sx, sz = sx) => {
    const v = new THREE.Mesh(geo, m);
    v.position.set(x, y, z);
    v.scale.set(sx, sy, sz);
    v.castShadow = true;
    g.add(v);
    return v;
  };
  const ball = new THREE.SphereGeometry(1, 20, 16);
  add(ball, fur, 0, 0.42, -0.1, 0.46, 0.46, 0.58);
  add(ball, fur, 0, 0.8, 0.38, 0.4);
  const ear = new THREE.ConeGeometry(0.15, 0.28, 8);
  add(ear, fur, -0.23, 1.18, 0.38);
  add(ear, fur, 0.23, 1.18, 0.38);
  add(ball, eye, -0.15, 0.84, 0.72, 0.09, 0.1, 0.05);
  add(ball, eye, 0.15, 0.84, 0.72, 0.09, 0.1, 0.05);
  const tail = new THREE.Group();
  const pts = [new THREE.Vector3(0, 0, 0), new THREE.Vector3(0.14, 0.2, -0.3), new THREE.Vector3(0.08, 0.62, -0.46), new THREE.Vector3(-0.08, 0.8, -0.36)];
  const t = new THREE.Mesh(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts), 12, 0.07, 8), fur);
  t.castShadow = true;
  tail.add(t);
  tail.position.set(0, 0.34, -0.55);
  g.add(tail);
  g.scale.setScalar(1.05);
  return { group: g, tail };
}

export function buildDuck() {
  const g = new THREE.Group();
  const white = new THREE.MeshStandardMaterial({ color: "#fff8ea", roughness: 0.6 });
  const ball = new THREE.SphereGeometry(1, 14, 12);
  const body = new THREE.Mesh(ball, white);
  body.scale.set(0.34, 0.24, 0.48);
  body.position.y = 0.16;
  g.add(body);
  const head = new THREE.Mesh(ball, white);
  head.scale.setScalar(0.17);
  head.position.set(0, 0.46, 0.3);
  g.add(head);
  const bill = new THREE.Mesh(new THREE.ConeGeometry(0.06, 0.2, 8), new THREE.MeshStandardMaterial({ color: "#ef9a2e", roughness: 0.5 }));
  bill.rotation.x = Math.PI / 2;
  bill.position.set(0, 0.44, 0.52);
  g.add(bill);
  g.traverse((o) => (o.castShadow = true));
  g.scale.setScalar(1.3);
  return g;
}

export { groundY };

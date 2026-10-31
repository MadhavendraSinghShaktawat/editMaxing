import { WORLD_H, WORLD_W, walkable } from "./layout";

const TILE = 6;
const COLS = Math.floor(WORLD_W / TILE);
const ROWS = Math.floor(WORLD_H / TILE);
let grid: Uint8Array | null = null;

function buildGrid() {
  const g = new Uint8Array(COLS * ROWS);
  for (let y = 0; y < ROWS; y++) {
    for (let x = 0; x < COLS; x++) {
      g[y * COLS + x] = walkable(x * TILE + 3, y * TILE + 3) ? 1 : 0;
    }
  }
  return g;
}

function nearestOpen(g: Uint8Array, cx: number, cy: number) {
  for (let r = 0; r < 12; r++) {
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        const x = cx + dx;
        const y = cy + dy;
        if (x >= 0 && y >= 0 && x < COLS && y < ROWS && g[y * COLS + x]) return y * COLS + x;
      }
    }
  }
  return -1;
}

const NEIGHBOURS = [
  [1, 0, 1],
  [-1, 0, 1],
  [0, 1, 1],
  [0, -1, 1],
  [1, 1, 1.42],
  [-1, 1, 1.42],
  [1, -1, 1.42],
  [-1, -1, 1.42],
];

/** A* over a coarse walk grid. Returns world points ending exactly at the goal. */
export function findPath(fromX: number, fromY: number, toX: number, toY: number): [number, number][] {
  grid ??= buildGrid();
  const g = grid;
  const start = nearestOpen(g, Math.floor(fromX / TILE), Math.floor(fromY / TILE));
  const goal = nearestOpen(g, Math.floor(toX / TILE), Math.floor(toY / TILE));
  if (start < 0 || goal < 0) return [[toX, toY]];

  const gx = goal % COLS;
  const gy = Math.floor(goal / COLS);
  const cost = new Float32Array(COLS * ROWS).fill(Infinity);
  const prev = new Int32Array(COLS * ROWS).fill(-1);
  const closed = new Uint8Array(COLS * ROWS);
  const open: { i: number; f: number }[] = [{ i: start, f: 0 }];
  cost[start] = 0;

  while (open.length) {
    let bestIndex = 0;
    for (let k = 1; k < open.length; k++) if (open[k].f < open[bestIndex].f) bestIndex = k;
    const { i } = open[bestIndex];
    open[bestIndex] = open[open.length - 1];
    open.pop();
    if (closed[i]) continue;
    closed[i] = 1;
    if (i === goal) break;
    const x = i % COLS;
    const y = Math.floor(i / COLS);
    for (const [dx, dy, step] of NEIGHBOURS) {
      const nx = x + dx;
      const ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= COLS || ny >= ROWS) continue;
      const n = ny * COLS + nx;
      if (!g[n] || closed[n]) continue;
      if (dx && dy && (!g[y * COLS + nx] || !g[ny * COLS + x])) continue;
      const c = cost[i] + step;
      if (c < cost[n]) {
        cost[n] = c;
        prev[n] = i;
        open.push({ i: n, f: c + Math.hypot(nx - gx, ny - gy) });
      }
    }
  }

  if (prev[goal] < 0 && start !== goal) return [[toX, toY]];
  const pts: [number, number][] = [];
  for (let c = goal; c !== -1 && c !== start; c = prev[c]) {
    pts.unshift([(c % COLS) * TILE + 3, Math.floor(c / COLS) * TILE + 3]);
  }
  pts.push([toX, toY]);
  return pts;
}

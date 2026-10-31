import { fbm, noise } from "./pixel";

export const WORLD_W = 780;
export const WORLD_H = 500;

export type Facing = "up" | "down" | "left" | "right";
export type Spot = { x: number; y: number; face: Facing };
export type StationId =
  | "library"
  | "cutting"
  | "animation"
  | "captions"
  | "living"
  | "sound"
  | "render"
  | "review"
  | "hammock"
  | "dock";

export type Station = {
  id: StationId;
  label: string;
  blurb: string;
  area: { x: number; y: number; w: number; h: number };
  spots: Spot[];
};

export const HOUSE = { x: 216, y: 128, w: 330, h: 176 };
export const WALL_X = [326, 436];
export const WALL_Y = 214;
export const DOOR_V_BACK = { y0: 165, y1: 187 };
export const DOOR_V_FRONT = { y0: 240, y1: 262 };
export const DOOR_H = [
  { x0: 262, x1: 284 },
  { x0: 372, x1: 394 },
  { x0: 482, x1: 504 },
];
export const DOOR_LEFT = { y0: 240, y1: 262 };
export const DOOR_RIGHT = { y0: 165, y1: 187 };
export const STAIRS = { x0: 370, x1: 396 };
export const DECK = { x: 300, y: 312, w: 176, h: 44 };
export const DOCK = { x: 378, y: 356, w: 28, h: 86 };

export const STATIONS: Record<StationId, Station> = {
  library: {
    id: "library",
    label: "The Library",
    blurb: "B-roll shelves. Editors search footage here.",
    area: { x: 218, y: 128, w: 106, h: 84 },
    spots: [
      { x: 244, y: 152, face: "down" },
      { x: 304, y: 152, face: "down" },
    ],
  },
  cutting: {
    id: "cutting",
    label: "Cutting Room",
    blurb: "A-roll cuts, retakes and pauses.",
    area: { x: 328, y: 128, w: 106, h: 84 },
    spots: [
      { x: 356, y: 151, face: "down" },
      { x: 406, y: 151, face: "down" },
    ],
  },
  animation: {
    id: "animation",
    label: "Animation Studio",
    blurb: "Motion graphics and explainers.",
    area: { x: 438, y: 128, w: 106, h: 84 },
    spots: [
      { x: 466, y: 151, face: "down" },
      { x: 516, y: 151, face: "down" },
    ],
  },
  captions: {
    id: "captions",
    label: "Caption Nook",
    blurb: "Word-timed captions and animation.",
    area: { x: 218, y: 216, w: 106, h: 86 },
    spots: [
      { x: 246, y: 232, face: "down" },
      { x: 300, y: 232, face: "down" },
    ],
  },
  living: {
    id: "living",
    label: "Living Room",
    blurb: "Coffee, cushions and team gossip.",
    area: { x: 328, y: 216, w: 106, h: 86 },
    spots: [
      { x: 349, y: 238, face: "up" },
      { x: 364, y: 278, face: "right" },
      { x: 406, y: 278, face: "left" },
      { x: 414, y: 240, face: "up" },
    ],
  },
  sound: {
    id: "sound",
    label: "Sound Room",
    blurb: "Sound effects, music and ducking.",
    area: { x: 438, y: 216, w: 106, h: 86 },
    spots: [
      { x: 462, y: 232, face: "down" },
      { x: 524, y: 232, face: "down" },
    ],
  },
  render: {
    id: "render",
    label: "Render Shed",
    blurb: "One heavy render at a time, per Mac.",
    area: { x: 586, y: 142, w: 88, h: 76 },
    spots: [
      { x: 610, y: 226, face: "down" },
      { x: 638, y: 226, face: "down" },
      { x: 586, y: 232, face: "down" },
    ],
  },
  review: {
    id: "review",
    label: "Review Bale",
    blurb: "Finished cuts wait here for your eyes.",
    area: { x: 100, y: 176, w: 84, h: 72 },
    spots: [
      { x: 130, y: 252, face: "down" },
      { x: 154, y: 252, face: "down" },
    ],
  },
  hammock: {
    id: "hammock",
    label: "The Hammock",
    blurb: "Where editors recharge.",
    area: { x: 86, y: 296, w: 76, h: 34 },
    spots: [{ x: 122, y: 318, face: "down" }],
  },
  dock: {
    id: "dock",
    label: "Footage Dock",
    blurb: "New footage and new editors arrive by boat.",
    area: { x: 378, y: 356, w: 28, h: 86 },
    spots: [{ x: 392, y: 430, face: "down" }],
  },
};

const blob = (px: number, py: number, cx: number, cy: number, rx: number, ry: number) =>
  (1 - Math.hypot((px - cx) / rx, (py - cy) / ry)) * Math.min(rx, ry);


export function landSdf(x: number, y: number) {
  let d = Math.max(
    blob(x, y, 372, 146, 372, 168),
    blob(x, y, 110, 250, 138, 104),
    blob(x, y, 650, 240, 150, 106),
    blob(x, y, 700, 442, 66, 26),
    blob(x, y, 62, 448, 72, 28),
  );
  d += (fbm(x / 52, y / 52, 3) - 0.5) * 42 + (noise(x / 13, y / 13) - 0.5) * 7;
  return d;
}

export const PATHS: [number, number][][] = [
  [
    [214, 251],
    [186, 256],
    [160, 262],
    [132, 266],
    [118, 300],
  ],
  [
    [548, 176],
    [566, 192],
    [584, 212],
    [610, 236],
  ],
  [
    [132, 266],
    [76, 250],
    [30, 216],
  ],
  [
    [610, 236],
    [664, 266],
    [730, 270],
  ],
  [
    [214, 251],
    [196, 196],
    [204, 96],
    [250, 40],
    [320, 0],
  ],
  [
    [548, 176],
    [574, 120],
    [640, 76],
    [700, 30],
  ],
  [
    [302, 324],
    [250, 332],
    [190, 318],
    [150, 306],
  ],
  [
    [474, 324],
    [526, 330],
    [580, 300],
    [608, 240],
  ],
];

export function pathDistance(x: number, y: number) {
  let best = 1e9;
  for (const line of PATHS) {
    for (let i = 0; i < line.length - 1; i++) {
      const [ax, ay] = line[i];
      const [bx, by] = line[i + 1];
      const dx = bx - ax;
      const dy = by - ay;
      const t = Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / (dx * dx + dy * dy)));
      best = Math.min(best, Math.hypot(x - ax - dx * t, y - ay - dy * t));
    }
  }
  return best;
}

type Rect = [number, number, number, number];

/** Furniture and solid objects that editors must walk around. */
const BLOCKERS: Rect[] = [
  [222, 132, 98, 10],
  [336, 160, 40, 10],
  [386, 160, 40, 10],
  [446, 160, 40, 10],
  [496, 160, 40, 10],
  [226, 241, 40, 10],
  [280, 241, 40, 10],
  [444, 241, 36, 10],
  [506, 241, 36, 10],
  [332, 218, 28, 12],
  [352, 262, 62, 8],
  [256, 170, 42, 16],
  [590, 160, 76, 54],
  [104, 196, 68, 44],
];

const inRect = (x: number, y: number, r: { x: number; y: number; w: number; h: number }) =>
  x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h;

const inside = (v: number, a: number, b: number) => v >= a && v <= b;

export function walkable(x: number, y: number) {
  for (const [bx, by, bw, bh] of BLOCKERS) if (x >= bx && x < bx + bw && y >= by && y < by + bh) return false;
  if (inRect(x, y, DECK) || inRect(x, y, DOCK)) return true;

  const outer = { x: HOUSE.x - 3, y: HOUSE.y - 6, w: HOUSE.w + 6, h: HOUSE.h + 12 };
  if (inRect(x, y, outer)) {
    if (y < HOUSE.y + 4) return false;
    if (y >= HOUSE.y + HOUSE.h - 2) return inside(x, STAIRS.x0, STAIRS.x1);
    if (x < HOUSE.x + 3) return inside(y, DOOR_LEFT.y0, DOOR_LEFT.y1);
    if (x >= HOUSE.x + HOUSE.w - 3) return inside(y, DOOR_RIGHT.y0, DOOR_RIGHT.y1);
    for (const wx of WALL_X) {
      if (Math.abs(x - wx) < 4) {
        return y < WALL_Y ? inside(y, DOOR_V_BACK.y0, DOOR_V_BACK.y1) : inside(y, DOOR_V_FRONT.y0, DOOR_V_FRONT.y1);
      }
    }
    if (Math.abs(y - WALL_Y) < 4) return DOOR_H.some((d) => inside(x, d.x0, d.x1));
    return true;
  }
  return landSdf(x, y) > 5;
}

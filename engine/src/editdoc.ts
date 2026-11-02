import { randomUUID } from "node:crypto";
import { lowerBound } from "./lib/dsa.ts";

export type Word = { i: number; t0: number; t1: number; text: string };

export type Entrance = { kind: "none" | "fade" | "slide_up" | "slide_down" | "slide_left" | "slide_right" | "pop"; seconds: number };
/** A place in the frame, as fractions of its width and height. */
export type Box = { x: number; y: number; w: number; h: number };
export type CameraKind = "push_in" | "pull_out" | "punch_in" | "pan_left" | "pan_right" | "pan_up" | "pan_down" | "shake";
export type Ease = "smooth" | "snap" | "linear";
export type Overlay = { id: string; from: number; to: number; path: string; in: number; label?: string; shotId?: string; enter?: Entrance; exit?: Entrance; box?: Box; speed?: number; move?: { kind: CameraKind; amount: number }; hideCaptions?: boolean };
export type Move = { id: string; from: number; to: number; kind: CameraKind; amount: number; ease: Ease; x: number; y: number };
export type TransitionKind = "fade" | "dissolve" | "dip_black" | "dip_white" | "slide_left" | "slide_right" | "slide_up" | "slide_down" | "smooth_left" | "smooth_right" | "zoom_in" | "blur" | "circle" | "whip_left" | "whip_right";
export type Transition = { id: string; word: number; kind: TransitionKind; seconds: number };
export type Card = { id: string; from: number; to: number; color: string; label?: string };
export type EffectKind = "flash" | "blur" | "rgb_split" | "grain";
export type Effect = { id: string; from: number; to: number; kind: EffectKind; amount: number };
export type Emphasis = { word: number; scale?: number; font?: string; color?: string; breakBefore?: boolean; x?: number; y?: number };
/** Words waiting for a clip from the Motion agent. A final render can't start until it lands. */
export type Reserved = { id: string; from: number; to: number; label: string };
export type Sfx = { id: string; word: number; offset: number; path: string; gainDb: number; label?: string };
export type Music = { id: string; path: string; gainDb: number; duck: boolean; label?: string };
export type CaptionAnimation = "none" | "fade" | "pop" | "rise" | "drop" | "stretch";
export type CaptionStyle = {
  enabled: boolean; maxWords: number; uppercase: boolean; font: string; size: number | null; color: string; highlight: string; position: number;
  x?: number; strokeColor?: string; strokeWidth?: number; glowColor?: string; glowRadius?: number; boxColor?: string; boxOpacity?: number;
  animation?: CaptionAnimation; animationSeconds?: number; reveal?: "chunk" | "word"; lineHeight?: number; maxWidth?: number;
};

export type EditDoc = {
  source: { hash: string; path: string; name: string; duration: number; width: number; height: number; fps: number; locale: string };
  output: { width: number; height: number; fps: number };
  words: Word[];
  removed: [number, number][];
  maxPause: number | null;
  keepPauses: number[];
  broll: Overlay[];
  graphics: Overlay[];
  captions: CaptionStyle;
  sfx: Sfx[];
  music: Music[];
  moves: Move[];
  transitions: Transition[];
  cards: Card[];
  effects: Effect[];
  emphasis: Emphasis[];
  reserved: Reserved[];
};

/** Versions saved before these layers existed still open. */
export const withLayers = (doc: EditDoc): EditDoc => ({ ...doc, moves: doc.moves ?? [], transitions: doc.transitions ?? [], cards: doc.cards ?? [], effects: doc.effects ?? [], emphasis: doc.emphasis ?? [], reserved: doc.reserved ?? [] });

export type Op =
  | { op: "remove_words"; from: number; to: number; reason?: string }
  | { op: "restore_words"; from: number; to: number }
  | { op: "set_max_pause"; seconds: number | null }
  | { op: "keep_pause"; word: number }
  | { op: "add_broll"; from: number; to: number; path: string; in?: number; label?: string; shotId?: string; enter?: Entrance; exit?: Entrance; box?: Box; speed?: number; move?: { kind: CameraKind; amount: number } }
  | { op: "add_graphic"; from: number; to: number; path: string; label?: string; enter?: Entrance; exit?: Entrance; box?: Box; reservation?: string; hideCaptions?: boolean }
  | { op: "reserve_graphic"; from: number; to: number; label: string; id: string }
  | { op: "add_move"; from: number; to: number; kind: CameraKind; amount?: number; ease?: Ease; x?: number; y?: number }
  | { op: "add_transition"; word: number; kind: TransitionKind; seconds?: number }
  | { op: "add_card"; from: number; to: number; color: string; label?: string }
  | { op: "add_effect"; from: number; to: number; kind: EffectKind; amount?: number }
  | { op: "style_words"; from: number; to: number; scale?: number; font?: string; color?: string; breakBefore?: boolean; x?: number; y?: number }
  | { op: "clear_word_styles"; from: number; to: number }
  | { op: "add_sfx"; word: number; path: string; offset?: number; gainDb?: number; label?: string }
  | { op: "add_music"; path: string; gainDb?: number; duck?: boolean; label?: string }
  | { op: "remove_item"; id: string }
  | ({ op: "set_captions" } & Partial<Omit<CaptionStyle, "size"> & { size: number }>)
  | { op: "set_output"; width: number; height: number };

export function newDoc(source: EditDoc["source"], words: { text: string; start: number; end: number }[]): EditDoc {
  return {
    source,
    output: { width: source.width & ~1, height: source.height & ~1, fps: Math.round(source.fps) || 30 },
    words: words.map((w, i) => ({ i, t0: w.start, t1: w.end, text: w.text })),
    removed: [],
    maxPause: null,
    keepPauses: [],
    broll: [],
    graphics: [],
    captions: { enabled: false, maxWords: 4, uppercase: false, font: "Avenir Next Heavy", size: null, color: "#FFFFFF", highlight: "#FFD34E", position: 0.14, strokeWidth: 8, animation: "pop", reveal: "chunk" },
    sfx: [],
    music: [],
    moves: [],
    transitions: [],
    cards: [],
    effects: [],
    emphasis: [],
    reserved: [],
  };
}

function mergeRanges(ranges: [number, number][]) {
  const sorted = [...ranges].sort((a, b) => a[0] - b[0]);
  const out: [number, number][] = [];
  for (const [a, b] of sorted) {
    const last = out[out.length - 1];
    if (last && a <= last[1] + 1) last[1] = Math.max(last[1], b);
    else out.push([a, b]);
  }
  return out;
}

function subtractRange(ranges: [number, number][], from: number, to: number) {
  const out: [number, number][] = [];
  for (const [a, b] of ranges) {
    if (b < from || a > to) out.push([a, b]);
    else {
      if (a < from) out.push([a, from - 1]);
      if (b > to) out.push([to + 1, b]);
    }
  }
  return out;
}

const check = (ok: boolean, message: string) => {
  if (!ok) throw new Error(message);
};

export function applyOps(doc: EditDoc, ops: Op[]) {
  const d: EditDoc = structuredClone(withLayers(doc));
  const added: Transition[] = [];
  const file = (o: { path?: string }) => check(typeof o.path === "string" && o.path.length > 0, "This edit needs a file path.");
  const n = d.words.length;
  const range = (from: number, to: number) => check(Number.isInteger(from) && Number.isInteger(to) && from >= 0 && to < n && from <= to, `Word range ${from}-${to} is outside 0-${n - 1}.`);
  for (const o of ops) {
    switch (o.op) {
      case "remove_words":
        range(o.from, o.to);
        d.removed = mergeRanges([...d.removed, [o.from, o.to]]);
        break;
      case "restore_words":
        range(o.from, o.to);
        d.removed = subtractRange(d.removed, o.from, o.to);
        break;
      case "set_max_pause":
        check(o.seconds === null || o.seconds >= 0, "Pause length can't be negative.");
        d.maxPause = o.seconds;
        break;
      case "keep_pause":
        range(o.word, o.word);
        if (!d.keepPauses.includes(o.word)) d.keepPauses.push(o.word);
        break;
      case "add_broll": {
        file(o);
        range(o.from, o.to);
        const clash = d.broll.find((b) => o.from <= b.to && b.from <= o.to);
        check(!clash, `That overlaps B-roll "${clash?.label ?? clash?.id}" on words ${clash?.from}-${clash?.to}.`);
        check(o.speed === undefined || (o.speed >= 0.1 && o.speed <= 8), "B-roll speed must be between 0.1 and 8.");
        d.broll.push({ id: randomUUID().slice(0, 8), from: o.from, to: o.to, path: o.path, in: o.in ?? 0, label: o.label, shotId: o.shotId, enter: o.enter, exit: o.exit, box: o.box, speed: o.speed, move: o.move });
        d.broll.sort((a, b) => a.from - b.from);
        break;
      }
      case "add_graphic":
        file(o);
        range(o.from, o.to);
        d.graphics.push({ id: randomUUID().slice(0, 8), from: o.from, to: o.to, path: o.path, in: 0, label: o.label, enter: o.enter, exit: o.exit, box: o.box, hideCaptions: o.hideCaptions });
        if (o.reservation) d.reserved = d.reserved.filter((r) => r.id !== o.reservation);
        break;
      case "reserve_graphic":
        range(o.from, o.to);
        d.reserved.push({ id: o.id, from: o.from, to: o.to, label: o.label });
        break;
      case "add_move":
        range(o.from, o.to);
        d.moves.push({ id: randomUUID().slice(0, 8), from: o.from, to: o.to, kind: o.kind, amount: o.amount ?? 0.08, ease: o.ease ?? "smooth", x: o.x ?? 0.5, y: o.y ?? 0.5 });
        d.moves.sort((a, b) => a.from - b.from);
        break;
      case "add_transition": {
        range(o.word, o.word);
        const t = { id: randomUUID().slice(0, 8), word: o.word, kind: o.kind, seconds: o.seconds ?? 0.3 };
        check(t.seconds >= 0.04 && t.seconds <= 2, "A transition must last between 0.04 and 2 seconds.");
        d.transitions = d.transitions.filter((v) => v.word !== o.word);
        d.transitions.push(t);
        added.push(t);
        break;
      }
      case "add_card":
        range(o.from, o.to);
        check(/^#[0-9a-fA-F]{6}$/.test(o.color), "A card colour must look like #000000.");
        d.cards.push({ id: randomUUID().slice(0, 8), from: o.from, to: o.to, color: o.color, label: o.label });
        break;
      case "add_effect":
        range(o.from, o.to);
        d.effects.push({ id: randomUUID().slice(0, 8), from: o.from, to: o.to, kind: o.kind, amount: o.amount ?? 1 });
        break;
      case "style_words": {
        range(o.from, o.to);
        const { op: _, from, to, ...style } = o;
        for (let word = from; word <= to; word++) {
          const current = d.emphasis.find((e) => e.word === word);
          // Position and line breaks belong to the first word of a run, or every word would stack.
          const own = word === from ? style : { scale: style.scale, font: style.font, color: style.color };
          const clean = Object.fromEntries(Object.entries(own).filter(([, v]) => v !== undefined));
          if (current) Object.assign(current, clean);
          else d.emphasis.push({ word, ...clean });
        }
        break;
      }
      case "clear_word_styles":
        range(o.from, o.to);
        d.emphasis = d.emphasis.filter((e) => e.word < o.from || e.word > o.to);
        break;
      case "add_sfx":
        file(o);
        range(o.word, o.word);
        d.sfx.push({ id: randomUUID().slice(0, 8), word: o.word, offset: o.offset ?? 0, path: o.path, gainDb: o.gainDb ?? -10, label: o.label });
        break;
      case "add_music":
        file(o);
        d.music.push({ id: randomUUID().slice(0, 8), path: o.path, gainDb: o.gainDb ?? -20, duck: o.duck ?? true, label: o.label });
        break;
      case "remove_item": {
        const count = () => d.broll.length + d.graphics.length + d.sfx.length + d.music.length + d.moves.length + d.transitions.length + d.cards.length + d.effects.length + d.reserved.length;
        const before = count();
        d.broll = d.broll.filter((v) => v.id !== o.id);
        d.graphics = d.graphics.filter((v) => v.id !== o.id);
        d.sfx = d.sfx.filter((v) => v.id !== o.id);
        d.music = d.music.filter((v) => v.id !== o.id);
        d.moves = d.moves.filter((v) => v.id !== o.id);
        d.transitions = d.transitions.filter((v) => v.id !== o.id);
        d.cards = d.cards.filter((v) => v.id !== o.id);
        d.effects = d.effects.filter((v) => v.id !== o.id);
        d.reserved = d.reserved.filter((v) => v.id !== o.id);
        check(before !== count(), `Nothing has the id ${o.id}.`);
        break;
      }
      case "set_captions": {
        const { op: _, ...rest } = o;
        d.captions = { ...d.captions, ...rest };
        break;
      }
      case "set_output":
        check(o.width >= 64 && o.height >= 64, "That output size is too small.");
        d.output.width = o.width & ~1;
        d.output.height = o.height & ~1;
        break;
      default:
        throw new Error(`Unknown edit: ${(o as { op: string }).op}`);
    }
  }
  if (added.length) {
    const segs = segments(d);
    const joins = joinWords(d, segs);
    for (const t of added) check(joins.includes(t.word), `Word ${t.word} doesn't sit on a cut. A transition needs a cut. Cuts are before words: ${joins.slice(0, 40).join(", ") || "none yet"}.`);
  }
  return d;
}

export type Segment = { start: number; end: number; outStart: number };

const PAD_IN = 0.04;
const PAD_OUT = 0.08;

export function isRemoved(doc: EditDoc, word: number) {
  const r = doc.removed;
  let lo = 0;
  let hi = r.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (word < r[mid][0]) hi = mid - 1;
    else if (word > r[mid][1]) lo = mid + 1;
    else return true;
  }
  return false;
}

/** Turns kept words into source segments. Everything else is anchored to these words. */
export function segments(doc: EditDoc): Segment[] {
  const { words, maxPause, keepPauses, source } = doc;
  if (!words.length) return [{ start: 0, end: source.duration, outStart: 0 }];
  const keep = new Set(keepPauses);
  const out: Segment[] = [];
  let current: { start: number; end: number } | null = null;
  let prev: Word | null = null;
  for (const w of words) {
    if (isRemoved(doc, w.i)) continue;
    const start = Math.max(0, w.t0 - PAD_IN);
    const end = Math.min(source.duration, w.t1 + PAD_OUT);
    const contiguous = prev !== null && prev.i === w.i - 1;
    const gap = prev ? w.t0 - prev.t1 : 0;
    const tooLong = maxPause !== null && prev !== null && gap > maxPause && !keep.has(prev.i);
    if (current && contiguous && !tooLong) current.end = end;
    else {
      // A tightened pause keeps a natural beat instead of butting two words together.
      if (current && tooLong) current.end = Math.max(current.end, prev!.t1 + maxPause! * 0.6);
      if (current) out.push({ ...current, outStart: 0 });
      current = { start: tooLong ? Math.min(start, w.t0 - maxPause! * 0.4) : start, end };
    }
    prev = w;
  }
  if (current) out.push({ ...current, outStart: 0 });
  // Pads can overlap when words sit close together. Clamp so no source frame plays twice.
  let t = 0;
  for (let i = 0; i < out.length; i++) {
    if (i && out[i].start < out[i - 1].end) out[i].start = out[i - 1].end;
    out[i].outStart = t;
    t += out[i].end - out[i].start;
  }
  return out.filter((s) => s.end - s.start > 0.001);
}

/** The first kept word after each cut. Transitions anchor here. */
export function joinWords(doc: EditDoc, segs: Segment[]) {
  return doc.words.filter((w) => !isRemoved(doc, w.i)).filter((w) => {
    const t = toOutput(segs, w.t0);
    return segs.some((s, i) => i > 0 && Math.abs(s.outStart - t) < 0.15);
  }).filter((w, i, all) => i === 0 || toOutput(segs, w.t0) - toOutput(segs, all[i - 1].t0) > 0.15).map((w) => w.i);
}

export const totalDuration = (segs: Segment[]) => (segs.length ? segs[segs.length - 1].outStart + segs[segs.length - 1].end - segs[segs.length - 1].start : 0);

/** Maps a source time to output time in O(log n). Times inside a cut snap to the next kept moment. */
export function toOutput(segs: Segment[], t: number) {
  const starts = segs.map((s) => s.start);
  const i = lowerBound(starts, t + 1e-9) - 1;
  if (i < 0) return segs[0]?.outStart ?? 0;
  const s = segs[i];
  if (t <= s.end) return s.outStart + (t - s.start);
  return i + 1 < segs.length ? segs[i + 1].outStart : totalDuration(segs);
}

/** Output span of an anchored word range. Survives any later change to the cuts. */
export function wordSpan(doc: EditDoc, segs: Segment[], from: number, to: number) {
  return { start: toOutput(segs, doc.words[from].t0), end: toOutput(segs, doc.words[to].t1) };
}

type CaptionWord = { text: string; start: number; end: number; scale?: number; font?: string; color?: string; breakBefore?: boolean };

export function captionChunks(doc: EditDoc, segs: Segment[]) {
  const chunks: { start: number; end: number; words: CaptionWord[]; x?: number; y?: number }[] = [];
  let cur: (typeof chunks)[number] | null = null;
  const styled = new Map((doc.emphasis ?? []).map((e) => [e.word, e]));
  // A graphic that carries its own words would otherwise show them twice.
  const quiet = doc.graphics.filter((g) => g.hideCaptions);
  for (const w of doc.words) {
    if (isRemoved(doc, w.i) || quiet.some((g) => w.i >= g.from && w.i <= g.to)) continue;
    const start = toOutput(segs, w.t0);
    const end = toOutput(segs, w.t1);
    const style = styled.get(w.i);
    const moved = style?.x !== undefined || style?.y !== undefined;
    const breakHere = cur && (cur.words.length >= doc.captions.maxWords || start - cur.end > 0.45 || /[.?!]$/.test(cur.words[cur.words.length - 1].text) || moved);
    if (!cur || breakHere) {
      if (cur) chunks.push(cur);
      cur = { start, end, words: [] };
      if (moved) {
        cur.x = style?.x;
        cur.y = style?.y;
      }
    }
    cur.words.push({ text: w.text, start, end, ...(style ? { scale: style.scale, font: style.font, color: style.color, breakBefore: style.breakBefore } : {}) });
    cur.end = end;
  }
  if (cur) chunks.push(cur);
  return chunks;
}

const FILLERS = new Set(["um", "umm", "uh", "uhh", "erm", "er", "hmm", "ah", "aa", "matlab", "basically", "actually"]);
const HARD_FILLERS = new Set(["um", "umm", "uh", "uhh", "erm", "er", "hmm"]);
const norm = (t: string) => t.toLowerCase().replace(/[^\p{L}\p{N}']/gu, "");

export type TakeAnalysis = {
  sentences: { from: number; to: number; text: string; start: number; end: number }[];
  fillers: { word: number; text: string; certain: boolean }[];
  repeats: { from: number; to: number; text: string }[];
  retakes: { dropFrom: number; dropTo: number; keepFrom: number; keepTo: number; similarity: number; text: string }[];
  pauses: { afterWord: number; seconds: number; before: string; after: string; endsSentence: boolean; question: boolean; maybeIntentional: boolean }[];
};

/** Finds candidates only. The editor decides what's a mistake and what's intentional. */
export function analyzeTakes(words: Word[], editDistance: (a: string[], b: string[]) => number): TakeAnalysis {
  const sentences: TakeAnalysis["sentences"] = [];
  let start = 0;
  words.forEach((w, i) => {
    const next = words[i + 1];
    if (/[.?!।]$/.test(w.text) || !next || next.t0 - w.t1 > 0.9) {
      sentences.push({ from: start, to: i, text: words.slice(start, i + 1).map((v) => v.text).join(" "), start: words[start].t0, end: w.t1 });
      start = i + 1;
    }
  });

  const fillers = words.filter((w) => FILLERS.has(norm(w.text))).map((w) => ({ word: w.i, text: w.text, certain: HARD_FILLERS.has(norm(w.text)) }));

  const repeats: TakeAnalysis["repeats"] = [];
  for (let i = 1; i < words.length; i++) {
    if (norm(words[i].text) && norm(words[i].text) === norm(words[i - 1].text) && words[i].t0 - words[i - 1].t1 < 0.6) repeats.push({ from: i - 1, to: i - 1, text: words[i].text });
  }

  const retakes: TakeAnalysis["retakes"] = [];
  const tokens = sentences.map((s) => words.slice(s.from, s.to + 1).map((w) => norm(w.text)).filter(Boolean));
  for (let i = 0; i < sentences.length; i++) {
    for (let j = i + 1; j <= i + 2 && j < sentences.length; j++) {
      const a = tokens[i];
      const b = tokens[j];
      if (a.length < 3 || b.length < 3) continue;
      // A false start ends with the words the next take opens on, so compare that overlap too.
      const whole = 1 - editDistance(a, b) / Math.max(a.length, b.length);
      let overlap = 0;
      for (let k = Math.min(a.length, b.length); k >= 3 && !overlap; k--) {
        if (editDistance(a.slice(-k), b.slice(0, k)) <= Math.floor(k / 5)) overlap = k;
      }
      const similarity = Math.max(whole, overlap / a.length);
      if (similarity >= 0.6) {
        retakes.push({ dropFrom: sentences[i].from, dropTo: sentences[i].to, keepFrom: sentences[j].from, keepTo: sentences[j].to, similarity: Number(similarity.toFixed(2)), text: sentences[i].text });
        break;
      }
    }
  }

  const pauses: TakeAnalysis["pauses"] = [];
  for (let i = 0; i + 1 < words.length; i++) {
    const seconds = words[i + 1].t0 - words[i].t1;
    if (seconds < 0.35) continue;
    const endsSentence = /[.?!।]$/.test(words[i].text);
    const question = /\?$/.test(words[i].text);
    pauses.push({ afterWord: i, seconds: Number(seconds.toFixed(2)), before: words.slice(Math.max(0, i - 5), i + 1).map((w) => w.text).join(" "), after: words.slice(i + 1, i + 6).map((w) => w.text).join(" "), endsSentence, question, maybeIntentional: endsSentence && seconds >= 0.5 && seconds <= 2.2 });
  }
  return { sentences, fillers, repeats, retakes, pauses };
}

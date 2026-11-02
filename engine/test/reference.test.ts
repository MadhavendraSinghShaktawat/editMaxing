import assert from "node:assert/strict";
import { test } from "node:test";
import type { Curve, Sample } from "../src/lib/reference.ts";
import { chooseMoments, findBoundaries, liveliness, shotsFrom, solidCards, summarizeAudio, summarizeCamera, summarizeFaces, summarizeText, visualEvents } from "../src/lib/reference.ts";

/** Builds a curve from a list of frames, each a flat colour level. */
function curve(levels: number[], fps = 30): Curve {
  const pixels = 160 * 90;
  const hist = levels.map((v) => {
    const h = new Float32Array(48);
    const bin = Math.min(15, Math.floor(v * 16));
    h[bin] = h[16 + bin] = h[32 + bin] = pixels;
    return h;
  });
  const change = levels.map((_, i) => {
    if (!i) return 0;
    let d = 0;
    for (let k = 0; k < 48; k++) d += Math.abs(hist[i][k] - hist[i - 1][k]);
    return d / (2 * 3 * pixels);
  });
  const diff = levels.map((v, i) => (i ? Math.abs(v - levels[i - 1]) : 0));
  return { fps, diff, change, spread: diff.map((d) => (d > 0.03 ? 1 : 0)), bright: levels, sharp: levels.map(() => 0.02), hist, palette: [] };
}

const flat = (v: number, n: number) => new Array<number>(n).fill(v);

test("a hard cut is one join, in the right place", () => {
  const found = findBoundaries(curve([...flat(0.3, 60), ...flat(0.7, 60)]));
  assert.equal(found.length, 1);
  assert.equal(found[0].kind, "cut");
  assert.ok(Math.abs(found[0].t - 2) < 0.05);
});

test("a hard cut to a black card is a cut, not a fade", () => {
  const found = findBoundaries(curve([...flat(0.5, 60), ...flat(0, 30), ...flat(0.5, 60)]));
  assert.deepEqual(found.map((b) => b.kind), ["cut", "cut"]);
});

test("a gradual fade to black is a dip", () => {
  const down = Array.from({ length: 10 }, (_, i) => 0.5 - i * 0.05);
  const found = findBoundaries(curve([...flat(0.5, 60), ...down, ...flat(0.01, 10), ...down.slice().reverse(), ...flat(0.5, 60)]));
  assert.equal(found.length, 1);
  assert.equal(found[0].kind, "dip_black");
});

test("a word landing isn't a cut, even though it changes the frame suddenly", () => {
  const c = curve(flat(0.5, 120));
  c.diff[60] = 0.03;
  c.spread[60] = 0.12;
  assert.equal(findBoundaries(c).length, 0);
  assert.equal(visualEvents(c, []).length, 1);
});

test("a jump cut shifts the whole picture but barely changes its colours", () => {
  const c = curve(flat(0.5, 120));
  c.diff[60] = 0.04;
  c.spread[60] = 0.6;
  assert.deepEqual(findBoundaries(c).map((b) => b.kind), ["jump_cut"]);
});

test("solid cards are found with their colour", () => {
  assert.deepEqual(solidCards(curve([...flat(0.5, 30), ...flat(0, 30), ...flat(0.5, 30), ...flat(1, 30)])).map((c) => c.color), ["black", "white"]);
});

const samples = (t0: number, t1: number, make: (i: number) => Partial<Sample>): Sample[] => {
  const out: Sample[] = [];
  for (let i = 0, t = t0 + 1 / 6; t < t1; i++, t += 1 / 6) out.push({ t, dt: 1 / 6, scale: 1, dx: 0, dy: 0, turn: 0, before: 0.05, after: 0.02, ...make(i) });
  return out;
};

test("a push reads as a push in, and a growing picture is never called a pull", () => {
  const cam = summarizeCamera(samples(0, 3, () => ({ scale: 1.01 })), [{ t0: 0, t1: 3 }], [], 3);
  assert.equal(cam.moves[0].kind, "push_in");
  assert.ok(Math.abs(cam.moves[0].rate - 6) < 0.3);
});

test("a steady push is trusted even when the speaker's movement hides it", () => {
  const cam = summarizeCamera(samples(0, 3, () => ({ scale: 1.01, before: 0.05, after: 0.048 })), [{ t0: 0, t1: 3 }], [], 3);
  assert.equal(cam.moves[0].kind, "push_in");
});

test("a speaker wandering around isn't a camera move", () => {
  const cam = summarizeCamera(samples(0, 3, (i) => ({ scale: i % 2 ? 1.01 : 0.99, dx: i % 2 ? 0.004 : -0.004, before: 0.05, after: 0.05 })), [{ t0: 0, t1: 3 }], [], 3);
  assert.equal(cam.moveCount, 0);
});

test("back and forth with no net travel is shake", () => {
  const cam = summarizeCamera(samples(0, 3, (i) => ({ dx: i % 2 ? 0.02 : -0.02, dy: i % 2 ? -0.02 : 0.02 })), [{ t0: 0, t1: 3 }], [], 3);
  assert.equal(cam.moves[0].kind, "shake");
});

test("a punch-in needs the two sides to really line up", () => {
  const cuts = [{ t: 1, scale: 1.28, dx: 0, dy: 0, before: 0.13, after: 0.07 }, { t: 2, scale: 0.88, dx: 0, dy: 0, before: 0.1, after: 0.087 }];
  const cam = summarizeCamera([], [{ t0: 0, t1: 3 }], cuts, 3);
  assert.deepEqual(cam.punches.map((p) => p.t), [1]);
});

test("pace is measured from the video, and frozen stretches are reported", () => {
  const c = curve(flat(0.5, 150));
  const pace = liveliness(c, [1, 2, 3], 5);
  assert.equal(pace.typicalGapSeconds, 1);
  assert.equal(pace.longestGapSeconds, 2);
  assert.ok(pace.frozenShare > 0.9);
});

test("spoken text counts as captions, and other text is kept apart", () => {
  const read = [{ t: 1, text: [{ text: "THE WORST", box: [0.3, 0.45, 0.4, 0.1] }, { text: "SUBSCRIBE", box: [0.1, 0.9, 0.2, 0.03] }], faces: [{ box: [0.3, 0.5, 0.4, 0.3] }] }];
  const t = summarizeText(read, ["the", "worst", "thing"]);
  assert.equal(t.shareOfFramesWithCaptions, 1);
  assert.equal(t.uppercaseShare, 1);
  assert.equal(t.zones.middle, 1);
  assert.equal(t.overlapsFace, 1);
  assert.equal(t.otherText[0].text, "SUBSCRIBE");
});

test("words building up are told apart from words being replaced", () => {
  const frame = (t: number, s: string) => ({ t, text: [{ text: s, box: [0.3, 0.5, 0.4, 0.1] }] });
  const up = summarizeText([frame(1, "the"), frame(2, "the thing"), frame(3, "the thing that")], ["the", "thing", "that"]);
  assert.equal(up.wordsBuildUpShare, 1);
  const swap = summarizeText([frame(1, "the"), frame(2, "thing"), frame(3, "that")], ["the", "thing", "that"]);
  assert.equal(swap.wordsReplacedShare, 1);
});

test("framing reports the largest face", () => {
  const f = summarizeFaces([{ t: 1, faces: [{ box: [0.1, 0.1, 0.05, 0.05] }, { box: [0.4, 0.5, 0.2, 0.3] }] }]);
  assert.equal(f.acrossFrame.typical, 0.5);
  assert.equal(f.faceHeightShareOfFrame.typical, 0.3);
});

test("audio reads Earshot's real fields, which is where tempo and beats live", () => {
  const a = summarizeAudio({ music: { tempo: 120, confidence: "high", beats: [0, 0.5, 1, 1.5, 2] }, events: [{ t: 1, kind: "UI", label: "pop", prominence_db: 8 }, { t: 2, kind: "VOICE", prominence_db: 12 }], sync: { cuts: { items: [{ t: 1, offset_ms: 20, status: "OK", event_prominence_db: 8 }] } }, sections: [{ start: 0, end: 2, music_genre: [{ tag: "house" }], ast: { Music: 0.6 } }] }, [0.5, 0.75], 2);
  assert.equal(a.tempo, 120);
  assert.equal(a.joinsOnBeatShare, 0.5);
  assert.equal(a.soundEffects.count, 1);
  assert.equal(a.soundOnCuts!.onStrongAccent, 1);
  assert.deepEqual(a.sections[0].genre, ["house"]);
});

test("no steady beat means no claim about cutting on the beat", () => {
  assert.equal(summarizeAudio({ music: { confidence: "none", beats: [0, 1, 2, 3, 4] } }, [1], 5).joinsOnBeatShare, null);
});

test("moments cover transitions, punches, moves and things landing", () => {
  const moments = chooseMoments([{ t: 1, kind: "dissolve", seconds: 0.5, strength: 1 }, { t: 3, kind: "cut", seconds: 0, strength: 1 }], [{ t0: 4, t1: 6, kind: "push_in", rate: 3 }], [{ t: 7, kind: "punch_in" }], [2, 8], 10);
  assert.deepEqual(new Set(moments.map((m) => m.reason)), new Set(["dissolve", "cut", "push_in", "punch_in", "something lands on screen"]));
  assert.ok(moments.every((m) => m.t0 >= 0 && m.t1 <= 10 && m.t1 > m.t0));
});

test("shots come from every join", () => {
  assert.deepEqual(shotsFrom([{ t: 2, kind: "cut", seconds: 0, strength: 1 }, { t: 3, kind: "jump_cut", seconds: 0, strength: 1 }], 5), [{ t0: 0, t1: 2 }, { t0: 2, t1: 3 }, { t0: 3, t1: 5 }]);
});

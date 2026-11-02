import assert from "node:assert/strict";
import { test } from "node:test";
import type { EditDoc } from "../src/editdoc.ts";
import { analyzeTakes, applyOps, captionChunks, isRemoved, newDoc, segments, toOutput, totalDuration, wordSpan } from "../src/editdoc.ts";
import { editDistance } from "../src/lib/dsa.ts";
import { compile, toFcpxml, toSrt } from "../src/render.ts";

const source: EditDoc["source"] = { hash: "h", path: "/a.mp4", name: "a.mp4", duration: 10, width: 1920, height: 1080, fps: 30, locale: "en-US" };
const words = "one two three four five six seven eight".split(" ").map((text, i) => ({ text, start: i, end: i + 0.8 }));
const doc = () => newDoc(source, words);

test("removed ranges merge and restore", () => {
  let d = applyOps(doc(), [{ op: "remove_words", from: 1, to: 2 }, { op: "remove_words", from: 3, to: 3 }]);
  assert.deepEqual(d.removed, [[1, 3]]);
  assert.equal(isRemoved(d, 2), true);
  d = applyOps(d, [{ op: "restore_words", from: 2, to: 2 }]);
  assert.deepEqual(d.removed, [[1, 1], [3, 3]]);
  assert.equal(isRemoved(d, 2), false);
});

test("original document is never mutated", () => {
  const d = doc();
  applyOps(d, [{ op: "remove_words", from: 0, to: 1 }]);
  assert.deepEqual(d.removed, []);
});

test("segments never play a source frame twice", () => {
  const d = applyOps(doc(), [{ op: "remove_words", from: 2, to: 3 }]);
  const s = segments(d);
  assert.equal(s.length, 2);
  for (let i = 1; i < s.length; i++) assert.ok(s[i].start >= s[i - 1].end);
  assert.ok(Math.abs(totalDuration(s) - s.reduce((a, v) => a + v.end - v.start, 0)) < 1e-9);
});

test("word anchors survive a cut made after placement", () => {
  let d = applyOps(doc(), [{ op: "add_broll", from: 5, to: 6, path: "/b.mp4" }]);
  const before = wordSpan(d, segments(d), 5, 6).start;
  d = applyOps(d, [{ op: "remove_words", from: 1, to: 2 }]);
  const after = wordSpan(d, segments(d), 5, 6).start;
  assert.ok(after < before - 1.5, `moved from ${before} to ${after}`);
  assert.equal(d.broll[0].from, 5);
});

test("times inside a cut snap to the next kept moment", () => {
  const d = applyOps(doc(), [{ op: "remove_words", from: 2, to: 3 }]);
  const s = segments(d);
  assert.equal(toOutput(s, 2.5), s[1].outStart);
});

test("long pauses tighten but protected ones stay", () => {
  const spaced = newDoc(source, [{ text: "a.", start: 0, end: 1 }, { text: "b", start: 3, end: 4 }, { text: "c", start: 6, end: 7 }]);
  const tight = applyOps(spaced, [{ op: "set_max_pause", seconds: 0.3 }]);
  assert.equal(segments(tight).length, 3);
  const kept = applyOps(tight, [{ op: "keep_pause", word: 0 }]);
  assert.equal(segments(kept).length, 2);
});

test("overlapping B-roll is refused with a clear message", () => {
  const d = applyOps(doc(), [{ op: "add_broll", from: 1, to: 3, path: "/b.mp4", label: "Desk" }]);
  assert.throws(() => applyOps(d, [{ op: "add_broll", from: 3, to: 4, path: "/c.mp4" }]), /overlaps B-roll "Desk"/);
  assert.throws(() => applyOps(d, [{ op: "remove_words", from: 0, to: 99 }]), /outside/);
});

test("captions break on length, punctuation and removed words", () => {
  const d = applyOps(doc(), [{ op: "remove_words", from: 2, to: 2 }, { op: "set_captions", enabled: true, maxWords: 3 }]);
  const chunks = captionChunks(d, segments(d));
  assert.ok(chunks.every((c) => c.words.length <= 3));
  assert.ok(!chunks.flatMap((c) => c.words).some((w) => w.text === "three"));
});

test("analysis finds fillers, retakes and likely intentional pauses", () => {
  const take = (t: string, at: number, step = 0.3) => t.split(" ").map((text, i) => ({ text, start: at + i * step, end: at + i * step + 0.25 }));
  const w = [...take("So um the best way", 0), ...take("the best way to edit is fast.", 3), ...take("Why?", 7), ...take("Because time matters.", 9)];
  const d = newDoc({ ...source, duration: 12 }, w);
  const a = analyzeTakes(d.words, editDistance);
  assert.ok(a.fillers.some((f) => f.text === "um" && f.certain));
  assert.equal(a.retakes.length, 1);
  assert.ok(a.pauses.some((p) => p.question && p.maybeIntentional));
});

test("render graph includes every layer and valid exports", () => {
  const d = applyOps(doc(), [
    { op: "remove_words", from: 2, to: 2 },
    { op: "add_broll", from: 4, to: 5, path: "/b.mp4", label: "A & B" },
    { op: "add_sfx", word: 4, path: "/s.wav" },
    { op: "add_music", path: "/m.mp3" },
    { op: "set_captions", enabled: true },
  ]);
  const plan = compile(d, { output: "/o.mp4", captionsFile: "/c.mov" });
  const graph = plan.args[plan.args.indexOf("-filter_complex") + 1];
  for (const part of ["concat=n=2", "overlay", "sidechaincompress", "amix", "loudnorm", "adelay"]) assert.ok(graph.includes(part), part);
  assert.equal(plan.args.filter((a) => a === "-i").length, 5);
  const xml = toFcpxml(d, "Test <1>");
  assert.ok(xml.includes("A &amp; B") && xml.includes("Test &lt;1&gt;") && xml.includes('lane="1"'));
  assert.ok(toSrt(applyOps(d, [])).startsWith("1\n00:00:00,"));
});

test("an edit with no file is refused instead of failing later at render", () => {
  const doc = newDoc({ hash: "h", path: "/a.mp4", name: "a", duration: 2, width: 100, height: 100, fps: 30, locale: "en-US" }, [{ text: "hi", start: 0, end: 1 }]);
  assert.throws(() => applyOps(doc, [{ op: "add_sfx", word: 0 } as never]), /file path/);
});

const cutDoc = () => applyOps(newDoc(source, "one two three four five six seven eight".split(" ").map((text, i) => ({ text, start: i, end: i + 0.8 }))), [{ op: "remove_words", from: 3, to: 4 }]);

test("a transition keeps the length, so nothing anchored to a word moves", () => {
  const before = cutDoc();
  const after = applyOps(before, [{ op: "add_transition", word: 5, kind: "dissolve", seconds: 0.4 }]);
  const a = compile(before, { output: "/o.mp4" });
  const b = compile(after, { output: "/o.mp4" });
  assert.equal(b.duration, a.duration);
  const graph = b.args[b.args.indexOf("-filter_complex") + 1];
  const offset = Number(graph.match(/xfade=transition=dissolve:duration=0\.400:offset=([\d.]+)/)![1]);
  const join = segments(after)[1].outStart;
  assert.ok(Math.abs(offset + 0.2 - join) < 0.01, `transition centres on the cut, ${offset} and ${join}`);
});

test("a transition must sit on a cut, and says where the cuts are", () => {
  assert.throws(() => applyOps(cutDoc(), [{ op: "add_transition", word: 1, kind: "fade" }]), /Cuts are before words: 5/);
});

test("a later cut that removes a transition's word drops it instead of breaking the render", () => {
  const d = applyOps(applyOps(cutDoc(), [{ op: "add_transition", word: 5, kind: "fade", seconds: 0.2 }]), [{ op: "remove_words", from: 5, to: 5 }]);
  assert.equal(compile(d, { output: "/o.mp4" }).dropped, 1);
});

test("a whip uses a directional blur, because tmix turns part of a clip green", () => {
  const d = applyOps(cutDoc(), [{ op: "add_transition", word: 5, kind: "whip_left" }]);
  const graph = compile(d, { output: "/o.mp4" }).args.join(" ");
  assert.match(graph, /avgblur=sizeX=\d+:sizeY=1:enable/);
  assert.doesNotMatch(graph, /tmix/);
});

test("camera moves use a sub-pixel warp and only run while they're on screen", () => {
  const d = applyOps(doc(), [{ op: "add_move", from: 0, to: 2, kind: "push_in", amount: 0.1 }]);
  const graph = compile(d, { output: "/o.mp4" }).args.join(" ");
  assert.match(graph, /perspective=x0=.*interpolation=cubic:eval=frame:enable='between\(t,/);
});

test("every new layer compiles into one graph", () => {
  const d = applyOps(cutDoc(), [
    { op: "add_broll", from: 0, to: 1, path: "/b.mp4", enter: { kind: "slide_up", seconds: 0.3 }, exit: { kind: "fade", seconds: 0.2 }, box: { x: 0.5, y: 0.1, w: 0.4, h: 0.4 }, move: { kind: "push_in", amount: 0.1 }, speed: 1.5 },
    { op: "add_card", from: 2, to: 2, color: "#000000" },
    { op: "add_effect", from: 5, to: 5, kind: "flash" },
    { op: "add_effect", from: 6, to: 6, kind: "rgb_split" },
    { op: "add_graphic", from: 6, to: 7, path: "/g.mov", box: { x: 0.1, y: 0.1, w: 0.5, h: 0.5 }, enter: { kind: "fade", seconds: 0.2 } },
  ]);
  const graph = compile(d, { output: "/o.mp4", captionsFile: "/c.mov" }).args[compile(d, { output: "/o.mp4", captionsFile: "/c.mov" }).args.indexOf("-filter_complex") + 1];
  for (const part of ["drawbox=", "setpts=(PTS-STARTPTS)/1.500", "fade=t=in", "rgbashift", "[cap]overlay"]) assert.ok(graph.includes(part), part);
});

test("removing any new layer works by id", () => {
  const d = applyOps(doc(), [{ op: "add_card", from: 1, to: 1, color: "#FFFFFF" }]);
  assert.equal(applyOps(d, [{ op: "remove_item", id: d.cards[0].id }]).cards.length, 0);
});

test("styled words reach the captions, and placing a word starts a new block", () => {
  const d = applyOps(doc(), [{ op: "set_captions", maxWords: 4 }, { op: "style_words", from: 1, to: 1, scale: 2, font: "Didot-Italic" }, { op: "style_words", from: 2, to: 2, y: 0.7 }]);
  const chunks = captionChunks(d, segments(d));
  assert.equal(chunks[0].words[1].scale, 2);
  assert.equal(chunks[0].words[1].font, "Didot-Italic");
  assert.equal(chunks[1].words[0].text, "three");
  assert.equal(chunks[1].y, 0.7);
});

test("a saved version from before these layers still opens", () => {
  const { moves: _m, transitions: _t, cards: _c, effects: _e, emphasis: _s, reserved: _r, ...old } = doc();
  assert.equal(compile(old as EditDoc, { output: "/o.mp4" }).dropped, 0);
  assert.deepEqual(applyOps(old as EditDoc, [{ op: "keep_pause", word: 1 }]).moves, []);
});

test("a graphic can claim the words reserved for it", () => {
  const d = applyOps(doc(), [{ op: "reserve_graphic", id: "abc", from: 1, to: 2, label: "A chart" }]);
  assert.equal(d.reserved.length, 1);
  assert.equal(applyOps(d, [{ op: "add_graphic", from: 1, to: 2, path: "/g.mov", reservation: "abc" }]).reserved.length, 0);
});

test("a graphic that shows the words itself turns captions off under it, and only there", () => {
  const d = applyOps(doc(), [{ op: "set_captions", enabled: true }, { op: "add_graphic", from: 1, to: 2, path: "/g.mp4", hideCaptions: true }]);
  const shown = captionChunks(d, segments(d)).flatMap((c) => c.words.map((w) => w.text));
  assert.ok(!shown.includes("two") && !shown.includes("three"));
  assert.ok(shown.includes("one") && shown.includes("four"));
});

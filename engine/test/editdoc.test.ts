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

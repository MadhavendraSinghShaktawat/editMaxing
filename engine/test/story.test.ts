import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { findBin } from "../src/config.ts";
import { parseFolderPage } from "../src/drive.ts";
import { probe } from "../src/lib/media.ts";
import { run } from "../src/lib/proc.ts";
import { assemble, checkPicks, linesFrom } from "../src/story.ts";

const w = (text: string, start: number, end: number) => ({ text, start, end });

test("timed words become short lines at sentence ends and pauses", () => {
  const lines = linesFrom([w("Hello", 0, 0.4), w("there.", 0.45, 0.9), w("This", 1.0, 1.2), w("is", 1.25, 1.4), w("take", 3.0, 3.3), w("two", 3.35, 3.6)]);
  assert.deepEqual(lines.map((l) => l.text), ["Hello there.", "This is", "take two"]);
  assert.deepEqual([lines[2].from, lines[2].to], [3, 3.6]);
  assert.equal(linesFrom(Array.from({ length: 40 }, (_, i) => w("word", i * 0.3, i * 0.3 + 0.2))).length, 3, "long runs split at 16 words");
});

test("takes must sit inside a real clip", () => {
  const d = new Map([["/a.mp4", 10]]);
  assert.throws(() => checkPicks([], d), /at least one/);
  assert.throws(() => checkPicks([{ path: "/b.mp4", from: 0, to: 1 }], d), /isn't one of the clips/);
  assert.throws(() => checkPicks([{ path: "/a.mp4", from: 2, to: 2.1 }], d), /shorter than 0.2/);
  assert.throws(() => checkPicks([{ path: "/a.mp4", from: 8, to: 12 }], d), /outside its clip/);
  assert.doesNotThrow(() => checkPicks([{ path: "/a.mp4", from: 1, to: 4 }], d));
});

test("a public Drive folder page lists its videos and subfolders", () => {
  const entry = (id: string, href: string, type: string, name: string) => `<div class="flip-entry" id="entry-${id}" tabindex="0"><div class="flip-entry-info"><a href="${href}"><div class="flip-entry-list-icon"><img src="https://drive-thirdparty.googleusercontent.com/16/type/${type}" alt=""/></div><div class="flip-entry-title">${name}</div></a></div></div>`;
  const html = `<div class="flip-entries">${entry("1AAAAAAAAAAA", "https://drive.google.com/file/d/1AAAAAAAAAAA/view", "video/mp4", "C0079.MP4")}${entry("1BBBBBBBBBBB", "https://drive.google.com/drive/folders/1BBBBBBBBBBB", "application/vnd.google-apps.folder", "Day 2")}${entry("1CCCCCCCCCCC", "https://drive.google.com/file/d/1CCCCCCCCCCC/view", "application/pdf", "Shot list.pdf")}${entry("1DDDDDDDDDDD", "https://drive.google.com/file/d/1DDDDDDDDDDD/view", "video/quicktime", "Intro &amp; hook.mov")}</div>`;
  assert.deepEqual(parseFolderPage(html), { videos: [{ id: "1AAAAAAAAAAA", name: "C0079.MP4" }, { id: "1DDDDDDDDDDD", name: "Intro & hook.mov" }], folders: ["1BBBBBBBBBBB"] });
});

test("takes from clips of different sizes, one with no sound, join into one clean video", async () => {
  const dir = mkdtempSync(join(tmpdir(), "dojo-story-"));
  const ffmpeg = findBin("ffmpeg")!;
  const a = join(dir, "a.mp4");
  const b = join(dir, "b.mp4");
  await run(ffmpeg, ["-y", "-loglevel", "error", "-f", "lavfi", "-i", "testsrc2=size=1280x720:rate=30:duration=4", "-f", "lavfi", "-i", "sine=frequency=440:duration=4", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", a]);
  await run(ffmpeg, ["-y", "-loglevel", "error", "-f", "lavfi", "-i", "testsrc2=size=640x480:rate=25:duration=3", "-c:v", "libx264", "-pix_fmt", "yuv420p", b]);
  const out = join(dir, "story.mp4");
  const r = await assemble([{ path: a, from: 0.5, to: 2 }, { path: b, from: 1, to: 2.5 }, { path: a, from: 3, to: 3.8 }], out, dir);
  const info = await probe(out);
  assert.equal(info.width, 1280);
  assert.equal(info.height, 720);
  assert.ok(info.hasAudio, "the silent clip got silence, so the join keeps sound");
  assert.ok(Math.abs(info.duration - 3.8) < 0.25, `about 3.8s, got ${info.duration}`);
  assert.deepEqual(r.takes.map((t) => t.start), [0, 1.5, 3]);
  assert.ok(readFileSync(out).length > 10_000);
});

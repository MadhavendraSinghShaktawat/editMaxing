import assert from "node:assert/strict";
import { test } from "node:test";
import { looksLikeCorrection, similarity, tokens } from "../src/memory.ts";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { SHARED_STYLES } from "../src/config.ts";
import { checkSharedStyle, metricNames, toSharedStyle, verifyRules } from "../src/styles.ts";

const m = { duration: 60, cutsPerMinute: 10, medianShot: 4, brollShare: 0.3, wordsPerMinute: 150 };

test("rules need evidence inside the video", () => {
  const { kept, rejected } = verifyRules({ rules: [{ rule: "Punch in on claims", evidence: [{ at: 12, note: "zoom" }], confidence: "high" }, { rule: "Uses a logo sting", evidence: [{ at: 900, note: "?" }], confidence: "low" }] }, m);
  assert.equal(kept.length, 1);
  assert.match(rejected[0].reason, /timestamp/);
});

test("rules that contradict the measurements are rejected", () => {
  const { kept, rejected } = verifyRules({ rules: [{ rule: "Cut around 40 cuts per minute", evidence: [{ at: 3, note: "fast" }], confidence: "high" }, { rule: "Keep about 9 to 12 cuts per minute", evidence: [{ at: 3, note: "ok" }], confidence: "high" }] }, m);
  assert.equal(rejected.length, 1);
  assert.match(rejected[0].reason, /measured value is 10/);
  assert.equal(kept[0].rule, "Keep about 9 to 12 cuts per minute");
});

test("similar corrections match and ordinary requests are ignored", () => {
  assert.ok(similarity(tokens("fewer zooms on faces please"), tokens("too many zooms on faces")) >= 0.5);
  assert.ok(looksLikeCorrection("fewer zooms please"));
  assert.ok(!looksLikeCorrection("Great work, thanks"));
});

const base = { duration: 60, cutsPerMinute: 20, medianShot: 3, brollShare: 0.2, wordsPerMinute: 150 };
const rule = (area: string, at: number, extra = {}) => ({ rule: "Push in slowly", area, confidence: "high", evidence: [{ at, note: "x" }], ...extra });

test("a rule can't cite a moment Claude never saw", () => {
  const { rejected } = verifyRules({ rules: [rule("pacing", 30)] }, { ...base, seen: [{ t0: 10, t1: 11 }] });
  assert.match(rejected[0].reason, /never shown/);
});

test("a movement rule needs a frame sequence, because a still can't show movement", () => {
  const seen = [{ t0: 10, t1: 10 }, { t0: 20, t1: 21 }];
  const sequences = [{ t0: 20, t1: 21 }];
  assert.match(verifyRules({ rules: [rule("motion", 10)] }, { ...base, seen, sequences }).rejected[0].reason, /no frame sequence/);
  assert.equal(verifyRules({ rules: [rule("motion", 20.5)] }, { ...base, seen, sequences }).kept.length, 1);
  assert.equal(verifyRules({ rules: [rule("captions", 10)] }, { ...base, seen, sequences }).kept.length, 1);
});

test("a rule can't lean on a measurement that doesn't exist", () => {
  const { rejected } = verifyRules({ rules: [rule("pacing", 30, { metric: "madeUpNumber" })] }, { ...base, metrics: ["pace", "camera"] });
  assert.match(rejected[0].reason, /doesn't exist/);
});

test("a rule can name a nested measurement, either way round", () => {
  const metrics = metricNames({ pace: { typicalGapSeconds: 0.6 }, camera: { share: { static: 1 } } });
  for (const metric of ["typicalGapSeconds", "pace.typicalGapSeconds", "camera.share.static"]) assert.equal(verifyRules({ rules: [rule("pacing", 30, { metric })] }, { ...base, metrics }).kept.length, 1, metric);
});

const area = { summary: "x", rules: [] };
const shared = () => ({ schema: 1 as const, name: "Quiet Desk", author: "Maddy", mode: null, card: { pacing: area, editing: area, audio: area, captions: area, positioning: area, motion: area, animation: area, effects: area } });

test("a complete style is ready for the repo", () => {
  assert.deepEqual(checkSharedStyle(shared()), []);
});

test("a shared style must fill in every area and name its author", () => {
  const { motion: _motion, ...card } = shared().card;
  const problems = checkSharedStyle({ ...shared(), author: "", card });
  assert.ok(problems.some((p) => p.includes("author")));
  assert.ok(problems.some((p) => p.includes("Motion")));
});

test("nothing private can reach the repo", () => {
  const leak = shared();
  (leak.card as Record<string, unknown>).structure = "From /Users/maddy/Movies/client.mp4";
  assert.match(checkSharedStyle(leak).join(), /file path/);
  const exported = toSharedStyle({ name: "A", mode: null, card: { ...shared().card, rejected: [], sourceHash: "abc" } }, "Maddy");
  assert.ok(!("rejected" in exported.card) && !("sourceHash" in exported.card));
});

test("colour grading stays out of shared styles", () => {
  const graded = shared();
  graded.card.motion = { summary: "x", rules: [{ rule: "Apply a teal LUT" }] as never };
  assert.match(checkSharedStyle(graded).join(), /colour grading/);
});

test("every style in the repo passes the check", () => {
  for (const slug of readdirSync(SHARED_STYLES)) {
    const path = join(SHARED_STYLES, slug, "style.json");
    if (existsSync(path)) assert.deepEqual(checkSharedStyle(JSON.parse(readFileSync(path, "utf8"))), [], slug);
  }
});

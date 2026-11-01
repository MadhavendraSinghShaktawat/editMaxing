import assert from "node:assert/strict";
import { test } from "node:test";
import { looksLikeCorrection, similarity, tokens } from "../src/memory.ts";
import { verifyRules } from "../src/styles.ts";

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

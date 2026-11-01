import assert from "node:assert/strict";
import { test } from "node:test";
import { AsyncQueue, BKTree, Heap, SlidingMedian, TokenBucket, UnionFind, cosine, editDistance, hamming, kmeans, lowerBound, mmr, reciprocalRank, topK } from "../src/lib/dsa.ts";

test("heap pops in order and removes", () => {
  const h = new Heap<number>((a, b) => a < b);
  [5, 1, 4, 2, 3].forEach((v) => h.push(v));
  assert.equal(h.remove((v) => v === 4), 1);
  assert.deepEqual([h.pop(), h.pop(), h.pop(), h.pop(), h.pop()], [1, 2, 3, 5, undefined]);
});

test("topK agrees with a full sort", () => {
  const data = Array.from({ length: 5000 }, () => Math.random());
  const expected = [...data].sort((a, b) => b - a).slice(0, 25);
  assert.deepEqual(topK(data, 25, (v) => v).map((r) => r.v), expected);
});

test("async queue delivers in order, before and after waiting", async () => {
  const q = new AsyncQueue<number>();
  q.push(1);
  const it = q[Symbol.asyncIterator]();
  assert.equal((await it.next()).value, 1);
  const pending = it.next();
  q.push(2);
  assert.equal((await pending).value, 2);
  q.close();
  assert.equal((await it.next()).done, true);
});

test("hamming counts differing bits across 64 bits", () => {
  assert.equal(hamming("0000000000000000", "ffffffffffffffff"), 64);
  assert.equal(hamming("ffffffff00000000", "ffffffff00000001"), 1);
  assert.equal(hamming("80000000ffffffff", "00000000ffffffff"), 1);
});

test("BK-tree finds exactly what a linear scan finds", () => {
  const tree = new BKTree();
  const hashes: string[] = [];
  const rand = () => Math.floor(Math.random() * 2 ** 32).toString(16).padStart(8, "0");
  for (let i = 0; i < 800; i++) {
    const h = rand() + rand();
    hashes.push(h);
    tree.add(h, String(i));
  }
  const q = hashes[37];
  const scan = hashes.map((h, i) => ({ id: String(i), d: hamming(q, h) })).filter((r) => r.d <= 24).map((r) => r.id).sort();
  assert.deepEqual(tree.near(q, 24).map((r) => r.id).sort(), scan);
});

test("union find merges groups", () => {
  const u = new UnionFind();
  u.union("a", "b");
  u.union("b", "c");
  assert.equal(u.find("a"), u.find("c"));
  assert.notEqual(u.find("a"), u.find("z"));
});

test("sliding median tracks the window", () => {
  const m = new SlidingMedian(3);
  [1, 9, 2].forEach((v) => m.push(v));
  assert.equal(m.median, 2);
  m.push(100);
  assert.equal(m.median, 9);
});

test("lower bound", () => {
  assert.equal(lowerBound([1, 3, 3, 5], 3), 1);
  assert.equal(lowerBound([1, 3], 9), 2);
});

test("token bucket waits when empty", async () => {
  const b = new TokenBucket(1, 50);
  const t = Date.now();
  await b.take();
  await b.take();
  assert.ok(Date.now() - t >= 10);
});

test("edit distance on tokens", () => {
  assert.equal(editDistance("kitten".split(""), "sitting".split("")), 3);
  assert.equal(editDistance([], ["a"]), 1);
});

test("reciprocal rank rewards agreement between lists", () => {
  const s = reciprocalRank([["a", "b"], ["b", "c"]]);
  assert.ok(s.get("b")! > s.get("a")!);
});

test("mmr keeps relevance but avoids near copies", () => {
  const items = [{ id: "a", r: 1, g: 1 }, { id: "b", r: 0.99, g: 1 }, { id: "c", r: 0.6, g: 2 }];
  const out = mmr(items, (v) => v.r, (x, y) => (x.g === y.g ? 1 : 0), 2, 0.5);
  assert.deepEqual(out.map((v) => v.id), ["a", "c"]);
});

test("cosine and k-means", () => {
  assert.ok(Math.abs(cosine(new Float32Array([1, 0]), new Float32Array([1, 0])) - 1) < 1e-6);
  const pts = [...Array(50).fill([0, 0, 0]), ...Array(50).fill([1, 1, 1])].map((p) => [...p]);
  const c = kmeans(pts, 2);
  assert.equal(c.length, 2);
  assert.ok(Math.abs(c[0].weight - 0.5) < 1e-6);
});

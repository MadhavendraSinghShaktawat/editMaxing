/** Small, dependency-free data structures used across the engine. */

/** Binary heap. O(log n) push and pop. */
export class Heap<T> {
  private items: T[] = [];
  private before: (a: T, b: T) => boolean;

  constructor(before: (a: T, b: T) => boolean) {
    this.before = before;
  }

  get size() {
    return this.items.length;
  }

  peek(): T | undefined {
    return this.items[0];
  }

  push(value: T) {
    const a = this.items;
    a.push(value);
    let i = a.length - 1;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (!this.before(a[i], a[parent])) break;
      [a[i], a[parent]] = [a[parent], a[i]];
      i = parent;
    }
  }

  pop(): T | undefined {
    const a = this.items;
    if (!a.length) return undefined;
    const top = a[0];
    const last = a.pop()!;
    if (a.length) {
      a[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        const r = l + 1;
        let best = i;
        if (l < a.length && this.before(a[l], a[best])) best = l;
        if (r < a.length && this.before(a[r], a[best])) best = r;
        if (best === i) break;
        [a[i], a[best]] = [a[best], a[i]];
        i = best;
      }
    }
    return top;
  }

  remove(match: (v: T) => boolean) {
    const kept = this.items.filter((v) => !match(v));
    const removed = this.items.length - kept.length;
    this.items = [];
    for (const v of kept) this.push(v);
    return removed;
  }
}

/** Top-k by score in O(n log k), which beats sorting the whole library on every search. */
export function topK<T>(items: Iterable<T>, k: number, score: (v: T) => number) {
  const heap = new Heap<{ v: T; s: number }>((a, b) => a.s < b.s);
  for (const v of items) {
    const s = score(v);
    if (heap.size < k) heap.push({ v, s });
    else if (s > heap.peek()!.s) {
      heap.pop();
      heap.push({ v, s });
    }
  }
  const out: { v: T; s: number }[] = [];
  while (heap.size) out.push(heap.pop()!);
  return out.reverse();
}

/** Async FIFO, used as the streaming input of a chat. */
export class AsyncQueue<T> implements AsyncIterable<T> {
  private values: T[] = [];
  private waiters: ((r: IteratorResult<T>) => void)[] = [];
  private closed = false;

  push(value: T) {
    if (this.closed) return;
    const w = this.waiters.shift();
    if (w) w({ value, done: false });
    else this.values.push(value);
  }

  close() {
    this.closed = true;
    for (const w of this.waiters.splice(0)) w({ value: undefined as never, done: true });
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: () => {
        if (this.values.length) return Promise.resolve({ value: this.values.shift()!, done: false });
        if (this.closed) return Promise.resolve({ value: undefined as never, done: true });
        return new Promise((resolve) => this.waiters.push(resolve));
      },
      return: () => {
        this.close();
        return Promise.resolve({ value: undefined as never, done: true });
      },
    };
  }
}

export const popcount32 = (v: number) => {
  let n = v - ((v >>> 1) & 0x55555555);
  n = (n & 0x33333333) + ((n >>> 2) & 0x33333333);
  return (((n + (n >>> 4)) & 0x0f0f0f0f) * 0x01010101) >>> 24;
};

/** Hamming distance of two 64-bit hashes stored as 16 hex characters. */
export function hamming(a: string, b: string) {
  let d = 0;
  for (let i = 0; i < 16; i += 8) {
    d += popcount32((parseInt(a.slice(i, i + 8), 16) ^ parseInt(b.slice(i, i + 8), 16)) >>> 0);
  }
  return d;
}

/** BK-tree over Hamming distance: finds near-duplicate frames without comparing every pair. */
export class BKTree {
  private root: { hash: string; id: string; kids: Map<number, unknown> } | null = null;

  add(hash: string, id: string) {
    type N = { hash: string; id: string; kids: Map<number, N> };
    const node: N = { hash, id, kids: new Map() };
    if (!this.root) {
      this.root = node;
      return;
    }
    let cur = this.root as N;
    for (;;) {
      const d = hamming(hash, cur.hash);
      const next = cur.kids.get(d);
      if (!next) {
        cur.kids.set(d, node);
        return;
      }
      cur = next;
    }
  }

  near(hash: string, radius: number) {
    type N = { hash: string; id: string; kids: Map<number, N> };
    const found: { id: string; distance: number }[] = [];
    const stack: N[] = this.root ? [this.root as N] : [];
    while (stack.length) {
      const cur = stack.pop()!;
      const d = hamming(hash, cur.hash);
      if (d <= radius) found.push({ id: cur.id, distance: d });
      // Triangle inequality: only children within [d-radius, d+radius] can match.
      for (const [edge, kid] of cur.kids) if (Math.abs(edge - d) <= radius) stack.push(kid);
    }
    return found.sort((a, b) => a.distance - b.distance);
  }
}

/** Union-find with path compression, used to merge near-identical category names. */
export class UnionFind {
  private parent = new Map<string, string>();

  find(x: string): string {
    if (!this.parent.has(x)) this.parent.set(x, x);
    let root = x;
    while (this.parent.get(root) !== root) root = this.parent.get(root)!;
    let cur = x;
    while (cur !== root) {
      const next = this.parent.get(cur)!;
      this.parent.set(cur, root);
      cur = next;
    }
    return root;
  }

  union(a: string, b: string) {
    this.parent.set(this.find(a), this.find(b));
  }
}

/** Keeps the median of a sliding window in O(log n) per step for shot detection. */
export class SlidingMedian {
  private sorted: number[] = [];
  private order: number[] = [];
  private size: number;

  constructor(size: number) {
    this.size = size;
  }

  push(v: number) {
    this.sorted.splice(lowerBound(this.sorted, v), 0, v);
    this.order.push(v);
    if (this.order.length > this.size) {
      this.sorted.splice(lowerBound(this.sorted, this.order.shift()!), 1);
    }
  }

  get median() {
    const n = this.sorted.length;
    if (!n) return 0;
    return n % 2 ? this.sorted[n >> 1] : (this.sorted[(n >> 1) - 1] + this.sorted[n >> 1]) / 2;
  }
}

/** First index where a[i] >= value. */
export function lowerBound(a: ArrayLike<number>, value: number) {
  let lo = 0;
  let hi = a.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (a[mid] < value) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** Token bucket rate limiter for outside APIs. */
export class TokenBucket {
  private tokens: number;
  private capacity: number;
  private perSecond: number;
  private last = Date.now();

  constructor(capacity: number, perSecond: number) {
    this.capacity = capacity;
    this.tokens = capacity;
    this.perSecond = perSecond;
  }

  async take(n = 1) {
    for (;;) {
      const now = Date.now();
      this.tokens = Math.min(this.capacity, this.tokens + ((now - this.last) / 1000) * this.perSecond);
      this.last = now;
      if (this.tokens >= n) {
        this.tokens -= n;
        return;
      }
      await new Promise((r) => setTimeout(r, Math.ceil(((n - this.tokens) / this.perSecond) * 1000)));
    }
  }
}

/** Levenshtein distance on tokens with one rolling row. O(nm) time, O(m) space. */
export function editDistance<T>(a: readonly T[], b: readonly T[]) {
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const next = [i];
    for (let j = 1; j <= b.length; j++) {
      next[j] = Math.min(row[j] + 1, next[j - 1] + 1, row[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    row = next;
  }
  return row[b.length];
}

/** Reciprocal rank fusion: merges ranked lists without needing comparable scores. */
export function reciprocalRank(lists: string[][], k = 60) {
  const scores = new Map<string, number>();
  for (const list of lists) {
    list.forEach((id, rank) => scores.set(id, (scores.get(id) ?? 0) + 1 / (k + rank + 1)));
  }
  return scores;
}

/** Maximal marginal relevance: keeps results good but not near copies of each other. */
export function mmr<T>(items: T[], relevance: (v: T) => number, similarity: (a: T, b: T) => number, k: number, lambda = 0.72) {
  const left = [...items];
  const out: T[] = [];
  while (out.length < k && left.length) {
    let best = 0;
    let bestScore = -Infinity;
    left.forEach((item, i) => {
      const penalty = out.length ? Math.max(...out.map((o) => similarity(item, o))) : 0;
      const score = lambda * relevance(item) - (1 - lambda) * penalty;
      if (score > bestScore) {
        bestScore = score;
        best = i;
      }
    });
    out.push(left.splice(best, 1)[0]);
  }
  return out;
}

export function cosine(a: Float32Array, b: Float32Array) {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return na && nb ? dot / Math.sqrt(na * nb) : 0;
}

/** Deterministic k-means in the given colour space, for dominant colours. */
export function kmeans(points: number[][], k: number, rounds = 12) {
  if (!points.length) return [];
  const step = Math.max(1, Math.floor(points.length / k));
  const centers = Array.from({ length: Math.min(k, points.length) }, (_, i) => [...points[i * step]]);
  const counts = new Array(centers.length).fill(0);
  for (let round = 0; round < rounds; round++) {
    const sums = centers.map((c) => c.map(() => 0));
    counts.fill(0);
    for (const p of points) {
      let best = 0;
      let dist = Infinity;
      centers.forEach((c, i) => {
        const d = c.reduce((s, v, n) => s + (v - p[n]) ** 2, 0);
        if (d < dist) {
          dist = d;
          best = i;
        }
      });
      counts[best]++;
      p.forEach((v, n) => (sums[best][n] += v));
    }
    centers.forEach((c, i) => {
      if (counts[i]) c.forEach((_, n) => (c[n] = sums[i][n] / counts[i]));
    });
  }
  return centers.map((center, i) => ({ center, weight: counts[i] / points.length })).sort((a, b) => b.weight - a.weight);
}

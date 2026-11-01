import { TokenBucket } from "./lib/dsa.ts";

const URL = "https://openrouter.ai/api/v1/embeddings";
const limiter = new TokenBucket(4, 2);

/** Sends meaning-card text only. Frames never go to the embedding provider. */
export async function embed(texts: string[], model: string, key: string, fetcher: typeof fetch = fetch, signal?: AbortSignal) {
  let wait = 1000;
  for (let attempt = 0; ; attempt++) {
    await limiter.take();
    const res = await fetcher(URL, { method: "POST", signal, headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" }, body: JSON.stringify({ model, input: texts }) });
    if (res.ok) {
      const body = (await res.json()) as { data: { index: number; embedding: number[] }[] };
      return [...body.data].sort((a, b) => a.index - b.index).map((d) => Float32Array.from(d.embedding));
    }
    if ((res.status === 429 || res.status >= 500) && attempt < 4) {
      await new Promise((r) => setTimeout(r, wait));
      wait *= 2;
      continue;
    }
    throw new Error(`Embedding failed (${res.status}): ${(await res.text()).slice(0, 200)}`);
  }
}

export const toBytes = (v: Float32Array) => new Uint8Array(v.buffer, v.byteOffset, v.byteLength);
export const fromBytes = (b: Uint8Array) => new Float32Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength));

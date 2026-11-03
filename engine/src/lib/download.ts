import { createWriteStream, existsSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as WebStream } from "node:stream/web";

export const MAX_BYTES = 4 * 1024 ** 3;

/** What a partial download remembers between runs: where it came from, how big it is, and its name. */
export type PartMeta = { url: string; total?: number; name?: string };

export const readMeta = (part: string): PartMeta | null => {
  try {
    return JSON.parse(readFileSync(`${part}.json`, "utf8")) as PartMeta;
  } catch {
    return null;
  }
};
export const writeMeta = (part: string, meta: PartMeta) => writeFileSync(`${part}.json`, JSON.stringify(meta));
export const dropPart = (part: string) => {
  rmSync(part, { force: true });
  rmSync(`${part}.json`, { force: true });
};

type Options = {
  fetcher?: typeof fetch; signal?: AbortSignal; headers?: Record<string, string>;
  /** Every hop is checked before it's fetched, so a redirect can't reach a private address. */
  allow?: (url: string) => boolean;
  onProgress?: (done: number, total: number | null) => void;
  /** Rejects a response before any byte is written, such as an HTML page instead of a video. */
  accept?: (res: Response) => string | null;
  /** Sees the final response first, to read a file name from its headers. */
  onResponse?: (res: Response) => void;
};

/**
 * Downloads into `part`, carrying on from whatever is already there. A server that honours the
 * byte range continues the file; one that sends the whole file again starts it over. The part
 * stays on disk when the download is interrupted, so the next run picks up where this one stopped.
 */
export async function resumable(url: string, part: string, o: Options = {}) {
  const fetcher = o.fetcher ?? fetch;
  const meta = readMeta(part);
  // A different source means different bytes, so a part from elsewhere can't be continued.
  if (meta && meta.url !== url) dropPart(part);
  let have = existsSync(part) ? statSync(part).size : 0;
  writeMeta(part, { ...(meta?.url === url ? meta : {}), url });

  let res: Response | null = null;
  let next = url;
  for (let hop = 0; hop < 6; hop++) {
    if (o.allow && !o.allow(next)) throw new Error("the video host redirected somewhere private");
    res = await fetcher(next, { headers: { ...o.headers, ...(have ? { Range: `bytes=${have}-` } : {}) }, redirect: "manual", signal: o.signal });
    const to = res.status >= 300 && res.status < 400 ? res.headers.get("location") : null;
    if (!to) break;
    next = new URL(to, next).toString();
    res = null;
  }
  if (!res) throw new Error("the video host redirected too many times");

  const total = (() => {
    const range = res.headers.get("content-range")?.match(/\/(\d+)$/)?.[1];
    if (range) return Number(range);
    const length = Number(res.headers.get("content-length") ?? 0);
    return length ? (res.status === 206 ? have + length : length) : null;
  })();
  // Asked for bytes past the end: the file was already complete.
  if (res.status === 416 && have > 0) return { bytes: have, total: have, resumed: true };
  if (!res.ok || !res.body) throw new Error(`the host answered ${res.status}`);
  o.onResponse?.(res);
  const refused = o.accept?.(res);
  if (refused) throw new Error(refused);
  if ((total ?? 0) > MAX_BYTES) throw new Error("the video is over 4 GB");

  const resumed = res.status === 206 && have > 0;
  if (!resumed) have = 0;
  writeMeta(part, { ...readMeta(part), url, total: total ?? undefined });
  let done = have;
  o.onProgress?.(done, total);
  const stream = Readable.fromWeb(res.body as unknown as WebStream<Uint8Array>);
  stream.on("data", (c: Buffer) => {
    done += c.length;
    if (done > MAX_BYTES) stream.destroy(new Error("the video is over 4 GB"));
    o.onProgress?.(done, total);
  });
  await pipeline(stream, createWriteStream(part, { flags: resumed ? "a" : "w" }));
  if (total && done < total) throw new Error("the download stopped early");
  return { bytes: done, total: total ?? done, resumed };
}

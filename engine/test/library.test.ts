import assert from "node:assert/strict";
import { test } from "node:test";
import { downloadFile, listFolder, parseDriveLink } from "../src/drive.ts";
import { embed, fromBytes, toBytes } from "../src/embeddings.ts";
import { meaningText, nextBatch, validCard } from "../src/library.ts";

test("Drive links parse", () => {
  assert.deepEqual(parseDriveLink("https://drive.google.com/file/d/1AbCdEfGhIjKlMn/view?usp=sharing"), { kind: "file", id: "1AbCdEfGhIjKlMn" });
  assert.deepEqual(parseDriveLink("https://drive.google.com/open?id=1AbCdEfGhIjKlMn"), { kind: "file", id: "1AbCdEfGhIjKlMn" });
  assert.deepEqual(parseDriveLink("https://drive.google.com/drive/folders/1AbCdEfGhIjKlMn?usp=drive_link"), { kind: "folder", id: "1AbCdEfGhIjKlMn" });
  assert.deepEqual(parseDriveLink("https://drive.google.com/drive/u/0/folders/1AbCdEfGhIjKlMn"), { kind: "folder", id: "1AbCdEfGhIjKlMn" });
  assert.equal(parseDriveLink("https://example.com/x"), null);
});

test("folder listing walks subfolders once and keeps only video", async () => {
  const pages: Record<string, unknown> = {
    root: { files: [{ id: "sub", name: "s", mimeType: "application/vnd.google-apps.folder" }, { id: "v1", name: "a.mp4", mimeType: "video/mp4" }, { id: "d", name: "n.pdf", mimeType: "application/pdf" }] },
    sub: { files: [{ id: "root", name: "loop", mimeType: "application/vnd.google-apps.folder" }, { id: "v2", name: "b.mov", mimeType: "video/quicktime" }] },
  };
  const fake = (async (url: string) => {
    const id = new URL(url).searchParams.get("q")!.match(/'(.+?)'/)![1];
    return new Response(JSON.stringify(pages[id]), { status: 200 });
  }) as unknown as typeof fetch;
  assert.deepEqual((await listFolder("root", "key", fake)).map((f) => f.id).sort(), ["v1", "v2"]);
});

test("a private Drive file gives a clear error instead of saving HTML", async () => {
  const fake = (async () => new Response("<html>", { status: 200, headers: { "content-type": "text/html" } })) as unknown as typeof fetch;
  await assert.rejects(downloadFile({} as never, "id", "a.mp4", null, undefined, fake), /isn't downloadable/);
});

test("embeddings keep order and retry on rate limits", async () => {
  let calls = 0;
  const fake = (async (_: string, init: { body: string; headers: Record<string, string> }) => {
    assert.equal(init.headers.Authorization, "Bearer k");
    if (++calls === 1) return new Response("slow down", { status: 429 });
    assert.deepEqual(JSON.parse(init.body).input, ["a", "b"]);
    return new Response(JSON.stringify({ data: [{ index: 1, embedding: [0, 1] }, { index: 0, embedding: [1, 0] }] }));
  }) as unknown as typeof fetch;
  const [a, b] = await embed(["a", "b"], "m", "k", fake);
  assert.equal(calls, 2);
  assert.deepEqual([...a], [1, 0]);
  assert.deepEqual([...b], [0, 1]);
});

test("vectors survive a round trip through bytes", () => {
  const v = Float32Array.from([0.25, -1, 3.5]);
  assert.deepEqual([...fromBytes(toBytes(v))], [...v]);
});

test("batches grow while clean and fall back fast", () => {
  assert.equal(nextBatch(10, true, 40), 20);
  assert.equal(nextBatch(40, true, 40), 40);
  assert.equal(nextBatch(30, false, 40), 15);
  assert.equal(nextBatch(10, false, 40), 10);
});

test("cards must carry meaning, not just a description", () => {
  const card = { id: "1", summary: "A runner crosses a bridge at dawn in cold light.", subject: "runner", action: "running", objects: ["bridge"], setting: "city", lighting: "dawn", camera: "wide", people: "one", mood: ["calm"], meanings: ["discipline", "early start", "pushing limits"], goodFor: ["I never skipped a day"], avoid: [], visibleText: "", category: ["People", "Exercise"] };
  assert.ok(validCard(card));
  assert.ok(!validCard({ ...card, meanings: ["one"] }));
  assert.ok(meaningText(card).includes("discipline"));
});

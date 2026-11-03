import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Bus } from "../src/bus.ts";
import { Database } from "../src/db.ts";
import { Jobs } from "../src/jobs.ts";
import { readMeta, resumable } from "../src/lib/download.ts";
import { checkLink, linkKey, Links } from "../src/links.ts";
import { BLEND_SCHEMA, Styles, verifyBlended } from "../src/styles.ts";
import { Access } from "../src/team/access.ts";
import { Team } from "../src/team/team.ts";

const dir = () => mkdtempSync(join(tmpdir(), "dojo-resume-"));
const bytes = (n: number) => Buffer.from(Array.from({ length: n }, (_, i) => i % 251));

/** A file server that honours byte ranges, or ignores them, and can stop partway. */
function server(body: Buffer, o: { ranges?: boolean; cutAt?: number } = {}) {
  const seen: string[] = [];
  const f = (async (_url: string, init?: RequestInit) => {
    const range = (init?.headers as Record<string, string> | undefined)?.Range;
    seen.push(range ?? "none");
    const from = range && o.ranges !== false ? Number(range.match(/bytes=(\d+)-/)![1]) : 0;
    if (from >= body.length && range) return new Response(null, { status: 416 });
    const slice = body.subarray(from, o.cutAt && !range ? o.cutAt : body.length);
    const headers: Record<string, string> = { "content-type": "video/mp4", "content-length": String(body.length - from) };
    if (range && o.ranges !== false) headers["content-range"] = `bytes ${from}-${body.length - 1}/${body.length}`;
    // A cut connection: the body ends before content-length says it should.
    return new Response(slice, { status: range && o.ranges !== false ? 206 : 200, headers });
  }) as unknown as typeof fetch;
  return { f, seen };
}

test("an interrupted download carries on from the byte where it stopped", async () => {
  const body = bytes(50_000);
  const part = join(dir(), "a.part");
  const cut = server(body, { cutAt: 20_000 });
  await assert.rejects(resumable("https://cdn.example.com/a.mp4", part, { fetcher: cut.f }), /stopped early/);
  assert.equal(statSync(part).size, 20_000, "the bytes already fetched are kept");
  const rest = server(body);
  const r = await resumable("https://cdn.example.com/a.mp4", part, { fetcher: rest.f });
  assert.deepEqual(rest.seen, ["bytes=20000-"]);
  assert.ok(r.resumed);
  assert.deepEqual(readFileSync(part), body, "the joined file is byte for byte the original");
});

test("a server that ignores ranges starts the file over, and a different source never continues another's part", async () => {
  const body = bytes(9_000);
  const part = join(dir(), "b.part");
  writeFileSync(part, bytes(3_000));
  writeFileSync(`${part}.json`, JSON.stringify({ url: "https://cdn.example.com/b.mp4" }));
  await resumable("https://cdn.example.com/b.mp4", part, { fetcher: server(body, { ranges: false }).f });
  assert.deepEqual(readFileSync(part), body);
  const other = server(body);
  await resumable("https://cdn.example.com/other.mp4", part, { fetcher: other.f });
  assert.deepEqual(other.seen, ["none"], "a part from elsewhere is dropped, not continued");
  assert.equal(readMeta(part)?.url, "https://cdn.example.com/other.mp4");
});

test("a finished part is recognised without downloading again", async () => {
  const body = bytes(4_000);
  const part = join(dir(), "c.part");
  writeFileSync(part, body);
  writeFileSync(`${part}.json`, JSON.stringify({ url: "https://cdn.example.com/c.mp4" }));
  const r = await resumable("https://cdn.example.com/c.mp4", part, { fetcher: server(body).f });
  assert.equal(r.bytes, 4_000);
});

test("the same video under different links shares one key", () => {
  assert.equal(linkKey("https://drive.google.com/file/d/1AbCdEfGhIjKlMn/view?usp=sharing"), linkKey("https://drive.google.com/open?id=1AbCdEfGhIjKlMn"));
  assert.equal(linkKey("https://www.instagram.com/reel/DfGTuV5gxPW/?igsh=abc"), linkKey("https://instagram.com/reel/DfGTuV5gxPW"));
  assert.notEqual(linkKey("https://www.instagram.com/reel/AAA/"), linkKey("https://www.instagram.com/reel/BBB/"));
  assert.throws(() => checkLink("https://drive.google.com/drive/folders/1AbCdEfGhIjKlMn"), /folder/);
  assert.throws(() => checkLink("https://www.youtube.com/watch?v=x"), /isn't supported/);
});

function linksStudio(fetcher: typeof fetch, scrape: string | null = null) {
  const d = dir();
  const db = new Database(join(d, "dojo.db"));
  const bus = new Bus();
  const jobs = new Jobs(db, bus);
  const stored = new Map<string, { hash: string; path: string; name: string; size: number; kind: "video"; meta: Record<string, unknown> }>();
  const files = {
    get: (hash: string) => { const f = stored.get(hash); if (!f) throw new Error("gone"); return f; },
    fromPath: async (path: string, name: string) => { const hash = randomUUID().replace(/-/g, ""); const f = { hash, path, name, size: statSync(path).size, kind: "video" as const, meta: {} }; stored.set(hash, f); return f; },
  };
  const links = new Links(db, files as never, jobs, { scrape: async () => scrape, google: async () => null }, fetcher);
  db.run("INSERT INTO members (id, name, role, webauthn_id, created_at) VALUES ('m1', 'Ana', 'editor', 'w', 0)");
  return { db, jobs, links, stored, files };
}

test("a link fetched before returns its file at once, with no download", async () => {
  const s = linksStudio((async () => { throw new Error("must not fetch"); }) as unknown as typeof fetch);
  const file = join(dir(), "clip.mp4");
  writeFileSync(file, bytes(10));
  const stored = await s.files.fromPath(file, "clip.mp4");
  s.db.run("INSERT INTO link_cache (key, hash, name, platform, created_at) VALUES (?, ?, 'clip.mp4', 'Google Drive', 0)", linkKey("https://drive.google.com/file/d/1AbCdEfGhIjKlMn/view"), stored.hash);
  const out = await s.links.start("m1", "https://drive.google.com/open?id=1AbCdEfGhIjKlMn");
  assert.ok("file" in out && out.file.file.hash === stored.hash);
  assert.equal(s.db.get<{ n: number }>("SELECT COUNT(*) n FROM jobs")!.n, 0);
});

test("pasting a link that's already downloading joins that download instead of starting another", async () => {
  let release: () => void = () => {};
  const gate = new Promise<void>((r) => (release = r));
  const s = linksStudio((async () => { await gate; return new Response("x", { status: 500 }); }) as unknown as typeof fetch);
  const a = await s.links.start("m1", "https://drive.google.com/file/d/1AbCdEfGhIjKlMn/view");
  const b = await s.links.start("m1", "https://drive.google.com/open?id=1AbCdEfGhIjKlMn");
  assert.ok("job" in a && "job" in b && a.job === b.job);
  release();
});

test("social links need the person's Scrape Creators key before anything starts", async () => {
  const s = linksStudio((async () => new Response("")) as unknown as typeof fetch, null);
  await assert.rejects(s.links.start("m1", "https://www.instagram.com/reel/DfGTuV5gxPW/"), /Scrape Creators key/);
  assert.equal(s.db.get<{ n: number }>("SELECT COUNT(*) n FROM jobs")!.n, 0);
});

// ── Blended styles ──────────────────────────────────────────────

const m = (seen: { t0: number; t1: number }[]) => ({ duration: 60, cutsPerMinute: 10, medianShot: 3, brollShare: 0.2, wordsPerMinute: 150, seen, sequences: seen });

test("each evidence item in a blended style is checked against the video it cites", () => {
  const refs = [m([{ t0: 10, t1: 11 }]), m([{ t0: 40, t1: 41 }])];
  const rule = (evidence: { at: number; note: string; ref?: number }[]) => ({ rule: "Push in on claims", area: "pacing", confidence: "high", evidence });
  const { kept, rejected } = verifyBlended([
    rule([{ at: 10.2, note: "a", ref: 1 }, { at: 40.5, note: "b", ref: 2 }]),
    rule([{ at: 40.5, note: "wrong video", ref: 1 }]),
    rule([{ at: 10.2, note: "no such video", ref: 3 }]),
  ], refs);
  assert.equal(kept.length, 1);
  assert.equal(kept[0].evidence.length, 2);
  assert.match(rejected[0].reason, /never shown/);
  assert.match(rejected[1].reason, /video 3/);
});

test("a blended card must say which video each moment comes from", () => {
  const evidence = (BLEND_SCHEMA as unknown as { properties: { pacing: { properties: { rules: { items: { properties: { evidence: { items: { required: string[]; properties: Record<string, unknown> } } } } } } } } }).properties.pacing.properties.rules.items.properties.evidence.items;
  assert.deepEqual(evidence.required, ["at", "note", "ref"]);
  assert.ok("ref" in evidence.properties);
});

test("a new database has drafts, link and upload memory, and each chat's context reading", () => {
  const db = new Database(join(dir(), "dojo.db"));
  assert.ok(db.get<{ user_version: number }>("PRAGMA user_version")!.user_version >= 5);
  for (const t of ["drafts", "link_cache", "upload_prints"]) assert.ok(db.get("SELECT 1 FROM sqlite_master WHERE name = ?", t), t);
  assert.ok(db.all<{ name: string }>("PRAGMA table_info(chats)").some((c) => c.name === "context"));
});

test("mixing takes each area from the style picked for it, and needs two different styles", () => {
  const d = dir();
  const db = new Database(join(d, "dojo.db"));
  const bus = new Bus();
  const team = new Team(db, bus);
  const styles = new Styles(db, bus, {} as never, new Jobs(db, bus), {} as never, {} as never);
  styles.access = new Access(db, team);
  const owner = team.ownerViewer();
  const area = (who: string) => ({ summary: `${who} area`, rules: [{ rule: `${who} rule`, evidence: [{ at: 1, note: "x" }], confidence: "high" }] });
  const card = (who: string) => JSON.stringify({ summary: who, structure: `${who} structure`, pacing: area(who), editing: area(who), audio: area(who), captions: area(who), positioning: area(who), motion: area(who), animation: area(who), effects: area(who), measurements: { who }, colors: [`#${who === "A" ? "aaaaaa" : "bbbbbb"}`] });
  for (const [id, who] of [["a", "A"], ["b", "B"]]) db.run("INSERT INTO styles (id, name, status, card, created_at, updated_at, owner_id) VALUES (?, ?, 'approved', ?, 0, 0, ?)", id, who, card(who), owner.id);
  const all = (v: string) => Object.fromEntries(["pacing", "editing", "audio", "captions", "positioning", "motion", "animation", "effects"].map((k) => [k, v]));
  assert.throws(() => styles.mix(owner, "Same", all("a")), /two different/);
  assert.throws(() => styles.mix(owner, "Half", { pacing: "a" }), /every area/);
  const mixed = styles.mix(owner, "A pace, B type", { ...all("a"), captions: "b", motion: "b" });
  const c = mixed.card as Record<string, { summary?: string; from?: string }> & { measurements: { who: string }; colors: string[]; mixedFrom: { styleId: string }[] };
  assert.equal(mixed.status, "draft");
  assert.equal(c.captions.summary, "B area");
  assert.equal(c.captions.from, "B");
  assert.equal(c.pacing.from, "A");
  assert.equal(c.measurements.who, "A", "pace numbers come from the pacing style");
  assert.deepEqual(c.colors, ["#bbbbbb"], "colours follow the motion style");
  assert.deepEqual(styles.family(mixed.id).ids, [mixed.id, "a", "b"]);
  assert.equal(styles.family(mixed.id).captions, "b");
});

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

// The file store lives in a throwaway home, set before any engine module reads it.
const home = mkdtempSync(join(tmpdir(), "dojo-refs-"));
process.env.DOJO_HOME = home;
const { Bus } = await import("../src/bus.ts");
const { Database } = await import("../src/db.ts");
const { Files } = await import("../src/files.ts");
const { Jobs } = await import("../src/jobs.ts");
const { Styles } = await import("../src/styles.ts");
const { Access } = await import("../src/team/access.ts");
const { Team } = await import("../src/team/team.ts");
const { References, autoLearnKey, describeReference, hamming, samePrint } = await import("../src/references.ts");
const { mkdirSync } = await import("node:fs");
const { DIRS } = await import("../src/config.ts");
import type { ChatRow } from "../src/claude/chat.ts";

for (const d of Object.values(DIRS)) mkdirSync(d, { recursive: true });

/** A short synthetic video. The same source at another size and quality is the same video in different bytes. */
function video(name: string, source: string, seconds: number, size = "320x180", crf = "28") {
  const out = join(home, name);
  execFileSync("ffmpeg", ["-loglevel", "error", "-y", "-f", "lavfi", "-i", `${source}=size=${size}:rate=25`, "-t", String(seconds), "-c:v", "libx264", "-crf", crf, "-pix_fmt", "yuv420p", out]);
  return out;
}

async function studio() {
  const db = new Database(join(mkdtempSync(join(tmpdir(), "dojo-refs-db-")), "dojo.db"));
  const bus = new Bus();
  const team = new Team(db, bus);
  const access = new Access(db, team);
  const files = new Files(db);
  const styles = new Styles(db, bus, files, new Jobs(db, bus), {} as never, {} as never);
  styles.access = access;
  const learned: { owner: string; hashes: string[]; tags: string[][]; origin?: { chatId: string } }[] = [];
  // Learning really runs Claude; here it only records the request, as a queued job would.
  styles.learn = (viewer, hashes, _account, _locale, tags = [], origin) => {
    learned.push({ owner: viewer.id, hashes, tags, origin });
    const id = randomUUID();
    db.run("INSERT INTO jobs (id, kind, status, priority, resource, payload, created_at, updated_at, owner_id) VALUES (?, 'style.analyze', 'queued', 6, 'claude', ?, ?, ?, ?)", id, JSON.stringify({ hashes, origin }), Date.now(), Date.now(), viewer.id);
    return id;
  };
  const owner = team.ownerViewer();
  const refs = new References(db, bus, files, styles, (chat) => chat.owner_id ?? owner.id);
  const chat = (ownerId = owner.id) => ({ id: randomUUID(), owner_id: ownerId, account_id: "default", mission: JSON.stringify({ locale: "en-US" }) }) as unknown as ChatRow;
  const style = (ownerId: string, hash: string, status = "draft") => {
    const id = randomUUID();
    db.run("INSERT INTO styles (id, name, status, card, source_hash, created_at, updated_at, owner_id) VALUES (?, ?, ?, '{}', ?, ?, ?, ?)", id, `Style ${id.slice(0, 4)}`, status, hash, Date.now(), Date.now(), ownerId);
    db.run("INSERT INTO style_sources (style_id, hash) VALUES (?, ?)", id, hash);
    return id;
  };
  return { db, files, styles, refs, owner, chat, style, learned };
}

const ORIGINAL = video("original.mp4", "testsrc2", 6);
const RECODED = video("recoded.mp4", "testsrc2", 6, "640x360", "18");
const OTHER = video("other.mp4", "mandelbrot", 6);
const SHORT = video("short.mp4", "testsrc2", 2);

test("frame hashes count differing bits, and a print matches only the same video", () => {
  assert.equal(hamming("0000000000000000", "0000000000000000"), 0);
  assert.equal(hamming("ffffffff00000000", "0000000000000000"), 32);
  assert.equal(hamming("0000000000000003", "0000000000000000"), 2);
  const a = { duration: 30, frames: Array(8).fill("00000000000000ff") };
  assert.equal(samePrint(a, { duration: 30.3, frames: Array(8).fill("00000000000000f0") }), true);
  assert.equal(samePrint(a, { duration: 40, frames: a.frames }), false, "a different length is a different video");
  assert.equal(samePrint(a, { duration: 30, frames: Array(8).fill("ffffffff00000000") }), false);
});

test("a reference the person already learned is reused, not learned again", async () => {
  const s = await studio();
  const f = await s.files.fromPath(ORIGINAL, "original.mp4");
  const id = s.style(s.owner.id, f.hash, "approved");
  const [state] = await s.refs.ensure(s.chat(), [{ hash: f.hash }]);
  assert.deepEqual({ ...state, styleName: undefined }, { hash: f.hash, state: "known", styleId: id, styleName: undefined, status: "approved", match: "exact" });
  assert.equal(s.learned.length, 0);
  assert.match(describeReference(state), /already in the library/);
});

test("the same video downloaded again matches its style, and is remembered as a source", async () => {
  const s = await studio();
  const a = await s.files.fromPath(ORIGINAL, "original.mp4");
  const b = await s.files.fromPath(RECODED, "recoded.mp4");
  assert.notEqual(a.hash, b.hash);
  const id = s.style(s.owner.id, a.hash);
  await s.refs.backfill();
  const [state] = await s.refs.ensure(s.chat(), [{ hash: b.hash }]);
  assert.equal(state.state, "known");
  assert.equal(state.state === "known" && state.match, "similar");
  assert.ok(s.db.get("SELECT 1 AS x FROM style_sources WHERE style_id = ? AND hash = ?", id, b.hash), "the copy now matches exactly next time");
  assert.equal(s.learned.length, 0);
});

test("a new reference is learned once, with its marks and the chat it came from", async () => {
  const s = await studio();
  const known = await s.files.fromPath(ORIGINAL, "original.mp4");
  s.style(s.owner.id, known.hash);
  await s.refs.backfill();
  const fresh = await s.files.fromPath(OTHER, "other.mp4");
  const chat = s.chat();
  const [first] = await s.refs.ensure(chat, [{ hash: fresh.hash, tags: ["motion", "not-a-tag"] }, { hash: fresh.hash }]);
  assert.equal(first.state, "learning");
  assert.equal(first.state === "learning" && first.started, true);
  assert.deepEqual(s.learned, [{ owner: s.owner.id, hashes: [fresh.hash], tags: [["motion"]], origin: { chatId: chat.id } }]);
  // Shared again while it's still learning, from any chat: the same job, never a second one.
  const [again] = await s.refs.ensure(s.chat(), [{ hash: fresh.hash }]);
  assert.equal(again.state === "learning" && again.started, false);
  assert.equal(s.learned.length, 1);
});

test("someone else's unshared style stays private, so the reference is learned for this person", async () => {
  const s = await studio();
  const editor = randomUUID();
  s.db.run("INSERT INTO members (id, name, role, webauthn_id, created_at) VALUES (?, 'Ed', 'editor', ?, ?)", editor, randomUUID(), Date.now());
  const f = await s.files.fromPath(ORIGINAL, "original.mp4");
  s.style(s.owner.id, f.hash, "approved");
  const [state] = await s.refs.ensure(s.chat(editor), [{ hash: f.hash }]);
  assert.equal(state.state, "learning");
  assert.equal(s.learned[0].owner, editor);
});

test("broken downloads and a switched-off setting are skipped with a reason", async () => {
  const s = await studio();
  const short = await s.files.fromPath(SHORT, "short.mp4");
  const [tiny] = await s.refs.ensure(s.chat(), [{ hash: short.hash }]);
  assert.equal(tiny.state, "skipped");
  assert.match(tiny.state === "skipped" ? tiny.reason : "", /broken download/);
  s.db.setSetting(autoLearnKey(s.owner.id), "off");
  const fresh = await s.files.fromPath(OTHER, "other.mp4");
  const [off] = await s.refs.ensure(s.chat(), [{ hash: fresh.hash }]);
  assert.equal(off.state, "skipped");
  assert.equal(s.learned.length, 0);
});

test("removing a style forgets its sources, so sharing the video again learns it afresh", async () => {
  const s = await studio();
  const f = await s.files.fromPath(ORIGINAL, "original.mp4");
  const id = s.style(s.owner.id, f.hash);
  s.db.run("DELETE FROM styles WHERE id = ?", id);
  assert.equal(s.db.get("SELECT 1 AS x FROM style_sources WHERE style_id = ?", id), undefined);
  const [state] = await s.refs.ensure(s.chat(), [{ hash: f.hash }]);
  assert.equal(state.state, "learning");
});

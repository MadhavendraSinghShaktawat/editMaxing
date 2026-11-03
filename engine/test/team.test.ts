import assert from "node:assert/strict";
import { generateKeyPairSync, createVerify, randomUUID } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import type { IncomingMessage } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Bus, reaches } from "../src/bus.ts";
import { Database } from "../src/db.ts";
import { DriveSync, nextOffset, parseServiceAccount, quoteQuery, signAssertion } from "../src/drivesync.ts";
import { Jobs } from "../src/jobs.ts";
import { Library } from "../src/library.ts";
import { LessonSchema, Memory } from "../src/memory.ts";
import type { Lesson } from "../src/memory.ts";
import { identify, sameOrigin } from "../src/routes.ts";
import { Access } from "../src/team/access.ts";
import { Team, hashToken, parseHubOrigin } from "../src/team/team.ts";
import type { Viewer } from "../src/team/team.ts";

const PORT = 51791;

/** A fresh studio in a temp folder, the way a first launch would make it. */
function studio() {
  const dir = mkdtempSync(join(tmpdir(), "dojo-team-"));
  const db = new Database(join(dir, "dojo.db"));
  const bus = new Bus();
  const team = new Team(db, bus);
  const access = new Access(db, team);
  const owner = team.ownerViewer();
  return { dir, db, bus, team, access, owner };
}

/** Adds a member directly, standing in for a finished passkey ceremony. */
function addMember(db: Database, role: "admin" | "editor", name: string = role): Viewer {
  const id = randomUUID();
  db.run("INSERT INTO members (id, name, role, webauthn_id, created_at) VALUES (?, ?, ?, ?, ?)", id, name, role, randomUUID(), Date.now());
  db.run("INSERT INTO libraries (id, owner_id, name, created_at) VALUES (?, ?, 'My B-roll', ?)", randomUUID(), id, Date.now());
  return { id, name, role, via: "session" };
}

function hub(s: ReturnType<typeof studio>, origin = "https://studio.example.com") {
  s.team.setMode(s.owner, "hub", { hubOrigin: origin });
}

function session(db: Database, memberId: string, token = randomUUID(), expires = Date.now() + 60_000) {
  db.run("INSERT INTO sessions (id, token_hash, member_id, created_at, last_seen_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)", randomUUID(), hashToken(token), memberId, Date.now(), Date.now(), expires);
  return token;
}

const req = (headers: Record<string, string>, method = "GET") => ({ headers, method }) as unknown as IncomingMessage;

// ── Studio and members ─────────────────────────────────────────

test("a new studio has exactly one Owner and a library for them", () => {
  const { db, owner } = studio();
  assert.equal(db.all("SELECT * FROM members").length, 1);
  assert.equal(owner.role, "owner");
  assert.equal(db.get<{ n: number }>("SELECT COUNT(*) n FROM libraries WHERE owner_id = ?", owner.id)!.n, 1);
  assert.throws(() => db.run("INSERT INTO members (id, name, role, webauthn_id, created_at) VALUES ('x', 'x', 'owner', 'w', 0)"), /UNIQUE/);
});

test("Hub addresses must be https names, or localhost for testing", () => {
  assert.equal(parseHubOrigin("https://studio.socialshifu.com").origin, "https://studio.socialshifu.com");
  assert.equal(parseHubOrigin("http://localhost:51791").hostname, "localhost");
  assert.throws(() => parseHubOrigin("http://studio.socialshifu.com"), /https/);
  assert.throws(() => parseHubOrigin("https://10.0.0.4"), /IP address/);
  assert.throws(() => parseHubOrigin("https://studio.socialshifu.com/app"), /nothing after/);
  assert.throws(() => parseHubOrigin("not a url"), /web address/);
});

test("only the Owner on this Mac can change the studio mode", () => {
  const s = studio();
  const editor = addMember(s.db, "editor");
  assert.throws(() => s.team.setMode(editor, "hub"), /Only the Owner/);
  assert.throws(() => s.team.setMode({ ...s.owner, via: "session" }, "hub"), /Mac app/);
  hub(s);
  assert.equal(s.team.mode, "hub");
  assert.ok(s.team.hosts().has("studio.example.com"));
});

test("a Hub with other people in it can only close through the 14-day wind-down", () => {
  const s = studio();
  hub(s);
  const editor = addMember(s.db, "editor");
  session(s.db, editor.id);
  assert.throws(() => s.team.setMode(s.owner, "single"), /14 days/);
  s.team.startClosing(s.owner);
  const at = s.team.closingAt!;
  assert.ok(at > Date.now() + 13 * 86_400_000);
  s.team.tick(at - 1000);
  assert.equal(s.team.mode, "hub");
  s.team.tick(at + 1);
  assert.equal(s.team.mode, "single");
  const m = s.team.member(editor.id);
  assert.equal(m.status, "archived");
  // Archived means access ended, not data deleted.
  assert.equal(s.db.get<{ n: number }>("SELECT COUNT(*) n FROM libraries WHERE owner_id = ?", editor.id)!.n, 1);
  assert.equal(s.db.get<{ n: number }>("SELECT COUNT(*) n FROM sessions WHERE member_id = ? AND revoked_at IS NULL", editor.id)!.n, 0);
});

test("invites need a Hub address, store only a hash, and work once", () => {
  const s = studio();
  assert.throws(() => s.team.invite(s.owner, "Ana", "editor"), /Studio Hub/);
  s.team.setMode(s.owner, "hub");
  assert.throws(() => s.team.invite(s.owner, "Ana", "editor"), /web address/);
  s.team.setHubOrigin(s.owner, "https://studio.example.com");
  const inv = s.team.invite(s.owner, "Ana", "editor");
  const token = inv.link.split("#join=")[1];
  assert.match(inv.link, /^https:\/\/studio\.example\.com\/#join=/);
  assert.equal(s.db.get("SELECT 1 FROM invites WHERE token_hash = ?", token), undefined);
  assert.ok(s.db.get("SELECT 1 FROM invites WHERE token_hash = ?", hashToken(token)));
  assert.equal(s.team.inviteInfo(token).name, "Ana");
  s.db.run("UPDATE invites SET used_at = ? WHERE id = ?", Date.now(), inv.id);
  assert.throws(() => s.team.inviteInfo(token), /already used/);
  const second = s.team.invite(s.owner, "Bo", "editor");
  s.team.revokeInvite(s.owner, second.id);
  assert.throws(() => s.team.inviteInfo(second.link.split("#join=")[1]), /isn't valid/);
  const third = s.team.invite(s.owner, "Cy", "editor");
  s.db.run("UPDATE invites SET expires_at = ? WHERE id = ?", Date.now() - 1, third.id);
  assert.throws(() => s.team.inviteInfo(third.link.split("#join=")[1]), /expired/);
});

test("only the Owner hands out admin rights", () => {
  const s = studio();
  hub(s);
  const adminV = addMember(s.db, "admin");
  const editor = addMember(s.db, "editor");
  assert.throws(() => s.team.invite(adminV, "X", "admin"), /Only the Owner/);
  assert.ok(s.team.invite(adminV, "X", "editor").link);
  assert.throws(() => s.team.invite(editor, "X", "editor"), /Only admins/);
  assert.throws(() => s.team.setRole(adminV, editor.id, "admin"), /Only the Owner/);
  s.team.setRole(s.owner, editor.id, "admin");
  assert.equal(s.team.member(editor.id).role, "admin");
  assert.throws(() => s.team.setRole(s.owner, s.owner.id, "editor"), /Owner's role/);
});

test("removing someone ends every session, passkey and share at once", () => {
  const s = studio();
  hub(s);
  const adminV = addMember(s.db, "admin");
  const editor = addMember(s.db, "editor");
  const token = session(s.db, editor.id);
  s.db.run("INSERT INTO passkeys (id, member_id, public_key, rp_id, created_at) VALUES ('pk', ?, x'00', 'studio.example.com', 0)", editor.id);
  const lib = s.db.get<{ id: string }>("SELECT id FROM libraries WHERE owner_id = ?", s.owner.id)!.id;
  s.access.setGrants(s.owner, "library", lib, [{ grantee: editor.id, permission: "use" }]);
  let closed = "";
  s.team.onRemoved = (id) => (closed = id);
  assert.ok(s.team.viewerFor(token));
  assert.throws(() => s.team.remove(editor, adminV.id), /Only admins/);
  assert.throws(() => s.team.remove(adminV, s.owner.id), /Owner can't/);
  s.team.remove(adminV, editor.id);
  assert.equal(s.team.viewerFor(token), null);
  assert.equal(s.db.get("SELECT 1 FROM passkeys WHERE member_id = ?", editor.id), undefined);
  assert.deepEqual(s.access.grants("library", lib), []);
  assert.equal(closed, editor.id);
  assert.ok(s.team.log().some((l) => l.action === "member.remove" && l.actorId === adminV.id));
});

test("sessions only work in Hub mode, until they expire or are revoked", () => {
  const s = studio();
  const editor = addMember(s.db, "editor");
  const token = session(s.db, editor.id);
  assert.equal(s.team.viewerFor(token), null);
  hub(s);
  assert.equal(s.team.viewerFor(token)?.id, editor.id);
  assert.equal(s.team.viewerFor("wrong"), null);
  const old = session(s.db, editor.id, randomUUID(), Date.now() - 1);
  assert.equal(s.team.viewerFor(old), null);
  const v = s.team.viewerFor(token)!;
  s.team.logout(v);
  assert.equal(s.team.viewerFor(token), null);
});

test("passkeys belong to the Hub's name, or localhost when testing", () => {
  const s = studio();
  hub(s);
  assert.deepEqual(s.team.siteFor("studio.example.com"), { rpID: "studio.example.com", origin: "https://studio.example.com" });
  assert.deepEqual(s.team.siteFor(`localhost:${PORT}`), { rpID: "localhost", origin: `http://localhost:${PORT}` });
  assert.throws(() => s.team.siteFor(`127.0.0.1:${PORT}`), /Hub's address/);
});

test("clients are made by admins and only show to the people on them", () => {
  const s = studio();
  hub(s);
  const editor = addMember(s.db, "editor");
  const other = addMember(s.db, "editor");
  assert.throws(() => s.team.createClient(editor, "Acme"), /Only admins/);
  const c = s.team.createClient(s.owner, "Acme");
  s.team.updateClient(s.owner, c.id, { members: [editor.id] });
  assert.deepEqual(s.team.clients(editor).map((x) => x.name), ["Acme"]);
  assert.deepEqual(s.team.clients(other), []);
  assert.equal(s.team.clients(s.owner).length, 1);
  assert.throws(() => s.team.updateClient(s.owner, c.id, { members: ["nobody"] }), /isn't in the studio/);
});

// ── Requests ───────────────────────────────────────────────────

test("the Mac app's token makes the Owner, and only on loopback", () => {
  const s = studio();
  const token = "local-token";
  assert.equal(identify(req({ host: `127.0.0.1:${PORT}`, authorization: `Bearer ${token}` }), token, s.team).viewer?.role, "owner");
  assert.equal(identify(req({ host: `127.0.0.1:${PORT}`, cookie: `dojo_session=${token}` }), token, s.team).viewer?.role, "owner");
  hub(s);
  assert.equal(identify(req({ host: "studio.example.com", cookie: `dojo_session=${token}` }), token, s.team).viewer, null);
  assert.equal(identify(req({ host: `127.0.0.1:${PORT}`, authorization: "Bearer nope" }), token, s.team).viewer, null);
});

test("a member's cookie works on the Hub's address with the secure name", () => {
  const s = studio();
  hub(s);
  const editor = addMember(s.db, "editor");
  const t = session(s.db, editor.id);
  assert.equal(identify(req({ host: "studio.example.com", cookie: `__Host-dojo_member=${t}` }), "x", s.team).viewer?.id, editor.id);
  assert.equal(identify(req({ host: "studio.example.com", cookie: `dojo_member=${t}` }), "x", s.team).viewer, null);
});

test("changes from other sites are refused", () => {
  const s = studio();
  hub(s);
  assert.ok(sameOrigin(req({ origin: "https://studio.example.com" }, "POST"), s.team));
  assert.ok(sameOrigin(req({ origin: `http://127.0.0.1:${PORT}` }, "POST"), s.team));
  assert.ok(!sameOrigin(req({ origin: "https://evil.example" }, "POST"), s.team));
  assert.ok(!sameOrigin(req({}, "POST"), s.team));
  assert.ok(sameOrigin(req({ "sec-fetch-site": "same-origin" }, "POST"), s.team));
  assert.ok(sameOrigin(req({ origin: "https://evil.example" }, "GET"), s.team));
});

test("events only reach the people they belong to", () => {
  const me = { memberId: "a", admin: false };
  const boss = { memberId: "b", admin: true };
  assert.ok(reaches(["a"], me));
  assert.ok(!reaches(["a"], boss));
  assert.ok(reaches("admins", boss));
  assert.ok(!reaches("admins", me));
  assert.ok(reaches("*", me));
});

// ── Sharing ────────────────────────────────────────────────────

test("libraries are private until their owner shares them", () => {
  const s = studio();
  const a = addMember(s.db, "editor", "A");
  const b = addMember(s.db, "editor", "B");
  const lib = s.db.get<{ id: string }>("SELECT id FROM libraries WHERE owner_id = ?", a.id)!.id;
  assert.ok(!s.access.can(b, "library", lib, "use"));
  assert.throws(() => s.access.setGrants(a, "library", lib, [{ grantee: b.id, permission: "use" }]), /Studio Hub/);
  hub(s);
  assert.throws(() => s.access.setGrants(b, "library", lib, []), /owner/);
  assert.throws(() => s.access.setGrants(a, "library", lib, [{ grantee: b.id, permission: "edit" }]), /use or add/);
  s.access.setGrants(a, "library", lib, [{ grantee: b.id, permission: "use" }]);
  assert.ok(s.access.can(b, "library", lib, "use"));
  assert.ok(!s.access.can(b, "library", lib, "add"));
  s.access.setGrants(a, "library", lib, [{ grantee: "team", permission: "add" }]);
  assert.ok(s.access.can(b, "library", lib, "add"));
  assert.ok(!s.access.can(b, "library", lib, "own"));
  // Admins don't get other people's libraries mixed into their own work.
  assert.ok(s.access.visible("library", s.owner).includes(lib));
  s.access.setGrants(a, "library", lib, []);
  assert.ok(!s.access.visible("library", s.owner).includes(lib));
});

// ── Library privacy ────────────────────────────────────────────

test("search, clips and shots stay inside the libraries someone can use", () => {
  const s = studio();
  hub(s);
  const a = addMember(s.db, "editor", "A");
  const b = addMember(s.db, "editor", "B");
  const jobs = new Jobs(s.db, s.bus);
  const library = new Library(s.db, s.bus, {} as never, jobs, {} as never, () => false);
  library.access = s.access;
  const libA = library.defaultLibrary(a.id);
  const libB = library.defaultLibrary(b.id);
  const clip = (name: string, lib: string) => {
    const id = randomUUID();
    s.db.run("INSERT INTO clips (id, file_hash, name, status, created_at) VALUES (?, ?, ?, 'ready', 0)", id, randomUUID(), name);
    s.db.run("INSERT INTO library_clips (library_id, clip_id, added_at) VALUES (?, ?, 0)", lib, id);
    return id;
  };
  const shot = (clipId: string, duplicateOf: string | null = null) => {
    const id = randomUUID();
    s.db.run("INSERT INTO shots (id, clip_id, t0, t1, duplicate_of, card, created_at) VALUES (?, ?, 0, 1, ?, ?, 0)", id, clipId, duplicateOf, duplicateOf ? null : JSON.stringify({ summary: "x" }));
    return id;
  };
  const ca = clip("a.mp4", libA);
  const cb = clip("b.mp4", libB);
  const sa = shot(ca);
  const sbDup = shot(cb, sa);
  assert.deepEqual(library.clips(a.id).map((c) => c.name), ["a.mp4"]);
  assert.deepEqual(library.clips(b.id).map((c) => c.name), ["b.mp4"]);
  assert.throws(() => library.mustSeeShot(b.id, sa), /No shot/);
  library.mustSeeShot(b.id, sbDup);
  // B's near-copy of A's shot borrows A's analysis without exposing A's shot.
  assert.equal(library.stats(b.id).analyzed, 1);
  assert.throws(() => library.clips(b.id, libA), /access/);
  library.share(a, libA, [{ grantee: b.id, permission: "use" }]);
  library.mustSeeShot(b.id, sa);
  assert.equal(library.clips(b.id).length, 2);
  assert.throws(() => library.enqueue(b, "hash", libA), /access/);
});

// ── Memory ─────────────────────────────────────────────────────

function memoryStudio() {
  const s = studio();
  const accounts = { session: () => null } as never;
  const memory = new Memory(s.db, s.bus, s.team, accounts, new Jobs(s.db, s.bus));
  return { ...s, memory };
}

const lesson = (over: Partial<Lesson> = {}): Lesson => ({ action: "new", ruleId: null, text: "Keep B-roll under two seconds in Reels", area: "broll", scope: "personal", durable: true, confidence: 0.7, evidence: [1], ...over });

test("a lesson starts as a suggestion and becomes a rule when it comes up again", () => {
  const { memory, owner } = memoryStudio();
  const ctx = { chatId: null, memberId: owner.id, clientId: null };
  assert.ok(memory.apply(lesson(), ["shorter b-roll"], ctx));
  const [rule] = memory.list(owner);
  assert.equal(rule.status, "suggested");
  assert.ok(!memory.apply(lesson(), ["again"], ctx), "the same new lesson twice is a duplicate");
  memory.apply(lesson({ action: "reinforce", ruleId: rule.id }), ["still too long"], ctx);
  assert.equal(memory.list(owner)[0].status, "active");
});

test("one-off fixes are never remembered", () => {
  const { memory, owner } = memoryStudio();
  assert.ok(!memory.apply(lesson({ durable: false, text: "Fix the typo at 0:32" }), ["typo"], { chatId: null, memberId: owner.id, clientId: null }));
  assert.equal(memory.list(owner).length, 0);
});

test("a contradiction replaces the old rule once it's confirmed", () => {
  const { memory, owner } = memoryStudio();
  const old = memory.add(owner, { text: "Use lots of zoom punch-ins", area: "editing" });
  memory.apply(lesson({ action: "contradict", ruleId: old.id, text: "No zoom punch-ins on faces", area: "editing" }), ["stop zooming"], { chatId: null, memberId: owner.id, clientId: null });
  const next = memory.list(owner).find((r) => r.status === "suggested")!;
  memory.confirm(owner, next.id, "personal");
  const all = memory.list(owner);
  assert.ok(all.some((r) => r.id === next.id && r.status === "active"));
  assert.ok(!all.some((r) => r.id === old.id), "the replaced rule leaves the list");
});

test("a rule the editor keeps missing is flagged for review", () => {
  const { memory, owner } = memoryStudio();
  const r = memory.add(owner, { text: "Captions stay in the lower third", area: "captions" });
  const ctx = { chatId: null, memberId: owner.id, clientId: null };
  for (let i = 0; i < 4; i++) memory.apply(lesson({ action: "violated", ruleId: r.id, area: "captions" }), ["captions too high again"], ctx);
  assert.equal(memory.list(owner).find((x) => x.id === r.id)!.status, "needs_review");
});

test("personal memory is private, client memory follows the client, team memory is for admins to write", () => {
  const s = memoryStudio();
  hub(s);
  const ana = addMember(s.db, "editor", "Ana");
  const bo = addMember(s.db, "editor", "Bo");
  const client = s.team.createClient(s.owner, "Acme");
  s.team.updateClient(s.owner, client.id, { members: [ana.id] });
  s.memory.add(ana, { text: "Ana likes slow fades between sections", area: "effects" });
  s.memory.add(ana, { text: "Acme never uses stock people shots", area: "broll", scope: "client", clientId: client.id });
  assert.throws(() => s.memory.add(bo, { text: "Acme loves neon", scope: "client", clientId: client.id }), /don't work on/);
  assert.throws(() => s.memory.add(ana, { text: "Always export at 1080 by 1920", scope: "team" }), /Only admins/);
  s.memory.add(s.owner, { text: "Always export at 1080 by 1920", area: "general", scope: "team" });
  assert.equal(s.memory.list(ana).length, 3);
  assert.deepEqual(s.memory.list(bo).map((r) => r.scope), ["team"]);
  const forAcme = s.memory.forChat({ owner_id: bo.id, client_id: client.id });
  assert.deepEqual(forAcme.map((r) => r.scope).sort(), ["client", "team"]);
});

test("the most specific level wins when two levels say the same thing", () => {
  const s = memoryStudio();
  hub(s);
  s.memory.add(s.owner, { text: "Keep captions in the lower third of the frame", area: "captions", scope: "team" });
  s.memory.add(s.owner, { text: "Keep captions in the lower third, above the chin", area: "captions" });
  const rules = s.memory.forChat({ owner_id: s.owner.id, client_id: null });
  assert.equal(rules.length, 1);
  assert.equal(rules[0].scope, "personal");
});

test("rules several people learned on their own are offered to admins as team rules", () => {
  const s = memoryStudio();
  hub(s);
  for (const name of ["A", "B", "C"]) s.memory.add(addMember(s.db, "editor", name), { text: "Duck the music under speech", area: "audio" });
  const [suggestion] = s.memory.teamSuggestions();
  assert.equal(suggestion.people, 3);
});

test("the learning answer must match its schema exactly", () => {
  assert.ok(LessonSchema.safeParse({ lessons: [lesson()] }).success);
  assert.ok(!LessonSchema.safeParse({ lessons: [{ ...lesson(), area: "colour" }] }).success);
  assert.ok(!LessonSchema.safeParse({ lessons: [{ ...lesson(), evidence: [] }] }).success);
});

// ── Drive ──────────────────────────────────────────────────────

const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const keyFile = { type: "service_account", client_email: "dojo@project.iam.gserviceaccount.com", private_key: privateKey.export({ type: "pkcs8", format: "pem" }).toString(), token_uri: "https://oauth2.googleapis.com/token" };

test("service account keys are checked and signed the way Google expects", () => {
  assert.throws(() => parseServiceAccount("{}"), /service account/);
  assert.throws(() => parseServiceAccount("nope"), /JSON key/);
  const sa = parseServiceAccount(JSON.stringify(keyFile));
  const jwt = signAssertion(sa, 1000);
  const [head, claims, sig] = jwt.split(".");
  const verify = createVerify("RSA-SHA256");
  verify.update(`${head}.${claims}`);
  assert.ok(verify.verify(publicKey, Buffer.from(sig, "base64url")));
  const c = JSON.parse(Buffer.from(claims, "base64url").toString());
  assert.equal(c.iss, keyFile.client_email);
  assert.equal(c.exp - c.iat, 3600);
  assert.equal(c.scope, "https://www.googleapis.com/auth/drive");
});

test("resumable uploads carry on from where Drive says it stopped", async () => {
  const s = studio();
  const drive = new DriveSync(s.db, s.bus, {} as never, new Jobs(s.db, s.bus), s.team);
  const path = join(s.dir, "clip.mp4");
  writeFileSync(path, Buffer.alloc(40 * 1024 * 1024, 1));
  const ranges: string[] = [];
  let token = 0;
  drive.fetcher = (async (url: string, init: RequestInit & { headers: Record<string, string> }) => {
    if (url.includes("oauth2")) return (token++, new Response(JSON.stringify({ access_token: "t", expires_in: 3600 })));
    if (url.includes("uploadType=resumable")) {
      assert.equal(init.headers["X-Upload-Content-Length"], String(40 * 1024 * 1024));
      assert.ok(url.includes("supportsAllDrives=true"));
      return new Response(null, { status: 200, headers: { location: "https://upload.example/session" } });
    }
    const range = init.headers["Content-Range"] ?? "";
    ranges.push(range);
    const end = Number(range.match(/-(\d+)\//)![1]);
    if (end + 1 >= 40 * 1024 * 1024) return new Response(JSON.stringify({ id: "file1" }), { status: 200 });
    return new Response(null, { status: 308, headers: { range: `bytes=0-${end}` } });
  }) as never;
  // The key would normally come from the Keychain.
  (drive as unknown as { account: () => unknown }).account = async () => parseServiceAccount(JSON.stringify(keyFile));
  const id = await drive.upload(path, "clip.mp4", "folder", { signal: new AbortController().signal });
  assert.equal(id, "file1");
  assert.deepEqual(ranges, ["bytes 0-16777215/41943040", "bytes 16777216-33554431/41943040", "bytes 33554432-41943039/41943040"]);
  assert.equal(token, 1);
  assert.equal(nextOffset("bytes=0-99"), 100);
  assert.equal(nextOffset(null), 0);
  assert.equal(quoteQuery("it's"), "'it\\'s'");
});

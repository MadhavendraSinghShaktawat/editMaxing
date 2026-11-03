import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Bus } from "../src/bus.ts";
import { Database } from "../src/db.ts";
import { secrets } from "../src/lib/secrets.ts";
import { BROLL_ROLES, meaningText, validCard } from "../src/library.ts";
import type { Card } from "../src/library.ts";
import { DOMAINS, MotionLibrary, OPERATIONS, SEED_TECHNIQUES, captionOp, diverse, harvestSchema, matchTerm, motionText, verifyHarvest } from "../src/motionlib.ts";
import { Access } from "../src/team/access.ts";
import { Team } from "../src/team/team.ts";
import type { Viewer } from "../src/team/team.ts";

// Tests never reach the Keychain or a paid API.
secrets.get = async () => null;
secrets.has = async () => false;

function studio() {
  const dir = mkdtempSync(join(tmpdir(), "dojo-motion-"));
  const db = new Database(join(dir, "dojo.db"));
  const bus = new Bus();
  const team = new Team(db, bus);
  const access = new Access(db, team);
  const motion = new MotionLibrary(db, bus, {} as never);
  motion.access = access;
  return { dir, db, bus, team, access, motion, owner: team.ownerViewer() };
}

function addMember(db: Database, role: "admin" | "editor", name: string = role): Viewer {
  const id = randomUUID();
  db.run("INSERT INTO members (id, name, role, webauthn_id, created_at) VALUES (?, ?, ?, ?, ?)", id, name, role, randomUUID(), Date.now());
  return { id, name, role, via: "session" };
}

/** An item as a harvest would save it, without cutting real video. */
function item(s: ReturnType<typeof studio>, owner: string, v: { name: string; operation?: string; technique?: string; kind?: string; summary?: string; goodFor?: string[]; styleId?: string | null }) {
  const id = randomUUID();
  const card = { name: v.name, summary: v.summary ?? v.name, meanings: [], goodFor: v.goodFor ?? [], spec: { layer: "overlay", rebuild: ["Do it"] } };
  const text = motionText(card, [v.operation ?? "", v.technique ?? ""]);
  s.db.run("INSERT INTO motion_items (id, owner_id, style_id, kind, name, summary, operation_id, technique_id, t0, t1, card, meaning, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, 2, ?, ?, ?, ?)", id, owner, v.styleId ?? null, v.kind ?? "animation", v.name, card.summary, v.operation ?? null, v.technique ?? null, JSON.stringify(card), text, Date.now(), Date.now());
  s.db.run("INSERT INTO motion_fts (item_id, meaning) VALUES (?, ?)", id, text);
  return id;
}

// ── Taxonomy ───────────────────────────────────────────────────

test("the seed taxonomy is there from the first start, and starting again adds nothing twice", () => {
  const s = studio();
  new MotionLibrary(s.db, s.bus, {} as never);
  const t = s.motion.taxonomy(s.owner.id);
  assert.equal(t.operations.length, OPERATIONS.length);
  assert.equal(t.domains.length, DOMAINS.length);
  assert.equal(t.techniques.length, SEED_TECHNIQUES.length);
  assert.equal(t.proposals.length, 0);
  assert.ok(SEED_TECHNIQUES.every((x) => DOMAINS.some((d) => d.id === x.domain)), "every technique belongs to a real domain");
});

test("a new technique under another spelling matches the one that exists", () => {
  const terms = SEED_TECHNIQUES;
  assert.equal(matchTerm("Word-pop", terms), "word_pop");
  assert.equal(matchTerm("word pops", terms), "word_pop");
  assert.equal(matchTerm("Split-screen", terms), "split_screen");
  assert.equal(matchTerm("Behind subject plates", terms), "behind_subject");
  assert.equal(matchTerm("Specimen poster reveal", terms), null);
});

test("Claude can only pick known operations and domains, and techniques are listed for it", () => {
  const schema = harvestSchema(["word_pop", "push_in"]) as { properties: { animations: { items: { properties: Record<string, { enum?: string[]; description?: string }> } } } };
  const props = schema.properties.animations.items.properties;
  assert.deepEqual(props.operation.enum, OPERATIONS.map((o) => o.id));
  assert.deepEqual(props.domain.enum, DOMAINS.map((d) => d.id));
  assert.match(props.technique.description!, /word_pop, push_in/);
});

test("proposals wait for an admin, who can approve them or fold them into a known technique", () => {
  const s = studio();
  const editor = addMember(s.db, "editor");
  s.db.run("INSERT INTO motion_terms (id, level, label, description, domain_id, status, origin, proposed_by, created_at) VALUES ('specimen_reveal', 'technique', 'Specimen reveal', '', 'depth', 'proposed', 'claude', ?, ?)", s.owner.id, Date.now());
  s.db.run("INSERT INTO motion_terms (id, level, label, description, domain_id, status, origin, proposed_by, created_at) VALUES ('pop_word', 'technique', 'Pop word', '', 'type', 'proposed', 'claude', ?, ?)", s.owner.id, Date.now());
  const a = item(s, s.owner.id, { name: "Word punch", operation: "emphasize", technique: "pop_word" });
  assert.equal(s.motion.taxonomy(s.owner.id).proposals.length, 2);
  assert.throws(() => s.motion.approveTerm(editor, "specimen_reveal"), /Only admins/);
  s.motion.approveTerm(s.owner, "specimen_reveal");
  s.motion.mergeTerm(s.owner, "pop_word", "word_pop");
  const t = s.motion.taxonomy(s.owner.id);
  assert.equal(t.proposals.length, 0);
  assert.ok(t.techniques.some((x) => x.id === "specimen_reveal"));
  assert.equal(s.motion.view(s.owner.id, a).technique?.id, "word_pop");
  assert.throws(() => s.motion.mergeTerm(s.owner, "word_pop", "push_in"), /proposal/);
});

// ── Harvest checks ─────────────────────────────────────────────

const spec = { layer: "overlay", seconds: 1, easing: "snappy", enter: "", hold: "", exit: "", stagger: "", sync: "", elements: [], colors: [], typography: "", camera: "", rebuild: ["Step"] };
const anim = (t0: number, t1: number, extra = {}) => ({ name: "Pop", summary: "s", at: { t0, t1 }, operation: "emphasize", technique: "word_pop", domain: "type", meanings: [], goodFor: [], spec, confidence: "high", ...extra });

test("an animation is kept only when a frame sequence shows it", () => {
  const sequences = [{ t0: 10, t1: 11 }];
  const { kept, rejected } = verifyHarvest({ animations: [anim(10.1, 10.8), anim(30, 31), anim(10, 10.05)] as never, thumbnail: { at: 5, why: "" }, captionSample: { at: -1 } }, { duration: 60, sequences, stills: [5, 20] });
  assert.equal(kept.length, 1);
  assert.match(rejected[0].reason, /No frame sequence/);
  assert.match(rejected[1].reason, /time span/);
});

test("an animation with a made-up operation or no rebuild steps is dropped, and long spans are trimmed", () => {
  const sequences = [{ t0: 0, t1: 20 }];
  const { kept, rejected } = verifyHarvest({ animations: [anim(1, 2, { operation: "dazzle" }), anim(1, 2, { spec: { ...spec, rebuild: [] } }), anim(2, 19)] as never, thumbnail: { at: 3, why: "" }, captionSample: { at: 3 } }, { duration: 20, sequences, stills: [3] });
  assert.equal(rejected.length, 2);
  assert.equal(kept[0].at.t1, 10);
});

test("the thumbnail and caption frames must be ones Claude was shown", () => {
  const r = verifyHarvest({ animations: [], thumbnail: { at: 44, why: "" }, captionSample: { at: 44 } }, { duration: 60, sequences: [{ t0: 10, t1: 11 }], stills: [0.5, 3, 20] });
  assert.equal(r.thumbnailAt, 3);
  assert.equal(r.captionAt, null);
  const ok = verifyHarvest({ animations: [], thumbnail: { at: 20.3, why: "" }, captionSample: { at: 10.5 } }, { duration: 60, sequences: [{ t0: 10, t1: 11 }], stills: [0.5, 3, 20] });
  assert.equal(ok.thumbnailAt, 20.3);
  assert.equal(ok.captionAt, 10.5);
});

test("a caption preset becomes a set_captions op with only valid, measured fields", () => {
  assert.deepEqual(captionOp({ present: true, maxWords: 5.4, uppercase: false, suggestedFont: "New York", color: "#F4E27A", highlight: "yellow", position: 0.48, animation: "custom", reveal: "chunk", strokeWidth: 0 }), {
    op: "set_captions", enabled: true, maxWords: 5, uppercase: false, font: "New York", color: "#F4E27A", position: 0.48, reveal: "chunk", strokeWidth: 0,
  });
  assert.equal(captionOp(undefined), null);
});

test("options keep each technique once, and only repeat when there aren't enough", () => {
  const ranked = [{ id: "a", technique: "pop" }, { id: "b", technique: "pop" }, { id: "c", technique: "push" }, { id: "d", technique: "split" }];
  assert.deepEqual(diverse(ranked, 3).map((r) => r.id), ["a", "c", "d"]);
  assert.deepEqual(diverse(ranked, 4).map((r) => r.id), ["a", "c", "d", "b"]);
});

// ── Library, sharing and suggestions ───────────────────────────

test("saved animations are private until their owner shares them, like styles", () => {
  const s = studio();
  s.team.setMode(s.owner, "hub", { hubOrigin: "https://studio.example.com" });
  const ana = addMember(s.db, "editor", "Ana");
  const bo = addMember(s.db, "editor", "Bo");
  const id = item(s, ana.id, { name: "Split reveal", operation: "compare", technique: "split_screen" });
  assert.equal(s.motion.list(bo.id).length, 0);
  assert.throws(() => s.motion.mustUse(bo.id, id), /No saved animation/);
  assert.throws(() => s.motion.share(bo, id, [{ grantee: "team", permission: "use" }]), /owner/);
  s.motion.share(ana, id, [{ grantee: bo.id, permission: "use" }]);
  assert.equal(s.motion.list(bo.id)[0].access, "use");
  assert.throws(() => s.motion.rename(bo, id, "Mine now"), /access/);
  assert.throws(() => s.motion.remove(bo, id), /owner/);
  s.motion.share(ana, id, [{ grantee: bo.id, permission: "edit" }]);
  assert.equal(s.motion.rename(bo, id, "Split screen reveal").name, "Split screen reveal");
  assert.throws(() => s.motion.share(ana, id, [{ grantee: bo.id, permission: "add" }]), /use or edit/);
});

test("an admin can remove a member's item, and it's logged", () => {
  const s = studio();
  s.team.setMode(s.owner, "hub", { hubOrigin: "https://studio.example.com" });
  const ana = addMember(s.db, "editor", "Ana");
  const id = item(s, ana.id, { name: "Card build" });
  s.motion.remove(s.owner, id, true);
  assert.equal(s.motion.ownedBy(ana.id).length, 0);
  assert.ok(s.db.get("SELECT 1 FROM audit_log WHERE action = 'motion.remove' AND target_id = ?", id));
});

test("suggestions match the job, favour the chat's style and give different techniques", async () => {
  const s = studio();
  const style = randomUUID();
  s.db.run("INSERT INTO styles (id, name, status, card, created_at, updated_at, owner_id) VALUES (?, 'Iris', 'approved', '{}', 0, 0, ?)", style, s.owner.id);
  item(s, s.owner.id, { name: "Number counts up", operation: "emphasize", technique: "counter_tick", summary: "A big number counts up to its value", goodFor: ["revenue went up three times"] });
  item(s, s.owner.id, { name: "Number pops", operation: "emphasize", technique: "counter_tick", summary: "A number snaps in big", goodFor: ["the number went up"], styleId: style });
  item(s, s.owner.id, { name: "Word pop", operation: "emphasize", technique: "word_pop", summary: "The key word grows", goodFor: ["revenue up"] });
  item(s, s.owner.id, { name: "Push in", operation: "emphasize", technique: "push_in", summary: "Slow push toward the face" });
  item(s, s.owner.id, { name: "Side by side", operation: "compare", technique: "split_screen", summary: "Two options next to each other" });
  const out = await s.motion.suggest(s.owner.id, { job: "make the revenue number land", line: "revenue went up three times", operation: "emphasize", styleId: style, count: 3 });
  assert.equal(out.length, 3);
  assert.equal(new Set(out.map((o) => o.technique)).size, 3, "each option is a different technique");
  assert.equal(out[0].name, "Number pops", "the chat's own style comes first among equals");
  assert.ok(!out.some((o) => o.name === "Side by side"), "the operation filter holds");
});

test("past picks lift an animation for similar lines", async () => {
  const s = studio();
  const a = item(s, s.owner.id, { name: "Slow push", operation: "emphasize", technique: "push_in", summary: "A slow push in" });
  const b = item(s, s.owner.id, { name: "Hard punch", operation: "emphasize", technique: "punch_in", summary: "A sudden punch in" });
  for (let i = 0; i < 3; i++) {
    s.motion.logChoice(s.owner.id, "this is the moment everything changed", b, true, null);
    s.motion.logChoice(s.owner.id, "this is the moment everything changed", a, false, null);
  }
  const out = await s.motion.suggest(s.owner.id, { job: "land the turning point", line: "the moment everything changed", count: 3 });
  assert.equal(out[0].id, b);
});

test("each style shows its saved thumbnail", () => {
  const s = studio();
  const style = randomUUID();
  s.db.run("INSERT INTO styles (id, name, status, card, created_at, updated_at, owner_id) VALUES (?, 'Iris', 'approved', '{}', 0, 0, ?)", style, s.owner.id);
  const thumb = item(s, s.owner.id, { name: "Iris thumbnail", kind: "thumbnail", styleId: style });
  assert.equal(s.motion.thumbnails([style]).get(style), thumb);
  // Deleting the style keeps its saved items in the person's library.
  s.db.run("DELETE FROM styles WHERE id = ?", style);
  assert.equal(s.motion.view(s.owner.id, thumb).styleId, null);
});

test("version 3 rebuilt sharing for motion and cleared old edit modes", () => {
  const s = studio();
  assert.equal(s.db.get<{ user_version: number }>("PRAGMA user_version")!.user_version, 3);
  s.db.run("INSERT INTO shares (resource_type, resource_id, grantee, permission, created_at) VALUES ('motion', 'x', 'team', 'use', 0)");
  assert.throws(() => s.db.run("INSERT INTO shares (resource_type, resource_id, grantee, permission, created_at) VALUES ('nope', 'x', 'team', 'use', 0)"), /CHECK/);
});

// ── B-roll roles ───────────────────────────────────────────────

test("B-roll cards say what a shot does, and old cards without a role still work", () => {
  const base: Card = { id: "1", summary: "A laptop screen shows a sales dashboard climbing", subject: "dashboard", action: "numbers climb", objects: ["laptop"], setting: "office", lighting: "soft", camera: "close-up, static", people: "none", mood: ["focused"], meanings: ["growth", "results", "proof"], goodFor: ["our sales doubled"], avoid: [], visibleText: "", category: ["Work", "Screens"] };
  assert.ok(validCard(base), "a card from before roles is still valid");
  assert.ok(!meaningText(base).includes("Role"));
  assert.match(meaningText({ ...base, role: "proof", layouts: ["split_half"] }), /Role: proof/);
  assert.deepEqual([...BROLL_ROLES], ["literal", "proof", "metaphor", "contrast", "list", "texture"]);
});

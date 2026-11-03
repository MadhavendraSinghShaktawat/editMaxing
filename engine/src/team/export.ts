import { randomUUID } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DIRS } from "../config.ts";
import type { Database } from "../db.ts";
import { json } from "../db.ts";
import { run } from "../lib/proc.ts";

const safeName = (s: string) => s.replace(/[^\w.\- ]+/g, "_").slice(0, 60) || "untitled";

/**
 * Packs one person's work into a zip: chats with their messages and finished files, memory,
 * styles, prompt recipes and the list of their B-roll. Raw footage stays out because it can be
 * huge and the person already has it. Returns the zip path; the caller deletes it after sending.
 */
export async function exportMember(db: Database, memberId: string) {
  const member = db.get<{ id: string; name: string; role: string; created_at: number }>("SELECT id, name, role, created_at FROM members WHERE id = ?", memberId);
  if (!member) throw new Error("That person isn't in this studio.");
  const root = join(DIRS.tmp, `export-${randomUUID()}`);
  const dir = join(root, `Shifu Dojo - ${safeName(member.name)}`);
  mkdirSync(dir, { recursive: true });
  try {
    const chats = db.all<{ id: string; name: string; mission: string | null; cwd: string; created_at: number; ended_at: number | null }>("SELECT id, name, mission, cwd, created_at, ended_at FROM chats WHERE owner_id = ? ORDER BY created_at", memberId);
    const chatOut = chats.map((c) => {
      const title = json<{ title?: string }>(c.mission, {}).title ?? c.name;
      const folder = `${new Date(c.created_at).toISOString().slice(0, 10)} ${safeName(title)} ${c.id.slice(0, 6)}`;
      const out = join(c.cwd, "out");
      if (existsSync(out) && readdirSync(out).length) cpSync(out, join(dir, "chats", folder, "files"), { recursive: true, dereference: true });
      const messages = db.all<{ role: string; kind: string; text: string; created_at: number }>("SELECT role, kind, text, created_at FROM messages WHERE chat_id = ? ORDER BY id", c.id);
      mkdirSync(join(dir, "chats", folder), { recursive: true });
      writeFileSync(join(dir, "chats", folder, "chat.json"), JSON.stringify({ title, editor: c.name, startedAt: c.created_at, endedAt: c.ended_at, brief: json(c.mission, {}), messages }, null, 2));
      return { id: c.id, title, folder };
    });
    const data = {
      exportedAt: Date.now(),
      member: { name: member.name, role: member.role, joinedAt: member.created_at },
      chats: chatOut,
      memory: db.all("SELECT text, area, scope, status, created_at FROM memory_rules WHERE scope = 'personal' AND owner_id = ? AND status NOT IN ('removed', 'superseded')", memberId),
      styles: db.all<{ name: string; card: string; status: string }>("SELECT name, card, status FROM styles WHERE owner_id = ?", memberId).map((s) => ({ ...s, card: json(s.card, {}) })),
      // Names and rebuild specs only. The loops are cut from someone's reference, so they stay on the Mac.
      motion: db.all<{ kind: string; name: string; summary: string; operation_id: string | null; technique_id: string | null; card: string }>("SELECT kind, name, summary, operation_id, technique_id, card FROM motion_items WHERE owner_id = ? ORDER BY created_at", memberId).map((m) => ({ ...m, card: json(m.card, {}) })),
      recipes: db.all("SELECT title, text FROM recipes WHERE owner_id = ?", memberId),
      libraries: db.all<{ id: string; name: string }>("SELECT id, name FROM libraries WHERE owner_id = ? AND removed_at IS NULL", memberId).map((l) => ({
        name: l.name,
        clips: db.all("SELECT c.name, c.duration, c.source, c.rights FROM library_clips lc JOIN clips c ON c.id = lc.clip_id WHERE lc.library_id = ?", l.id),
      })),
    };
    writeFileSync(join(dir, "shifu-dojo-export.json"), JSON.stringify(data, null, 2));
    const zip = join(DIRS.tmp, `export-${randomUUID()}.zip`);
    await run("/usr/bin/ditto", ["-c", "-k", "--keepParent", dir, zip]);
    return { zip, name: `${safeName(member.name)} - Shifu Dojo export.zip` };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

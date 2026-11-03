import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Bus } from "../src/bus.ts";
import { Chats } from "../src/claude/chat.ts";
import { Database } from "../src/db.ts";

/** The engine's view of a parent chat, without a Claude process. */
function studio() {
  const db = new Database(join(mkdtempSync(join(tmpdir(), "dojo-spawn-")), "dojo.db"));
  db.run("INSERT INTO members (id, name, role, webauthn_id, created_at) VALUES ('m1', 'Ana', 'editor', 'w', 0)");
  db.run("INSERT INTO accounts (id, label, created_at, owner_id) VALUES ('a1', 'Mac', 0, 'm1')");
  db.run("INSERT INTO chats (id, name, look, account_id, model, cwd, mission, status, session_id, created_at, updated_at, owner_id) VALUES ('kai', 'Kai', 0, 'a1', 'opus', '/tmp/kai', '{}', 'working', 's1', 0, 0, 'm1')");
  const chats = new Chats(db, new Bus(), { noteRateLimit() {} } as never, { mcp: async () => ({}), prompt: () => "" } as never);
  const rt = { q: {} as never, input: {} as never, idle: null, allowed: new Set<string>(), motion: new Set<string>(), spawning: true, compaction: null, children: new Map<string, string>() };
  const feed = (m: unknown) => (chats as unknown as { handle: (id: string, m: unknown, draft: string, rt: unknown) => string }).handle("kai", m, "", rt);
  return { db, chats, feed };
}

test("an agent a chat starts gets its own chat showing what it does, linked back to the starting chat", () => {
  const s = studio();
  s.feed({ type: "system", subtype: "task_started", task_id: "t1", tool_use_id: "tu1", description: "Build motion/briefs/ab12/brief.md", subagent_type: "motion" });
  const child = s.db.get<{ id: string; name: string; parent_id: string; status: string }>("SELECT id, name, parent_id, status FROM chats WHERE parent_id = 'kai'")!;
  assert.equal(child.name, "Motion agent");
  assert.equal(child.status, "working");
  const started = s.db.get<{ data: string }>("SELECT data FROM messages WHERE chat_id = 'kai' AND kind = 'tool'")!;
  assert.equal(JSON.parse(started.data).childId, child.id, "the starting chat links to the agent's chat");

  s.feed({ type: "assistant", parent_tool_use_id: "tu1", message: { content: [{ type: "tool_use", name: "Bash", input: { command: "node render.js", description: "Render the chain explainer" } }] } });
  s.feed({ type: "assistant", parent_tool_use_id: "tu1", message: { content: [{ type: "text", text: "The clip is at motion/out/ab12.mp4." }] } });
  s.feed({ type: "system", subtype: "task_progress", task_id: "t1", description: "Running", summary: "Checking stills" });
  const lines = s.db.all<{ kind: string; text: string }>("SELECT kind, text FROM messages WHERE chat_id = ? ORDER BY id", child.id);
  assert.deepEqual(lines.map((l) => l.text).slice(1), ["Render the chain explainer", "The clip is at motion/out/ab12.mp4."]);
  assert.equal(s.db.get<{ detail: string }>("SELECT detail FROM chats WHERE id = ?", child.id)!.detail, "Checking stills");
  assert.equal(s.db.all("SELECT 1 FROM messages WHERE chat_id = 'kai' AND text = 'The clip is at motion/out/ab12.mp4.'").length, 0, "the agent's work stays out of the starting chat");

  s.feed({ type: "system", subtype: "task_notification", task_id: "t1", tool_use_id: "tu1", status: "completed", summary: "Done: ab12.mp4, 4.2s", output_file: "x" });
  const done = s.db.get<{ status: string; detail: string }>("SELECT status, detail FROM chats WHERE id = ?", child.id)!;
  assert.deepEqual([done.status, done.detail], ["idle", "Finished"]);
});

test("ending the starting chat ends its agents' chats, and agents don't use up a studio seat", () => {
  const s = studio();
  s.feed({ type: "system", subtype: "task_started", task_id: "t1", tool_use_id: "tu1", description: "x", subagent_type: "motion" });
  s.chats.end("kai");
  assert.equal(s.db.get<{ n: number }>("SELECT COUNT(*) n FROM chats WHERE ended_at IS NULL")!.n, 0);
});

test("after a restart, an agent's chat says it stopped instead of showing as working forever", () => {
  const s = studio();
  s.feed({ type: "system", subtype: "task_started", task_id: "t1", tool_use_id: "tu1", description: "x", subagent_type: "motion" });
  new Chats(s.db, new Bus(), { noteRateLimit() {} } as never, { mcp: async () => ({}), prompt: () => "" } as never);
  const child = s.db.get<{ status: string; detail: string }>("SELECT status, detail FROM chats WHERE parent_id = 'kai'")!;
  assert.deepEqual([child.status, child.detail], ["idle", "Stopped when Shifu Dojo restarted"]);
});
